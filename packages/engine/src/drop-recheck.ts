import type { DropConfig, DropValidation } from './types.js';

/**
 * D-081: just before a wallet is prepared for sending, the drop is read again and compared with the drop the run was approved and
 * simulated against. If anything that decides whether the mint can succeed or what it costs has changed, no further wallet is
 * sent. Transactions already sent are never touched. `totalMinted` is deliberately ignored: it moves with every mint.
 *
 * The check only ever STOPS a send. If the re-read itself fails or times out it reports "unknown" and the run continues exactly
 * as before this check existed (simulation, the signed provider policy and the contract still gate every send).
 */
export const CAMPAIGN_CHANGED_MID_RUN = 'CAMPAIGN_CHANGED_MID_RUN';
export const DROP_RECHECK_TIMEOUT_MS = 2_000;
export const DROP_RECHECK_REUSE_MS = 1_500;

const plain = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => {
  if (typeof item === 'bigint') return `${item}n`;
  if (item && typeof item === 'object' && !Array.isArray(item)) return Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)));
  return item;
});

/**
 * Only keys the contract itself sets are compared. `totalSupplyKnown` / `maxSupplyKnown` describe whether an OPTIONAL read worked,
 * and the fee recipient falls back to a default when the allowed-recipient read fails, so none of those can prove a change: a
 * flaky node must never stop a good mint. The fee recipient is covered through `restrictFeeRecipients` and `feeBps`.
 */
const STABLE_SETTINGS = ['feeBps', 'restrictFeeRecipients', 'seaDropAddress'] as const;
const OPTIONAL_READ_FLAGS = ['totalSupplyKnown', 'maxSupplyKnown'] as const;

/** True when an optional read worked for one reading but not the other, so supply-based comparisons would be meaningless. */
export function isPartialReading(initial: DropConfig, current: DropConfig): boolean {
  return OPTIONAL_READ_FLAGS.some((key) => initial.extra?.[key] !== current.extra?.[key]);
}

/** Names (never values) of what changed, or undefined when nothing that matters changed. */
export function describeDropChange(initial: DropConfig, current: DropConfig, validation: DropValidation): string | undefined {
  const changed: string[] = [];
  if (initial.nftContract.toLowerCase() !== current.nftContract.toLowerCase()) changed.push('contract');
  if (initial.mintPrice !== current.mintPrice) changed.push('price');
  if (initial.maxTotalMintableByWallet !== current.maxTotalMintableByWallet) changed.push('per-wallet limit');
  if (initial.extra?.['maxSupplyKnown'] === true && current.extra?.['maxSupplyKnown'] === true && initial.maxTokenSupply !== current.maxTokenSupply) changed.push('supply');
  if (initial.startTime !== current.startTime) changed.push('start time');
  if (initial.endTime !== current.endTime) changed.push('end time');
  if (STABLE_SETTINGS.some((key) => plain(initial.extra?.[key]) !== plain(current.extra?.[key]))) changed.push('contract settings');
  if (!validation.valid) changed.push('drop no longer valid (ended or sold out)');
  return changed.length > 0 ? changed.join(', ') : undefined;
}

export interface DropRecheckOptions {
  initial: DropConfig;
  read: () => Promise<{ drop: DropConfig; validation: DropValidation }>;
  now?: () => number;
  timeoutMs?: number;
  reuseMs?: number;
  onUnavailable?: () => void;
}

/** Returns a function giving the change description, undefined for "no change", or 'unknown' when the drop could not be re-read in time. Concurrent wallets share one read. */
export function createDropRecheck(options: DropRecheckOptions): () => Promise<string | undefined | 'unknown'> {
  const now = options.now ?? (() => Date.now());
  const reuseMs = options.reuseMs ?? DROP_RECHECK_REUSE_MS;
  let cached: { at: number; result: Promise<string | undefined | 'unknown'> } | undefined;
  // Once a change is seen the run stays stopped: a later read that happens to match the original (a flaky or lagging node) must not un-stop it.
  let latched: string | undefined;
  const run = async (): Promise<string | undefined | 'unknown'> => {
    if (latched) return latched;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const read = await Promise.race([
        options.read(),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('DROP_RECHECK_TIMEOUT')), options.timeoutMs ?? DROP_RECHECK_TIMEOUT_MS); }),
      ]);
      // A partly failed reading (an optional supply read worked before but not now, or the reverse) is "unknown", never a change.
      if (isPartialReading(options.initial, read.drop)) { options.onUnavailable?.(); return 'unknown'; }
      const change = describeDropChange(options.initial, read.drop, read.validation);
      if (change) latched = change;
      return change;
    } catch {
      options.onUnavailable?.();
      return 'unknown';
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  return () => {
    if (!cached || now() - cached.at > reuseMs) cached = { at: now(), result: run() };
    return cached.result;
  };
}
