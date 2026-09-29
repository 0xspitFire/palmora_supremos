import { describe, expect, it } from 'vitest';
import { openDatabase } from './database.js';
import { IntelligenceRepository } from './intelligence.js';

const WHALE = '0x1111111111111111111111111111111111111111';
const FLEET = '0x2222222222222222222222222222222222222222';

function fixture() {
  const db = openDatabase();
  db.prepare("INSERT INTO chain_profile (id, chain_id, name, rpc_endpoints_json, confirmation_depth, created_at) VALUES ('chain', 1, 'Ethereum', '[]', 2, '2026-01-01T00:00:00.000Z')").run();
  db.prepare("INSERT INTO wallet (id, chain_profile_id, address, key_reference, created_at) VALUES ('fleet', 'chain', ?, 'kms://fleet', '2026-01-01T00:00:00.000Z')").run(FLEET);
  return { db, repo: new IntelligenceRepository(db, () => new Date('2026-09-29T00:00:00.000Z')) };
}

describe('IntelligenceRepository (migration 022)', () => {
  it('stores a watched address without any key reference and lists it apart from custody wallets', () => {
    const { db, repo } = fixture();
    const row = repo.addObservedAddress(1, WHALE, 'whale one');
    expect(row).toMatchObject({ chainId: 1, address: WHALE, label: 'whale one', enabled: true });
    expect(repo.observedAddresses(1).map((item) => item.address)).toEqual([WHALE]);
    expect((db.prepare('SELECT COUNT(*) AS n FROM wallet').get() as { n: number }).n).toBe(1);
    expect((db.prepare('PRAGMA table_info(observed_address)').all() as Array<{ name: string }>).some((column) => column.name.includes('key'))).toBe(false);
  });

  it('refuses a custody wallet, an invalid address, and an identity change', () => {
    const { db, repo } = fixture();
    expect(() => repo.addObservedAddress(1, FLEET)).toThrow('observed address is a custody wallet');
    expect(() => repo.addObservedAddress(1, FLEET.toUpperCase().replace('0X', '0x'))).toThrow('observed address is a custody wallet');
    expect(() => repo.addObservedAddress(1, '0x123')).toThrow('OBSERVED_ADDRESS_INVALID');
    expect(() => repo.addObservedAddress(0, WHALE)).toThrow('OBSERVED_ADDRESS_CHAIN_INVALID');
    expect(() => repo.addObservedAddress(1, WHALE, 'x'.repeat(65))).toThrow('OBSERVED_ADDRESS_LABEL_INVALID');
    const row = repo.addObservedAddress(1, WHALE);
    expect(() => db.prepare('UPDATE observed_address SET address = ? WHERE id = ?').run('0x3333333333333333333333333333333333333333', row.id)).toThrow('observed address identity is immutable');
  });

  it('disables instead of deleting, and re-adding re-enables the same row', () => {
    const { repo } = fixture();
    const first = repo.addObservedAddress(1, WHALE);
    expect(repo.disableObservedAddress(1, WHALE)).toBe(true);
    expect(repo.observedAddresses(1)).toEqual([]);
    expect(repo.observedAddresses(1, false)).toHaveLength(1);
    expect(repo.addObservedAddress(1, WHALE).id).toBe(first.id);
    expect(repo.disableObservedAddress(1, '0x9999999999999999999999999999999999999999')).toBe(false);
  });

  it('refuses a custody wallet that is already watched, and a backwards cursor even through raw SQL', () => {
    const { db, repo } = fixture();
    repo.addObservedAddress(1, WHALE);
    expect(() => db.prepare("INSERT INTO wallet (id, chain_profile_id, address, key_reference, created_at) VALUES ('w2', 'chain', ?, 'kms://w2', '2026-01-01T00:00:00.000Z')").run(WHALE.toUpperCase().replace('0X', '0x'))).toThrow('custody wallet is a watched address');
    repo.advanceCursor(1, 'seadrop', 1_000n);
    expect(() => db.prepare("UPDATE discovery_cursor SET last_block = '999' WHERE chain_id = 1").run()).toThrow('discovery cursor cannot move backwards');
    expect(() => db.prepare("UPDATE discovery_cursor SET last_block = '10000' WHERE chain_id = 1").run()).not.toThrow();
  });

  it('moves the discovery cursor forward only', () => {
    const { repo } = fixture();
    expect(repo.cursor(1, 'seadrop')).toBeUndefined();
    repo.advanceCursor(1, 'seadrop', 100n);
    repo.advanceCursor(1, 'seadrop', 100n);
    repo.advanceCursor(1, 'seadrop', 150n);
    expect(repo.cursor(1, 'seadrop')).toBe(150n);
    expect(() => repo.advanceCursor(1, 'seadrop', 149n)).toThrow('DISCOVERY_CURSOR_REWIND');
    expect(() => repo.advanceCursor(1, 'seadrop', -1n)).toThrow('DISCOVERY_CURSOR_INVALID');
    expect(repo.cursor(1, 'other')).toBeUndefined();
  });
});
