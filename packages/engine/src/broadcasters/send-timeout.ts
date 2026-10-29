/**
 * D-079: every broadcaster request aborts after this long, so one hung endpoint cannot stall a parallel send. An abort is a
 * transport error, which every broadcaster already records as `ambiguous` (the node may have accepted the transaction before the
 * response was lost), so the existing might-have-been-sent reconciliation applies and nothing is re-sent blindly.
 */
export const SEND_TIMEOUT_MS = 10_000;

export function sendSignal(timeoutMs: number = SEND_TIMEOUT_MS): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
}
