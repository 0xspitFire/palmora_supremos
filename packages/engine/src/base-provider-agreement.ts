import type { Address, Hash } from 'viem';

export interface BaseAgreementClient {
  getChainId(): Promise<number>;
  getBlock(input: { blockTag: 'finalized' } | { blockNumber: bigint }): Promise<{ number: bigint | null; hash: Hash | null }>;
  getTransactionCount(input: { address: Address; blockTag: 'pending' }): Promise<number>;
}

/** Base normally produces a block about every two seconds; ten minutes permits provider propagation without accepting a stale observer. */
export const MAX_BASE_FINALIZED_HEAD_LAG_BLOCKS = 300n;

/**
 * D-057 pre-sign gate. Both independently configured Base providers must name
 * Base, agree on one canonical finalized state, and report the same pending
 * nonce for every wallet that may sign. Any disagreement stops before signing.
 */
export async function assertBaseProviderAgreement(
  primary: BaseAgreementClient,
  fallback: BaseAgreementClient,
  wallets: readonly Address[],
): Promise<void> {
  const [primaryChainId, fallbackChainId] = await Promise.all([primary.getChainId(), fallback.getChainId()]);
  if (primaryChainId !== 8453 || fallbackChainId !== 8453) throw new Error('BASE_PROVIDER_CHAIN_DISAGREEMENT');

  const [primaryFinalized, fallbackFinalized] = await Promise.all([
    primary.getBlock({ blockTag: 'finalized' }),
    fallback.getBlock({ blockTag: 'finalized' }),
  ]);
  if (primaryFinalized.number === null || fallbackFinalized.number === null || primaryFinalized.hash === null || fallbackFinalized.hash === null) {
    throw new Error('BASE_PROVIDER_FINALIZED_STATE_DISAGREEMENT');
  }
  const headLag = primaryFinalized.number >= fallbackFinalized.number
    ? primaryFinalized.number - fallbackFinalized.number
    : fallbackFinalized.number - primaryFinalized.number;
  if (headLag > MAX_BASE_FINALIZED_HEAD_LAG_BLOCKS) throw new Error('BASE_PROVIDER_FINALIZED_HEAD_LAG_TOO_LARGE');

  // Independent providers need not advance their `finalized` tags in the same RPC response. Compare the hash at
  // the lower finalized height: both providers claim that block is final, so disagreement there is a real fork or
  // provider-integrity failure. The lag bound above prevents a severely stale provider from satisfying this check.
  const commonFinalizedNumber = primaryFinalized.number <= fallbackFinalized.number ? primaryFinalized.number : fallbackFinalized.number;
  const primaryCommon = primaryFinalized.number === commonFinalizedNumber
    ? primaryFinalized
    : await primary.getBlock({ blockNumber: commonFinalizedNumber });
  const fallbackCommon = fallbackFinalized.number === commonFinalizedNumber
    ? fallbackFinalized
    : await fallback.getBlock({ blockNumber: commonFinalizedNumber });
  if (
    primaryCommon.number !== commonFinalizedNumber
    || fallbackCommon.number !== commonFinalizedNumber
    || primaryCommon.hash === null
    || fallbackCommon.hash === null
    || primaryCommon.hash.toLowerCase() !== fallbackCommon.hash.toLowerCase()
  ) throw new Error('BASE_PROVIDER_FINALIZED_STATE_DISAGREEMENT');

  await Promise.all(wallets.map(async (address) => {
    const [primaryNonce, fallbackNonce] = await Promise.all([
      primary.getTransactionCount({ address, blockTag: 'pending' }),
      fallback.getTransactionCount({ address, blockTag: 'pending' }),
    ]);
    if (primaryNonce !== fallbackNonce) throw new Error('BASE_PROVIDER_PENDING_NONCE_DISAGREEMENT');
  }));
}
