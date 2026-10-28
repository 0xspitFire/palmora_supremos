import { describe, expect, it } from 'vitest';
import { inventoryFleet, renderFleetInventory } from './turnkey-fleet-inventory.js';

const key = (id: string, name: string, address: string, extra: Record<string, unknown> = {}) => ({ privateKeyId: id, privateKeyName: name, curve: 'CURVE_SECP256K1', exported: false, addresses: [{ format: 'ADDRESS_FORMAT_ETHEREUM', address }], ...extra });
const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;

describe('turnkey fleet inventory', () => {
  it('orders usable keys by name and assigns list positions from 0', () => {
    const inventory = inventoryFleet({ privateKeys: [key('k2', 'mint-02', addr(2)), key('k1', 'mint-01', addr(1))], expect: 2 });
    expect(inventory.draftWallets).toEqual([{ index: 0, address: addr(1), signWith: 'k1' }, { index: 1, address: addr(2), signWith: 'k2' }]);
    expect(inventory.problems).toEqual([]);
  });

  it('excludes exported, wrong-curve, address-less and duplicate-address keys and says why', () => {
    const inventory = inventoryFleet({ privateKeys: [
      key('ok', 'a', addr(1)),
      key('exp', 'b', addr(2), { exported: true }),
      key('curve', 'c', addr(3), { curve: 'CURVE_ED25519' }),
      key('none', 'd', addr(4), { addresses: [] }),
      key('dup1', 'e', addr(5)), key('dup2', 'f', addr(5)),
      key('unknown', 'g', addr(6), { exported: undefined }),
    ] });
    expect(inventory.draftWallets.map((wallet) => wallet.signWith)).toEqual(['ok']);
    expect(inventory.problems.join(' ')).toMatch(/exported/);
    expect(inventory.problems.join(' ')).toMatch(/secp256k1/);
    expect(inventory.problems.join(' ')).toMatch(/no Ethereum address/);
    expect(inventory.problems.join(' ')).toMatch(/shares its address/);
  });

  it('flags a wrong count and the HD-wallet mistake', () => {
    expect(inventoryFleet({ privateKeys: [key('k', 'a', addr(1))], expect: 10 }).problems.join(' ')).toMatch(/Expected 10 usable private keys but found 1/);
    const hd = inventoryFleet({ privateKeys: [], hdWalletCount: 10, expect: 10 });
    expect(hd.usable).toBe(0);
    expect(hd.problems.join(' ')).toMatch(/HD wallet/);
  });

  it('ignores unreadable entries but reports them, and prints no secret-shaped fields', () => {
    const inventory = inventoryFleet({ privateKeys: [null, 'x', { privateKeyId: '' }, { ...key('k', 'a', addr(1)), publicKey: '02abcdef', privateKeyTags: ['t'] }] });
    expect(inventory.usable).toBe(1);
    expect(inventory.problems.join(' ')).toMatch(/3 provider entries/);
    expect(renderFleetInventory(inventory)).not.toMatch(/02abcdef/);
  });
});
