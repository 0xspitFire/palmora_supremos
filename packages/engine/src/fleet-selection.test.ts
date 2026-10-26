import { describe, expect, it } from 'vitest';
import { selectFleetWallets } from './fleet-selection.js';

const wallets = [0, 1, 2, 3].map((index) => ({ index, address: `0x${String(index + 1).repeat(40)}` }));

describe('which wallets of the key list a run signs with (D-073)', () => {
  it('keeps the first N when no selection is given', () => {
    expect(selectFleetWallets(wallets, { maxWallets: 2 }).map((wallet) => wallet.index)).toEqual([0, 1]);
  });

  it('takes exactly the selected positions, in the order given, wherever they sit', () => {
    const fleet = { maxWallets: 2, walletIndexes: [2, 0], expectedAddresses: [wallets[2]!.address, wallets[0]!.address] };
    expect(selectFleetWallets(wallets, fleet).map((wallet) => wallet.index)).toEqual([2, 0]);
    expect(selectFleetWallets(wallets, { maxWallets: 1, walletIndexes: [3], expectedAddresses: [wallets[3]!.address.toUpperCase().replace('0X', '0x')] }).map((wallet) => wallet.index)).toEqual([3]);
  });

  it('fails closed on a wrong address, a missing position, a repeat, too many, a bad number, or no addresses', () => {
    const ok = { maxWallets: 2, walletIndexes: [1, 2], expectedAddresses: [wallets[1]!.address, wallets[2]!.address] };
    expect(() => selectFleetWallets(wallets, { ...ok, expectedAddresses: [wallets[1]!.address, wallets[3]!.address] })).toThrow('FLEET_SELECTION_ADDRESS_MISMATCH');
    expect(() => selectFleetWallets(wallets, { ...ok, walletIndexes: [1, 9] })).toThrow('FLEET_SELECTION_INVALID');
    expect(() => selectFleetWallets(wallets, { ...ok, walletIndexes: [1, 1] })).toThrow('FLEET_SELECTION_INVALID');
    expect(() => selectFleetWallets(wallets, { ...ok, maxWallets: 1 })).toThrow('FLEET_SELECTION_INVALID');
    expect(() => selectFleetWallets(wallets, { ...ok, walletIndexes: [-1, 2] })).toThrow('FLEET_SELECTION_INVALID');
    expect(() => selectFleetWallets(wallets, { ...ok, walletIndexes: [1.5, 2] })).toThrow('FLEET_SELECTION_INVALID');
    expect(() => selectFleetWallets(wallets, { maxWallets: 2, walletIndexes: [] })).toThrow('FLEET_SELECTION_INVALID');
    expect(() => selectFleetWallets(wallets, { maxWallets: 2, walletIndexes: [1, 2] })).toThrow('FLEET_SELECTION_ADDRESSES_REQUIRED');
    expect(() => selectFleetWallets(wallets, { maxWallets: 2, walletIndexes: [1, 2], expectedAddresses: [wallets[1]!.address] })).toThrow('FLEET_SELECTION_ADDRESSES_REQUIRED');
  });
});
