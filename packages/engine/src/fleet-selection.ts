/**
 * Which wallets of the key list a run signs with (D-073). Without an explicit selection it is the first `maxWallets`, as before.
 * With one, it is exactly the wallets at those key-list positions, and the addresses the owner approved for the run must match
 * the wallets found at those positions: anything else is refused before a signer is asked to sign.
 */
export interface FleetSelectionConfig {
  readonly maxWallets: number;
  readonly walletIndexes?: readonly number[];
  readonly expectedAddresses?: readonly string[];
}

export function selectFleetWallets<T extends { readonly index: number; readonly address: string }>(all: readonly T[], fleet: FleetSelectionConfig): T[] {
  if (fleet.walletIndexes === undefined) return all.slice(0, fleet.maxWallets);
  const indexes = fleet.walletIndexes;
  const expected = fleet.expectedAddresses;
  if (indexes.length === 0 || indexes.length > fleet.maxWallets || indexes.some((index) => !Number.isSafeInteger(index) || index < 0) || new Set(indexes).size !== indexes.length) throw new Error('FLEET_SELECTION_INVALID');
  if (!expected || expected.length !== indexes.length) throw new Error('FLEET_SELECTION_ADDRESSES_REQUIRED');
  const byIndex = new Map(all.map((wallet) => [wallet.index, wallet] as const));
  const picked = indexes.map((index, position) => {
    const wallet = byIndex.get(index);
    if (!wallet) throw new Error('FLEET_SELECTION_INVALID');
    if (wallet.address.toLowerCase() !== String(expected[position]).toLowerCase()) throw new Error('FLEET_SELECTION_ADDRESS_MISMATCH');
    return wallet;
  });
  return picked;
}
