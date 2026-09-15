import { createHash } from 'node:crypto';
import type { Address, Hash } from 'viem';
import type {
  BroadcastResponseClass,
  BroadcastResult,
  ExecutionIdentity,
  FinalityStage,
  SimulationEvidence,
  ReservationSettlementComponents,
  SpendReservationProvider,
  SupportedChainId,
} from './types.js';

export type ExecutionGate = 'simulation' | 'admission' | 'sign' | 'broadcast' | 'provider';

export class LifecycleGateError extends Error {
  public constructor(
    public readonly code: string,
    public readonly gate: ExecutionGate,
    message: string,
  ) {
    super(message);
    this.name = 'LifecycleGateError';
  }
}

/**
 * Hard chain policy. A mutable runtime flag may never turn 4663 into a live
 * execution path. Dry-run inspection is intentionally allowed so the chain
 * can be characterized without signing or broadcasting.
 */
export function assertDirectChainExecutionPolicy(
  chainId: SupportedChainId,
  mintValueWei: bigint | undefined,
  dryRun: boolean,
): void {
  if (chainId === 4663 && mintValueWei !== undefined && mintValueWei > 0n) {
    throw new LifecycleGateError(
      'PAID_ROBINHOOD_BLOCKED',
      'admission',
      'Paid Robinhood execution is hard-blocked by the engine',
    );
  }
  if (chainId === 4663 && !dryRun) {
    throw new LifecycleGateError(
      'CHAIN_4663_EXECUTION_DISABLED',
      'admission',
      'All Robinhood 4663 live execution is disabled pending integrated release evidence',
    );
  }
}

/** Live authorization must be backed by the normalized durable store. */
export function assertDurableReservationProvider(
  provider: SpendReservationProvider | undefined,
  dryRun: boolean,
): void {
  if (dryRun) return;
  if (!provider || provider.durable !== true || provider.storeKind !== 'normalized-sqlite') {
    throw new LifecycleGateError(
      'DURABLE_RESERVATION_REQUIRED',
      'provider',
      'Live execution requires a normalized durable reservation provider',
    );
  }
}

export function assertSimulationFresh(
  simulation: SimulationEvidence | undefined,
  now: Date,
  maxAgeMs: number,
): void {
  if (!simulation?.success) {
    throw new LifecycleGateError(
      'SIMULATION_FAILED',
      'simulation',
      simulation?.error ?? 'Wallet simulation is unavailable or failed',
    );
  }
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
    throw new LifecycleGateError('INVALID_SIMULATION_FRESHNESS', 'simulation', 'Simulation freshness window is invalid');
  }
  const ageMs = now.getTime() - simulation.checkedAt.getTime();
  if (ageMs < 0 || ageMs > maxAgeMs) {
    throw new LifecycleGateError(
      'STALE_SIMULATION',
      'simulation',
      `Wallet simulation is stale (${Math.max(0, ageMs)}ms old; maximum ${maxAgeMs}ms)`,
    );
  }
}

export function assertTimingWindow(
  startUnix: number,
  nowUnix: number,
  armBeforeMs: number,
): void {
  if (startUnix <= 0) return;
  if (!Number.isFinite(nowUnix) || !Number.isFinite(armBeforeMs) || armBeforeMs < 0) {
    throw new LifecycleGateError('INVALID_TIMING_GATE', 'admission', 'Timing gate inputs are invalid');
  }
  if (nowUnix * 1000 + armBeforeMs < startUnix * 1000) {
    throw new LifecycleGateError('TIMING_GATE', 'admission', 'Mint start window has not opened');
  }
  if (nowUnix > startUnix + 86_400 * 365) {
    throw new LifecycleGateError('TIMING_GATE', 'admission', 'Mint timing evidence is outside the allowed window');
  }
}

export function classifyBroadcastResult(result: BroadcastResult): BroadcastResponseClass {
  if (result.responseClass) return result.responseClass;
  if (result.success) return 'accepted';
  if (result.ambiguous) return 'ambiguous';
  if (/already\s*known/i.test(result.error ?? '')) return 'already_known';
  if (/timeout|timed out|deadline/i.test(result.error ?? '')) return 'timeout';
  return 'provider_error';
}

export function broadcastAttemptId(
  executionId: string,
  resultIndex: number,
  responseClass: BroadcastResponseClass,
): string {
  return `${executionId}:attempt:${resultIndex}:${responseClass}`;
}

export function selectBroadcastAttempt(
  executionId: string,
  results: readonly BroadcastResult[],
): { resultIndex: number; attemptId: string; result: BroadcastResult } | undefined {
  const resultIndex = results.findIndex((result) => result.success);
  if (resultIndex < 0) return undefined;
  const result = results[resultIndex]!;
  return {
    resultIndex,
    attemptId: broadcastAttemptId(executionId, resultIndex, classifyBroadcastResult(result)),
    result,
  };
}

/** IDs match Backend's canonical `prefix_sha256(value)` allocation. */
export function canonicalExecutionIdentity(
  runId: string,
  intentId: string | undefined,
  walletIndex: number,
  wallet: Address,
): ExecutionIdentity {
  const normalizedWallet = wallet.toLowerCase();
  const digest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32);
  const executionId = `execution_${digest(`${runId}:${normalizedWallet}`)}`;
  const transactionIntentId = intentId
    ? `intent_${digest(`${intentId}:${normalizedWallet}`)}`
    : `${executionId}:intent`;
  return { runId, executionId: executionId || `${runId}:wallet:${walletIndex}`, transactionIntentId };
}

export function reservationCampaignId(campaignId: string | undefined, contract: Address): string {
  return campaignId ?? `contract:${contract.toLowerCase()}`;
}

export type SubmissionDisposition =
  | { state: 'matched'; reason: string }
  | { state: 'ambiguous'; reason: string }
  | { state: 'replaced'; reason: string; observedHash?: Hash }
  | { state: 'dropped'; reason: string }
  | { state: 'reorged'; reason: string }
  | { state: 'unresolved'; reason: string };

/**
 * Reconcile by both transaction hash and `(from, nonce)`. A missing receipt is
 * never treated as failure unless the chain explicitly proves the nonce was
 * consumed by a different transaction or the caller has a drop observation.
 */
export function reconcileByHashAndNonce(input: {
  originalHash?: Hash;
  observedHash?: Hash;
  receiptVisible: boolean;
  receiptStatus?: 'success' | 'reverted';
  receiptCanonical?: boolean;
  nonceConsumedByDifferentHash?: boolean;
  dropped?: boolean;
}): SubmissionDisposition {
  if (input.receiptVisible && input.receiptCanonical === false) {
    return { state: 'reorged', reason: 'receipt is no longer canonical' };
  }
  if (input.nonceConsumedByDifferentHash || (input.observedHash && input.originalHash && input.observedHash.toLowerCase() !== input.originalHash.toLowerCase())) {
    return { state: 'replaced', observedHash: input.observedHash, reason: 'a different hash consumed the same sender nonce' };
  }
  if (input.receiptVisible && input.receiptStatus === 'success') {
    return { state: 'matched', reason: 'receipt matches the submitted transaction' };
  }
  if (input.receiptVisible && input.receiptStatus === 'reverted') {
    return { state: 'matched', reason: 'receipt matches and proves an on-chain revert' };
  }
  if (input.dropped) return { state: 'dropped', reason: 'provider/chain observation proves the submission was dropped' };
  if (input.observedHash) return { state: 'ambiguous', reason: 'hash is known but receipt is not visible' };
  return { state: 'unresolved', reason: 'hash and nonce outcome remains unresolved' };
}

export function lifecycleStateForFinality(
  chainId: SupportedChainId,
  stage: FinalityStage,
  receiptStatus: 'success' | 'reverted',
): 'included' | 'posted' | 'ethereum_final' | 'failed' {
  if (receiptStatus === 'reverted') return 'failed';
  if (chainId === 4663) {
    if (stage === 'ethereum_final') return 'ethereum_final';
    if (stage === 'posted') return 'posted';
  }
  return 'included';
}

export function shouldSettleReceipt(
  chainId: SupportedChainId,
  receiptStatus: 'success' | 'reverted',
  finalityStage: FinalityStage,
): boolean {
  if (receiptStatus === 'reverted') return true;
  return chainId !== 4663 || finalityStage === 'ethereum_final';
}

/** Split authoritative receipt gas without counting the priority component twice. */
export function actualSettlementComponents(
  totalGasWei: bigint,
  l1DataFeeWei: bigint,
  priorityFeeComponentWei = 0n,
): ReservationSettlementComponents {
  const total = totalGasWei < 0n ? 0n : totalGasWei;
  const l1 = l1DataFeeWei < 0n ? 0n : l1DataFeeWei;
  const priority = priorityFeeComponentWei < 0n ? 0n : priorityFeeComponentWei > total ? total : priorityFeeComponentWei;
  return {
    actualMintValueWei: 0n,
    actualL2ExecutionGasWei: total - priority,
    actualL1DataGasWei: l1,
    actualPriorityFeeComponentWei: priority,
  };
}
