import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, type SqliteDatabase } from './database.js';
import { NativeFundingRepository, initializeNativeFundingRepository, type NativeFundingPolicy, type NativeFundingRequest, type NativeFundingPreparation, type NativeFundingReceiptObservation } from './native-funding.js';

const NOW = new Date('2026-11-13T23:59:30.000Z');
const HUB = `0x${'1'.repeat(40)}`;
const WALLET = `0x${'2'.repeat(40)}`;
const OTHER = `0x${'3'.repeat(40)}`;
const DIGEST = `sha256:${'a'.repeat(64)}`;
const HASH = `0x${'b'.repeat(64)}`;
const closes: Array<() => void> = [];
afterEach(() => { while (closes.length) closes.pop()!(); });
const time = (ms: number) => new Date(NOW.getTime() + ms);
function fixture(filename = ':memory:') {
  const db = openDatabase(filename); closes.push(() => db.close());
  initializeNativeFundingRepository(db);
  db.exec('CREATE TABLE IF NOT EXISTS test_native_parent(id TEXT PRIMARY KEY, reserved INTEGER, required_wei TEXT)');
  db.prepare('INSERT OR IGNORE INTO test_native_parent VALUES(?,1,?)').run('hold', '100');
  const assertCurrent = vi.fn((request: NativeFundingRequest) => {
    const hold = db.prepare('SELECT reserved,required_wei FROM test_native_parent WHERE id=?').get(request.parentHoldId) as { reserved: number; required_wei: string } | undefined;
    if (!hold || hold.reserved !== 1 || BigInt(hold.required_wei) !== request.requiredBalanceWei || request.parentHoldDigest !== DIGEST) throw new Error('NATIVE_FUNDING_PARENT_NOT_HELD');
  });
  const repo = new NativeFundingRepository(db, { assertCurrent });
  return { db, repo, assertCurrent };
}
function policy(overrides: Partial<NativeFundingPolicy> = {}): NativeFundingPolicy {
  return { kind: 'native-fleet-topup-v1', active: true, chainId: 1, hub: HUB, recipients: [WALLET, OTHER], walletSetDigest: DIGEST, recordDigest: DIGEST, budgetProfileDigest: DIGEST, policyReference: 'turnkey:funding-only', expiresAt: time(10 * 86_400_000).toISOString(), maxTransferWei: 1000n, rollingPrincipalCapWei: 1000n, rollingFeeCapWei: 100n, maxTransferFeeWei: 100n, hubMaxBalanceWei: 100_000n, hubReserveWei: 100n, recipientMaxBalanceWei: 1000n, fleetMaxBalanceWei: 2000n, gasLimitMax: 10n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n, ...overrides };
}
function request(id = 'one', overrides: Partial<NativeFundingRequest> = {}): NativeFundingRequest {
  return { id, idempotencyKey: `fund:${id}`, parentRunId: 'run', parentHoldId: 'hold', parentHoldDigest: DIGEST, chainId: 1, recipient: WALLET, requiredBalanceWei: 100n, expiresAt: time(10 * 86_400_000).toISOString(), ...overrides };
}
function preparation(overrides: Partial<NativeFundingPreparation> = {}): NativeFundingPreparation {
  return { hub: HUB, recipientBalanceWei: 10n, fleetBalanceWei: 10n, hubBalanceWei: 100_000n, valueWei: 90n, gasLimit: 10n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n, l1DataFeeBoundWei: 3n, operatorFeeBoundWei: 2n, nonce: 0, observedAt: NOW.toISOString(), blockNumber: 100n, blockHash: HASH, recipientCode: '0x', ...overrides };
}
function receipt(overrides: Partial<NativeFundingReceiptObservation> = {}): NativeFundingReceiptObservation[] {
  const value: NativeFundingReceiptObservation = { readerHost: 'rpc-a.example', observedAt: NOW.toISOString(), chainId: 1, transactionHash: HASH, from: HUB, to: WALLET, valueWei: 90n, data: '0x', nonce: 0, blockNumber: 101n, blockHash: HASH, gasUsed: 8n, effectiveGasPrice: 1n, l1DataFeeWei: 2n, operatorFeeWei: 1n, success: true, finalityStage: 'ethereum_final', finalityEvidenceReference: 'final:one', ...overrides };
  return [value, { ...value, readerHost: 'rpc-b.example' }];
}
function submitted(repo: NativeFundingRepository) {
  repo.admit(request(), preparation(), policy(), NOW); repo.claimForSigning('one', NOW);
  repo.markSigned('one', HASH, NOW); repo.markBroadcasting('one', NOW); repo.markSubmitted('one', HASH, NOW);
}

describe('canonical native funding reservations', () => {
  it('requires a real parent reservation inside atomic admission and stores principal separately from all chain fees', () => {
    const { repo, db, assertCurrent } = fixture();
    assertCurrent.mockImplementation(() => { expect(db.inTransaction).toBe(true); });
    const result = repo.admit(request(), preparation(), policy(), NOW);
    expect(result).toMatchObject({ state: 'reserved', feeBudgetWei: 25n, preparation: { valueWei: 90n } });
    expect(assertCurrent).toHaveBeenCalled();
    db.prepare('UPDATE test_native_parent SET reserved=0').run();
    assertCurrent.mockImplementation(() => { throw new Error('NATIVE_FUNDING_PARENT_NOT_HELD'); });
    expect(() => repo.claimForSigning('one', NOW)).toThrow('PARENT_NOT_HELD');
    expect(repo.get('one')?.state).toBe('reserved');
  });

  it('deduplicates exact replay, refuses changed requests, and never claims signing twice', () => {
    const { repo } = fixture();
    repo.admit(request(), preparation(), policy(), NOW);
    expect(repo.admit(request(), preparation({ nonce: 5 }), policy(), NOW).preparation.nonce).toBe(0);
    expect(() => repo.admit(request('one', { recipient: OTHER }), preparation(), policy(), NOW)).toThrow('IDEMPOTENCY_CONFLICT');
    repo.claimForSigning('one', NOW);
    expect(() => repo.claimForSigning('one', NOW)).toThrow('ALREADY_STARTED');
    expect(() => repo.releaseUnstarted('one', NOW)).toThrow('STATE_INVALID');
  });

  it('counts pending principal and fees across midnight and retains ambiguous exposure indefinitely', () => {
    const { repo } = fixture();
    repo.admit(request(), preparation(), policy({ rollingPrincipalCapWei: 100n }), NOW);
    repo.claimForSigning('one', NOW); repo.retainUnknown('one', NOW);
    expect(() => repo.admit(request('two', { recipient: OTHER }), preparation({ nonce: 1, observedAt: time(40_000).toISOString() }), policy({ rollingPrincipalCapWei: 100n }), time(40_000))).toThrow('ROLLING_CAP_EXCEEDED');
    expect(() => repo.admit(request('two', { recipient: OTHER }), preparation({ nonce: 1, observedAt: time(86_400_000).toISOString() }), policy(), time(86_400_000))).toThrow('STALE_PENDING');
    expect(repo.get('one')?.state).toBe('unknown');
  });

  it('keeps daily gas allowance independent from principal allowance', () => {
    const { repo } = fixture();
    repo.admit(request(), preparation(), policy({ rollingFeeCapWei: 30n }), NOW);
    expect(() => repo.admit(request('two', { recipient: OTHER }), preparation({ nonce: 1 }), policy({ rollingFeeCapWei: 30n }), NOW)).toThrow('ROLLING_CAP_EXCEEDED');
  });

  it.each([
    ['buffer', preparation({ valueWei: 91n }), policy(), 'PREPARATION_INVALID'],
    ['code', { ...preparation(), recipientCode: '0x01' } as unknown as NativeFundingPreparation, policy(), 'PREPARATION_INVALID'],
    ['hub ceiling', preparation(), policy({ hubMaxBalanceWei: 99_999n }), 'FUNDING_ENVELOPE_EXCEEDED'],
    ['per transfer fee', preparation(), policy({ maxTransferFeeWei: 24n }), 'FUNDING_ENVELOPE_EXCEEDED'],
    ['fee limit', preparation({ maxFeePerGas: 3n }), policy(), 'PREPARATION_INVALID'],
    ['disabled', preparation(), policy({ active: false }), 'POLICY_REQUIRED'],
    ['approved limit', preparation(), policy({ rollingPrincipalCapWei: 8_500_000_000_000_001n }), 'POLICY_EXCEEDS_APPROVED_LIMITS'],
  ] as const)('refuses %s without a reservation', (_label, prep, selectedPolicy, code) => {
    const { repo } = fixture();
    expect(() => repo.admit(request(), prep, selectedPolicy, NOW)).toThrow(code);
    expect(repo.get('one')).toBeUndefined();
  });

  it('accounts pending incoming allocation and rejects hub nonce reuse', () => {
    const { repo, db } = fixture();
    repo.admit(request(), preparation(), policy(), NOW);
    expect(() => repo.admit(request('two', { recipient: OTHER }), preparation(), policy(), NOW)).toThrow('NONCE_BUSY');
    db.prepare('INSERT INTO test_native_parent VALUES(?,1,?)').run('another', '100');
    expect(() => repo.admit(request('two', { parentHoldId: 'another' }), preparation({ nonce: 1 }), policy({ recipientMaxBalanceWei: 150n, maxTransferWei: 150n }), NOW)).toThrow('RECIPIENT_FUNDING_PENDING');
  });

  it('checks global kill and parent authority again before signing and preserves released history', () => {
    const { repo, db } = fixture();
    repo.admit(request(), preparation(), policy(), NOW);
    db.prepare("UPDATE runtime_control SET kill_switch_engaged=1 WHERE id='global'").run();
    expect(() => repo.claimForSigning('one', NOW)).toThrow('KILLED');
    repo.releaseUnstarted('one', NOW);
    expect(repo.get('one')?.state).toBe('released');
    expect(() => db.prepare('DELETE FROM native_funding').run()).toThrow('IMMUTABLE');
  });

  it('requires two matching final transaction observations and settles exactly once', () => {
    const { repo } = fixture(); submitted(repo);
    expect(() => repo.settle('one', [receipt()[0]!], NOW)).toThrow('FINAL_RECEIPT_REQUIRED');
    expect(() => repo.settle('one', receipt().map(row => ({ ...row, readerHost: 'rpc-a.example' })), NOW)).toThrow('INDEPENDENT_READERS_REQUIRED');
    const mismatch = receipt(); mismatch[1]!.valueWei = 91n;
    expect(() => repo.settle('one', mismatch, NOW)).toThrow('RECEIPT_DISAGREEMENT');
    expect(() => repo.settle('one', receipt({ to: OTHER }), NOW)).toThrow('RECEIPT_INVALID');
    expect(repo.settle('one', receipt(), NOW)).toMatchObject({ state: 'settled', actualPrincipalWei: 90n, actualFeeWei: 11n });
    expect(repo.settle('one', receipt(), NOW).actualPrincipalWei).toBe(90n);
    expect(() => repo.settle('one', receipt({ gasUsed: 7n }), NOW)).toThrow('SETTLEMENT_CONFLICT');
    expect(() => repo.releaseUnstarted('one', NOW)).toThrow('STATE_INVALID');
  });

  it('settles a reverted transfer gas only and keeps unknown or unfinalized outcomes reserved', () => {
    const { repo } = fixture(); submitted(repo);
    expect(() => repo.settle('one', receipt({ finalityStage: 'soft' } as unknown as Partial<NativeFundingReceiptObservation>), NOW)).toThrow('FINAL_RECEIPT_REQUIRED');
    repo.retainUnknown('one', NOW);
    expect(repo.get('one')?.state).toBe('unknown');
    expect(repo.settle('one', receipt({ success: false }), NOW)).toMatchObject({ actualPrincipalWei: 0n, actualFeeWei: 11n });
  });

  it('retains final transfer usage for a rolling24h window and detects clock rollback', () => {
    const { repo } = fixture(); submitted(repo); repo.settle('one', receipt(), NOW);
    expect(() => repo.admit(request('two', { recipient: OTHER }), preparation({ nonce: 1, observedAt: time(40_000).toISOString() }), policy({ rollingPrincipalCapWei: 100n }), time(40_000))).toThrow('ROLLING_CAP_EXCEEDED');
    const later = time(86_400_001);
    repo.admit(request('two', { recipient: OTHER }), preparation({ nonce: 1, observedAt: later.toISOString() }), policy({ rollingPrincipalCapWei: 100n }), later);
    expect(() => repo.admit(request('three'), preparation(), policy(), NOW)).toThrow('CLOCK_ROLLBACK');
  });

  it('reopens full reserved exposure only after two providers prove a changed canonical block', () => {
    const { repo } = fixture(); submitted(repo); repo.settle('one', receipt(), NOW);
    const observations = ['rpc-a.example', 'rpc-b.example'].map(readerHost => ({ readerHost, observedAt: NOW.toISOString(), chainId: 1, blockNumber: 101n, blockHash: `0x${'c'.repeat(64)}` }));
    expect(() => repo.reopenAfterReorg('one', observations.map(row => ({ ...row, blockHash: HASH })), NOW)).toThrow('REORG_PROOF_REQUIRED');
    expect(repo.reopenAfterReorg('one', observations, NOW)).toMatchObject({ state: 'unknown', feeBudgetWei: 25n });
    expect(repo.get('one')?.actualPrincipalWei).toBeUndefined();
  });

  it('retains ambiguous signing and immutable identity across a file-backed database restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-funding-'));
    const file = join(dir, 'state.sqlite');
    let db: SqliteDatabase | undefined;
    try {
      db = openDatabase(file); initializeNativeFundingRepository(db);
      const authority = { assertCurrent: () => undefined };
      const first = new NativeFundingRepository(db, authority);
      first.admit(request(), preparation(), policy(), NOW); first.claimForSigning('one', NOW);
      db.close(); db = openDatabase(file);
      const restored = new NativeFundingRepository(db, authority);
      expect(restored.get('one')?.state).toBe('signing');
      expect(() => restored.claimForSigning('one', NOW)).toThrow('ALREADY_STARTED');
      expect(() => db!.prepare("UPDATE native_funding SET principal_wei='1' WHERE id='one'").run()).toThrow('IMMUTABLE');
    } finally { db?.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
