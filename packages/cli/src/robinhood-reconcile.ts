import type { AttemptRecord, ReceiptRecord, ReconciliationUpdate, RunRecord } from '@mint-bot/backend';

/**
 * Reconciliation for chain 4663 (T-035 piece 2). Pure: the caller supplies the receipt reader and the finality observer.
 *
 * A Robinhood run is final only when the receipt is canonical and its L1 data is Ethereum-final (D-040 item 4). The amount
 * to settle is the OBSERVED cost: mint value (successful mints only) plus gas used times the effective gas price. On this
 * chain `gasUsed` already contains the L1 data gas (`gasUsedForL1`), so the L1 data fee is part of the observed amount and
 * is never estimated. If the receipt does not report `gasUsedForL1`, the cost is not proven and nothing settles.
 * The coordinator still refuses a settlement above the reservation.
 */
export interface ObservedReceipt {
  status: 'success' | 'reverted';
  blockNumber: bigint;
  blockHash: string;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  /** Gas units of `gasUsed` that paid for L1 data. Missing means the receipt did not prove the L1 part. */
  gasUsedForL1?: bigint;
}

export interface ObservedFinality {
  stage: 'soft' | 'posted' | 'ethereum_final';
  /** null: canonicality could not be proven. */
  canonical: boolean | null;
  ready: boolean;
}

export interface RobinhoodReconcileInput {
  run: RunRecord;
  attempts: readonly AttemptRecord[];
  /** Mint price in wei per NFT and quantity from the intent snapshot. */
  mintPriceWei: bigint;
  quantity: number;
  readReceipt(hash: string): Promise<ObservedReceipt | null>;
  observe(input: { txHash: string; txBlockNumber: bigint }): Promise<ObservedFinality>;
  now?: () => Date;
}

const unknown = (attempts: AttemptRecord[], receipts: ReceiptRecord[], reason: string): ReconciliationUpdate => ({ result: 'unknown', attempts, receipts, reason });

/**
 * Lifecycle persistence records both the signed transaction and provider
 * responses. Those records can describe the same canonical transaction, so
 * reconciliation observes it once and prefers the provider-facing attempt as
 * the receipt linkage.
 */
export function uniqueSubmittedAttempts(attempts: readonly AttemptRecord[]): AttemptRecord[] {
  const unique = new Map<string, AttemptRecord>();
  for (const attempt of attempts) {
    const key = `${attempt.executionId}:${attempt.nonce ?? 'unknown'}:${attempt.hash?.toLowerCase() ?? attempt.id}`;
    const existing = unique.get(key);
    if (!existing || (existing.state === 'Signed' && attempt.state !== 'Signed')) unique.set(key, attempt);
  }
  return [...unique.values()];
}

/** Parses a receipt field that may arrive as a bigint, number or hex/decimal string. Anything else is "not observed". */
export function parseGasUsedForL1(value: unknown): bigint | undefined {
  try {
    if (typeof value === 'bigint') return value >= 0n ? value : undefined;
    if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : undefined;
    if (typeof value === 'string' && /^(0x[0-9a-fA-F]+|\d+)$/.test(value)) return BigInt(value);
  } catch { /* not observed */ }
  return undefined;
}

export async function reconcileRobinhood(input: RobinhoodReconcileInput): Promise<ReconciliationUpdate> {
  const now = (input.now ?? (() => new Date()))().toISOString();
  const updatedAttempts: AttemptRecord[] = [];
  const receipts: ReceiptRecord[] = [];
  let missing = 0;
  let reorged = 0;
  let failed = 0;
  let final = 0;
  let pending = 0;
  let lowestPending: 'soft' | 'posted' = 'posted';
  const submitted = uniqueSubmittedAttempts(input.attempts.filter((attempt) => attempt.hash && attempt.nonce !== undefined));
  if (submitted.length === 0) return unknown([], [], 'no persisted transaction attempts');
  // T-094: attempts for one execution and nonce are replacements of each other, so at most one of them can mine. Read every receipt first.
  const complete = (receipt: ObservedReceipt | null): receipt is ObservedReceipt => Boolean(receipt) && typeof receipt!.gasUsed === 'bigint' && typeof receipt!.effectiveGasPrice === 'bigint' && typeof receipt!.blockNumber === 'bigint' && Boolean(receipt!.blockHash);
  const receiptByHash = new Map<string, ObservedReceipt | null>();
  for (const attempt of submitted) {
    let read: ObservedReceipt | null = null;
    try { read = await input.readReceipt(attempt.hash!); } catch { read = null; }
    receiptByHash.set(attempt.hash!.toLowerCase(), read);
  }
  const nonceGroup = (attempt: AttemptRecord): string => `${attempt.executionId}:${attempt.nonce}`;
  let replaced = 0;
  for (const attempt of submitted) {
    const receipt = receiptByHash.get(attempt.hash!.toLowerCase()) ?? null;
    if (!complete(receipt)) {
      // No receipt for this hash. If a DIFFERENT hash for the same execution and nonce has one, this attempt lost the race: it is replaced, not unresolved.
      const siblingMined = submitted.some((other) => other !== attempt && nonceGroup(other) === nonceGroup(attempt) && other.hash!.toLowerCase() !== attempt.hash!.toLowerCase() && complete(receiptByHash.get(other.hash!.toLowerCase()) ?? null));
      if (siblingMined) { replaced += 1; updatedAttempts.push({ ...attempt, state: 'Replaced', updatedAt: now }); continue; }
      missing += 1;
      continue;
    }
    let observation: ObservedFinality;
    try { observation = await input.observe({ txHash: attempt.hash!, txBlockNumber: receipt.blockNumber }); } catch { missing += 1; continue; }
    // Unproven canonicality is never treated as final or as a reorg.
    if (observation.canonical === null) { missing += 1; continue; }
    const base = { executionId: attempt.executionId, runId: input.run.id, transactionAttemptId: attempt.id, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice, observedAt: now };
    const gasCost = receipt.gasUsed * receipt.effectiveGasPrice;
    if (observation.canonical === false) {
      reorged += 1;
      updatedAttempts.push({ ...attempt, state: 'Failed', updatedAt: now });
      receipts.push({ ...base, id: `${attempt.executionId}:reconciled:${receipt.blockHash}:reorged`, state: 'Reorged', actualSpendWei: 0n });
      continue;
    }
    const finalNow = observation.stage === 'ethereum_final' && observation.ready;
    if (!finalNow) {
      pending += 1;
      const stage = observation.stage === 'posted' ? 'posted' : 'soft';
      if (stage === 'soft') lowestPending = 'soft';
      // The coordinator accepts only terminal receipts with an amount, so a not-yet-final mint is reported as an attempt carrying its stage and no receipt.
      updatedAttempts.push({ ...attempt, robinhoodFinality: stage, updatedAt: now });
      continue;
    }
    // Final on Ethereum. The L1 part must be observed on the receipt before the amount can be trusted.
    if (receipt.gasUsedForL1 === undefined || receipt.gasUsedForL1 > receipt.gasUsed) { missing += 1; continue; }
    const mintValue = receipt.status === 'success' ? input.mintPriceWei * BigInt(input.quantity) : 0n;
    const actualSpendWei = mintValue + gasCost;
    if (receipt.status === 'success') {
      final += 1;
      updatedAttempts.push({ ...attempt, state: 'Confirmed', robinhoodFinality: 'final', updatedAt: now });
      receipts.push({ ...base, id: `${attempt.executionId}:reconciled:${receipt.blockHash}:final`, state: 'Confirmed', finalityStage: 'ethereum_final', finalitySource: 'robinhood-staged-observer', robinhoodFinality: 'final', actualSpendWei });
    } else {
      failed += 1;
      updatedAttempts.push({ ...attempt, state: 'Failed', robinhoodFinality: 'final', updatedAt: now });
      receipts.push({ ...base, id: `${attempt.executionId}:reconciled:${receipt.blockHash}:final`, state: 'Failed', finalityStage: 'ethereum_final', finalitySource: 'robinhood-staged-observer', robinhoodFinality: 'final', actualSpendWei });
    }
  }
  if (missing > 0) return unknown(updatedAttempts, receipts, 'a receipt, its finality or its L1 data fee could not be proven; outcome unresolved');
  if (reorged > 0) {
    // The coordinator only accepts "reorged" when every attempt has a reorged receipt; anything mixed waits for the owner.
    return reorged === submitted.length - replaced ? { result: 'reorged', attempts: updatedAttempts, receipts } : unknown(updatedAttempts, receipts, 'mixed reorg; the reservation stays held for owner reconciliation');
  }
  if (pending > 0) return { result: lowestPending, attempts: updatedAttempts, receipts };
  if (failed > 0) return { result: 'failed', attempts: updatedAttempts, receipts };
  return { result: final === submitted.length - replaced ? 'final' : 'unknown', attempts: updatedAttempts, receipts };
}
