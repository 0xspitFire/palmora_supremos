import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativeFundingRepository, initializeNativeFundingRepository, openDatabase, type NativeFundingPolicy, type NativeFundingPreparation, type NativeFundingRecord, type NativeFundingReceiptObservation, type NativeFundingRequest } from '@mint-bot/database';
import { FundingCoordinatorService, type NativeFundingEnginePort } from './native-funding.js';

const NOW = new Date('2026-11-13T12:00:00.000Z');
const HUB = `0x${'1'.repeat(40)}`;
const WALLET = `0x${'2'.repeat(40)}`;
const DIGEST = `sha256:${'a'.repeat(64)}`;
const HASH = `0x${'b'.repeat(64)}`;
const close: Array<() => void> = [];
afterEach(() => { while (close.length) close.pop()!(); });
function fixture() {
  const db = openDatabase(); close.push(() => db.close()); initializeNativeFundingRepository(db);
  db.exec("CREATE TABLE test_native_funding_hold(id TEXT PRIMARY KEY, state TEXT NOT NULL, required_wei TEXT NOT NULL); INSERT INTO test_native_funding_hold VALUES('hold','reserved','100')");
  let policy: NativeFundingPolicy | undefined = { kind: 'native-fleet-topup-v1', active: true, chainId: 1, hub: HUB, recipients: [WALLET], walletSetDigest: DIGEST, recordDigest: DIGEST, budgetProfileDigest: DIGEST, policyReference: 'turnkey:hub-only', expiresAt: '2099-01-01T00:00:00.000Z', maxTransferWei: 100n, rollingPrincipalCapWei: 1000n, rollingFeeCapWei: 100n, maxTransferFeeWei: 100n, hubMaxBalanceWei: 10_000n, hubReserveWei: 0n, recipientMaxBalanceWei: 100n, fleetMaxBalanceWei: 100n, gasLimitMax: 10n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n };
  const request: NativeFundingRequest = { id: 'fund:one', idempotencyKey: 'fund:one', parentRunId: 'run', parentHoldId: 'hold', parentHoldDigest: DIGEST, chainId: 1, recipient: WALLET, requiredBalanceWei: 100n, expiresAt: '2099-01-01T00:00:00.000Z' };
  const preparation: NativeFundingPreparation = { hub: HUB, valueWei: 90n, recipientBalanceWei: 10n, fleetBalanceWei: 10n, hubBalanceWei: 1000n, gasLimit: 10n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n, l1DataFeeBoundWei: 0n, operatorFeeBoundWei: 0n, nonce: 0, observedAt: NOW.toISOString(), blockNumber: 1n, blockHash: HASH, recipientCode: '0x' };
  const authority = vi.fn((input: NativeFundingRequest) => {
    const hold = db.prepare('SELECT state,required_wei FROM test_native_funding_hold WHERE id=?').get(input.parentHoldId) as { state: string; required_wei: string } | undefined;
    if (!hold || hold.state !== 'reserved' || BigInt(hold.required_wei) !== input.requiredBalanceWei || input.parentHoldDigest !== DIGEST) throw new Error('NATIVE_FUNDING_PARENT_NOT_HELD');
  });
  const repository = new NativeFundingRepository(db, { assertCurrent: authority });
  const engine: NativeFundingEnginePort = {
    prepare: vi.fn(async () => preparation),
    execute: vi.fn(async (record, hooks) => {
      expect(repository.get(record.request.id)?.state).toBe('reserved');
      await hooks.assertCurrent(); await hooks.claimForSigning();
      expect(repository.get(record.request.id)?.state).toBe('signing');
      await hooks.assertCurrent(); await hooks.persistSigned(HASH); await hooks.assertCurrent();
      await hooks.markBroadcasting();
      expect(repository.get(record.request.id)?.state).toBe('unknown');
      await hooks.markSubmitted(HASH);
      return { hash: HASH };
    }),
  };
  const observation: NativeFundingReceiptObservation = { readerHost: 'rpc-a.example', observedAt: NOW.toISOString(), chainId: 1, transactionHash: HASH, from: HUB, to: WALLET, valueWei: 90n, data: '0x', nonce: 0, blockNumber: 2n, blockHash: HASH, gasUsed: 8n, effectiveGasPrice: 1n, l1DataFeeWei: 0n, operatorFeeWei: 0n, success: true, finalityStage: 'ethereum_final', finalityEvidenceReference: 'ethereum:final' };
  const assertReady = vi.fn(async (_record: NativeFundingRecord) => undefined);
  const receipts = vi.fn(async () => [observation, { ...observation, readerHost: 'rpc-b.example' }]);
  const options = { repository, policy: () => policy, assertReady, engine, receipts, now: () => NOW };
  return { db, repository, request, engine, options, receipts, assertReady, authority, service: new FundingCoordinatorService(options), setPolicy: (value: NativeFundingPolicy | undefined) => { policy = value; }, getPolicy: () => policy! };
}

describe('funding coordinator composed durable path', () => {
  it('holds parent mint exposure, reserves before engine signing and settles a matching finalized arrival without counting principal as mint cost', async () => {
    const f = fixture();
    expect(await f.service.execute(f.request)).toMatchObject({ state: 'submitted', feeBudgetWei: 20n, transactionHash: HASH });
    expect(await f.service.reconcile(f.request.id)).toMatchObject({ state: 'settled', actualPrincipalWei: 90n, actualFeeWei: 8n });
    expect(f.db.prepare('SELECT state FROM test_native_funding_hold').get()).toEqual({ state: 'reserved' });
    expect(f.db.prepare('SELECT count(*) AS count FROM spend_reservation').get()).toEqual({ count: 0 });
    expect(f.authority).toHaveBeenCalled(); expect(f.assertReady).toHaveBeenCalled();
  });

  it('has no active profile or fallback hub and fails before any engine work', async () => {
    const f = fixture(); f.setPolicy(undefined);
    await expect(f.service.execute(f.request)).rejects.toThrow('NATIVE_FUNDING_POLICY_REQUIRED');
    expect(f.engine.prepare).not.toHaveBeenCalled(); expect(f.engine.execute).not.toHaveBeenCalled();
    expect(f.repository.get(f.request.id)).toBeUndefined();
  });

  it('cannot fund an absent or released parent and preserves a parent hold after a failed readiness check', async () => {
    const f = fixture(); f.db.prepare("UPDATE test_native_funding_hold SET state='released'").run();
    await expect(f.service.execute(f.request)).rejects.toThrow('PARENT_NOT_HELD');
    expect(f.engine.execute).not.toHaveBeenCalled();
    f.db.prepare("UPDATE test_native_funding_hold SET state='reserved'").run();
    f.assertReady.mockRejectedValue(new Error('https://provider.invalid/private-detail'));
    await expect(f.service.execute(f.request)).rejects.toThrow('NATIVE_FUNDING_UNAVAILABLE');
    expect(f.repository.get(f.request.id)?.state).toBe('reserved');
  });

  it('rechecks kill and current owner policy after asynchronous readiness returns', async () => {
    const f = fixture();
    f.assertReady.mockImplementation(async () => { f.db.prepare("UPDATE runtime_control SET kill_switch_engaged=1 WHERE id='global'").run(); });
    await expect(f.service.execute(f.request)).rejects.toThrow('KILLED');
    expect(f.engine.execute).not.toHaveBeenCalled();
    f.db.prepare("UPDATE runtime_control SET kill_switch_engaged=0 WHERE id='global'").run();
    f.assertReady.mockImplementation(async () => { f.setPolicy({ ...f.getPolicy(), budgetProfileDigest: `sha256:${'c'.repeat(64)}` }); });
    await expect(f.service.execute(f.request)).rejects.toThrow('POLICY_CHANGED');
    expect(f.engine.execute).not.toHaveBeenCalled();
  });

  it('never signs again after an accepted-but-timed-out broadcast, including after a new service instance', async () => {
    const f = fixture();
    f.engine.execute = vi.fn(async (_record, hooks) => {
      await hooks.claimForSigning(); await hooks.persistSigned(HASH); await hooks.markBroadcasting();
      throw new Error('provider credential-bearing request dump');
    });
    await expect(f.service.execute(f.request)).rejects.toThrow('NATIVE_FUNDING_UNAVAILABLE');
    expect(f.repository.get(f.request.id)).toMatchObject({ state: 'unknown', transactionHash: HASH });
    const restarted = new FundingCoordinatorService(f.options);
    expect(await restarted.execute(f.request)).toMatchObject({ state: 'unknown', transactionHash: HASH });
    expect(f.engine.execute).toHaveBeenCalledOnce();
    f.receipts.mockRejectedValueOnce(new Error('upstream timeout details'));
    await expect(restarted.reconcile(f.request.id)).rejects.toThrow('NATIVE_FUNDING_UNAVAILABLE');
    expect(f.repository.get(f.request.id)?.state).toBe('unknown');
  });

  it('allows read-only reconciliation while killed and custody disabled, without another funding signature', async () => {
    const f = fixture(); await f.service.execute(f.request);
    f.setPolicy(undefined); f.db.prepare("UPDATE runtime_control SET kill_switch_engaged=1 WHERE id='global'").run();
    expect(await f.service.reconcile(f.request.id)).toMatchObject({ state: 'settled', actualPrincipalWei: 90n });
    expect(f.engine.execute).toHaveBeenCalledOnce();
  });
});
