import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { allowlistPreparationGroups } from './replication-prepare.js';
const a = '0x1111111111111111111111111111111111111111' as Address;
const b = '0x2222222222222222222222222222222222222222' as Address;
const c = '0x3333333333333333333333333333333333333333' as Address;
describe('allowlist campaign grouping', () => {
  it('groups eligible free wallets once when an approved family covers them', () => {
    expect(allowlistPreparationGroups({ wallets: [a, b, c, a], targets: [a, b], paid: false, sharedFamily: true, paidMaxWallets: 2 })).toEqual([[a, b]]);
  });
  it('keeps exact-policy and paid mint preparations wallet-specific', () => {
    expect(allowlistPreparationGroups({ wallets: [a, b, c], targets: [a, b, c], paid: false, sharedFamily: false, paidMaxWallets: 2 })).toEqual([[a], [b], [c]]);
    expect(allowlistPreparationGroups({ wallets: [a, b, c], targets: [a, b, c], paid: true, sharedFamily: true, paidMaxWallets: 2 })).toEqual([[a], [b]]);
    expect(allowlistPreparationGroups({ wallets: [a], targets: [b], paid: false, sharedFamily: true, paidMaxWallets: 2 })).toEqual([]);
  });
});
