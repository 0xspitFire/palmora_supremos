import { describe, expect, it } from 'vitest';
import { assertFleetChanged, chooseWalletSource, diffWallets } from './turnkey-fleet-change.js';

const w = (index: number, signWith: string, n = index) => ({ index, signWith, address: `0x${n.toString(16).padStart(40, '0')}` });

describe('D-078 wallet source rule', () => {
  it('keeps the old rule: an installed bundle is the only source and an artifact override is refused', () => {
    expect(chooseWalletSource({ hasBundle: true })).toBe('bundle');
    expect(chooseWalletSource({ hasBundle: false, walletArtifact: 'a.json' })).toBe('artifact');
    expect(() => chooseWalletSource({ hasBundle: true, walletArtifact: 'a.json' })).toThrow('TURNKEY_POLICY_BUNDLE_OVERRIDE_BLOCKED');
  });

  it('allows a fleet change only with an installed bundle and never together with an artifact override', () => {
    expect(chooseWalletSource({ hasBundle: true, fleetChange: 'd.json' })).toBe('fleet-change');
    expect(() => chooseWalletSource({ hasBundle: false, fleetChange: 'd.json' })).toThrow('TURNKEY_FLEET_CHANGE_REQUIRES_BUNDLE');
    expect(() => chooseWalletSource({ hasBundle: true, fleetChange: 'd.json', walletArtifact: 'a.json' })).toThrow('TURNKEY_FLEET_CHANGE_CONFLICT');
    expect(() => chooseWalletSource({ hasBundle: true, fleetChange: '  ' })).toThrow('TURNKEY_FLEET_CHANGE_PATH_REQUIRED');
  });
});

describe('D-078 wallet diff', () => {
  it('lists added and removed wallets by key id and address', () => {
    const change = diffWallets([w(0, 'k0'), w(1, 'k1')], [w(0, 'k0'), w(1, 'k2', 2)]);
    expect(change).toMatchObject({ previousCount: 2, newCount: 2, unchanged: 1, reordered: false });
    expect(change.added).toEqual([{ address: w(2, 'k2').address, signWith: 'k2' }]);
    expect(change.removed).toEqual([{ address: w(1, 'k1').address, signWith: 'k1' }]);
  });

  it('treats the same key at a new position as a change, and an identical list as a no-op', () => {
    const moved = diffWallets([w(0, 'k0'), w(1, 'k1')], [w(0, 'k1', 1), w(1, 'k0', 0)]);
    expect(moved.reordered).toBe(true);
    expect(() => assertFleetChanged(moved)).not.toThrow();
    const same = diffWallets([w(0, 'k0')], [w(0, 'k0')]);
    expect(() => assertFleetChanged(same)).toThrow('TURNKEY_FLEET_CHANGE_NOOP');
  });

  it('is case-insensitive on addresses', () => {
    const upper = { index: 0, signWith: 'k0', address: w(0, 'k0').address.toUpperCase().replace('0X', '0x') };
    expect(diffWallets([w(0, 'k0')], [upper]).added).toEqual([]);
  });
});
