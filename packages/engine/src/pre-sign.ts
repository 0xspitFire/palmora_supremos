import { parseTransaction, recoverTransactionAddress, type Hex } from 'viem';
import { MintError, MintErrorType, type TransactionIntent } from './types.js';

/**
 * Checks around the one place the engine may sign (T-016/T-021, D-019, D-010). They only ever refuse;
 * none of them widens what can be signed.
 */

/**
 * Worst-case Robinhood L1 data cost in wei. The old figure, `ceil(gasLimit / 16)`, was a number of gas
 * units, not wei, so it understated exposure by the size of the fee (D-038 step E7). Units times the max
 * fee per gas is wei, and is deliberately generous: Robinhood execution stays disabled.
 */
export function robinhoodL1DataGasWei(gasLimit: bigint, maxFeePerGasWei: bigint): bigint {
  if (gasLimit < 0n || maxFeePerGasWei < 0n) throw new Error('L1_DATA_GAS_INPUT_INVALID');
  return ((gasLimit + 15n) / 16n) * maxFeePerGasWei;
}

export interface ReservationRequestAmounts {
  readonly valueWei: bigint;
  readonly maxGasCostWei: bigint;
  readonly mintValueWei: bigint;
  readonly l2ExecutionGasWei: bigint;
}

/** The numbers sent to the reservation must be the numbers in the transaction about to be signed. */
export function assertRequestMatchesIntent(intent: Pick<TransactionIntent, 'value' | 'gasLimit' | 'maxFeePerGas'>, request: ReservationRequestAmounts): void {
  const worstCaseGas = intent.gasLimit * intent.maxFeePerGas;
  if (request.valueWei !== intent.value || request.mintValueWei !== intent.value || request.maxGasCostWei !== worstCaseGas || request.l2ExecutionGasWei !== worstCaseGas) {
    throw new MintError(MintErrorType.DURABLE_RESERVATION_REQUIRED, 'Reservation amounts differ from the transaction about to be signed');
  }
}

/** What actually came back from the signer must be the transaction that was checked, from the expected wallet. */
export async function assertSignedMatchesIntent(signedTx: Hex, intent: TransactionIntent): Promise<void> {
  let parsed: ReturnType<typeof parseTransaction>;
  try { parsed = parseTransaction(signedTx); } catch { throw new MintError(MintErrorType.UNKNOWN, 'Signed transaction could not be decoded; nothing was broadcast'); }
  const same =
    parsed.chainId === intent.chainId &&
    parsed.to?.toLowerCase() === intent.to.toLowerCase() &&
    (parsed.value ?? 0n) === intent.value &&
    (parsed.data ?? '0x').toLowerCase() === intent.data.toLowerCase() &&
    parsed.nonce === intent.nonce &&
    parsed.gas === intent.gasLimit &&
    parsed.maxFeePerGas === intent.maxFeePerGas &&
    parsed.maxPriorityFeePerGas === intent.maxPriorityFeePerGas;
  if (!same) throw new MintError(MintErrorType.UNKNOWN, 'Signed transaction differs from the checked transaction; nothing was broadcast');
  const from = await recoverTransactionAddress({ serializedTransaction: signedTx as never }).catch(() => undefined);
  if (!from || from.toLowerCase() !== intent.from.toLowerCase()) throw new MintError(MintErrorType.UNKNOWN, 'Signed transaction was not signed by the expected wallet; nothing was broadcast');
}

/**
 * Reserve, then sign, then confirm what was signed. The signer is not called unless the reservation was
 * accepted for exactly the amounts in the intent; a refusal at any step means nothing is broadcast.
 */
export async function reserveThenSign<R>(args: {
  intent: TransactionIntent;
  request: ReservationRequestAmounts;
  reserve: () => Promise<R>;
  sign: () => Promise<Hex>;
  checkKill: () => void;
  /** Called the moment the reservation exists, so the caller can release it if a later step refuses. */
  onReserved?: (reservation: R) => void;
}): Promise<{ reservation: R; signedTx: Hex }> {
  assertRequestMatchesIntent(args.intent, args.request);
  const reservation = await args.reserve();
  args.onReserved?.(reservation);
  args.checkKill();
  const signedTx = await args.sign();
  args.checkKill();
  await assertSignedMatchesIntent(signedTx, args.intent);
  return { reservation, signedTx };
}
