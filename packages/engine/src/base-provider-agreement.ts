import type { Address, Hash } from 'viem';

export interface BaseAgreementClient {
  getChainId(): Promise<number>;
  getBlock(input: { blockTag: 'finalized' }): Promise<{ number: bigint | null; hash: Hash | null }>;
  getTransactionCount(input: { address: Address; blockTag: 'pending' }): Promise<number>;
}

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
  if (
    primaryFinalized.number === null
    || fallbackFinalized.number === null
    || primaryFinalized.hash === null
    || fallbackFinalized.hash === null
    || primaryFinalized.number !== fallbackFinalized.number
    || primaryFinalized.hash.toLowerCase() !== fallbackFinalized.hash.toLowerCase()
  ) throw new Error('BASE_PROVIDER_FINALIZED_STATE_DISAGREEMENT');

  await Promise.all(wallets.map(async (address) => {
    const [primaryNonce, fallbackNonce] = await Promise.all([
      primary.getTransactionCount({ address, blockTag: 'pending' }),
      fallback.getTransactionCount({ address, blockTag: 'pending' }),
    ]);
    if (primaryNonce !== fallbackNonce) throw new Error('BASE_PROVIDER_PENDING_NONCE_DISAGREEMENT');
  }));
}
