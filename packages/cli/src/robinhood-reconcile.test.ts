import { describe, expect, it } from 'vitest';
import { DurableStore, ExecutionCoordinator, type AttemptRecord, type BackendState, type EngineAdapter, type RunRecord } from '@mint-bot/backend';
import { parseGasUsedForL1, reconcileRobinhood, type ObservedFinality, type ObservedReceipt } from './robinhood-reconcile.js';

const run: RunRecord = { id: 'run1', intentId: 'int1', campaignId: 'c1', mode: 'live', requestDigest: 'd', state: 'Active', createdAt: '2026-10-17T00:00:00.000Z', updatedAt: '2026-10-17T00:00:00.000Z' };
const attempt = (id: string, hash = `0x${id.padStart(64, '0')}`): AttemptRecord => ({ id: `att${id}`, executionId: `exe${id}`, runId: 'run1', wallet: `0x${id.padStart(40, '1')}`, nonce: 1, hash, state: 'Submitted', createdAt: '2026-10-17T00:00:00.000Z', updatedAt: '2026-10-17T00:00:00.000Z' });
const receipt = (over: Partial<ObservedReceipt> = {}): ObservedReceipt => ({ status: 'success', blockNumber: 100n, blockHash: '0xabc', gasUsed: 200_000n, effectiveGasPrice: 20_000_000n, gasUsedForL1: 5_000n, ...over });
const final: ObservedFinality = { stage: 'ethereum_final', canonical: true, ready: true };

const run1 = (options: { attempts?: AttemptRecord[]; receipt?: ObservedReceipt | null | (() => never); finality?: ObservedFinality | (() => never); price?: bigint; quantity?: number } = {}) => reconcileRobinhood({
  run,
  attempts: options.attempts ?? [attempt('1')],
  mintPriceWei: options.price ?? 0n,
  quantity: options.quantity ?? 1,
  readReceipt: async () => { const value = options.receipt === undefined ? receipt() : options.receipt; if (typeof value === 'function') return value(); return value; },
  observe: async () => { const value = options.finality ?? final; if (typeof value === 'function') return value(); return value; },
  now: () => new Date('2026-10-17T10:00:00.000Z'),
});

describe('Robinhood reconciliation (T-035 piece 2)', () => {
  it('is final only when canonical and Ethereum-final, and settles the observed cost (L1 data gas included in gas used)', async () => {
    const update = await run1();
    expect(update.result).toBe('final');
    expect(update.attempts[0]).toMatchObject({ state: 'Confirmed', robinhoodFinality: 'final' });
    expect(update.receipts[0]).toMatchObject({ state: 'Confirmed', robinhoodFinality: 'final', finalityStage: 'ethereum_final', actualSpendWei: 200_000n * 20_000_000n });
  });

  it('adds the mint value times quantity for a successful paid-style mint and never estimates anything', async () => {
    const update = await run1({ price: 3_000_000_000_000_000n, quantity: 2 });
    expect(update.receipts[0]?.actualSpendWei).toBe(6_000_000_000_000_000n + 200_000n * 20_000_000n);
  });

  it('keeps a posted or soft receipt pending with no amount to settle', async () => {
    const posted = await run1({ finality: { stage: 'posted', canonical: true, ready: false } });
    expect(posted.result).toBe('posted');
    expect(posted.receipts).toHaveLength(0);
    expect(posted.attempts[0]?.robinhoodFinality).toBe('posted');
    const soft = await run1({ finality: { stage: 'soft', canonical: true, ready: false } });
    expect(soft.result).toBe('soft');
    expect(soft.receipts).toHaveLength(0);
    expect(soft.attempts[0]?.robinhoodFinality).toBe('soft');
  });

  it('settles a reverted mint at the gas cost only once final', async () => {
    const update = await run1({ receipt: receipt({ status: 'reverted' }), price: 5n, quantity: 3 });
    expect(update.result).toBe('failed');
    expect(update.receipts[0]).toMatchObject({ state: 'Failed', actualSpendWei: 200_000n * 20_000_000n });
    expect(update.attempts[0]?.state).toBe('Failed');
  });

  it('reports a reorg when the receipt is not canonical and holds nothing as final', async () => {
    const update = await run1({ finality: { stage: 'soft', canonical: false, ready: false } });
    expect(update.result).toBe('reorged');
    expect(update.receipts.every((item) => item.state === 'Reorged')).toBe(true);
  });

  it('fails closed: unproven canonicality is unknown, never final and never a reorg', async () => {
    const update = await run1({ finality: { stage: 'ethereum_final', canonical: null, ready: true } });
    expect(update.result).toBe('unknown');
    expect(update.receipts).toHaveLength(0);
  });

  it('fails closed: a final receipt that does not prove the L1 data gas settles nothing', async () => {
    const missing = await run1({ receipt: receipt({ gasUsedForL1: undefined }) });
    expect(missing.result).toBe('unknown');
    expect(missing.receipts).toHaveLength(0);
    const impossible = await run1({ receipt: receipt({ gasUsedForL1: 300_000n }) });
    expect(impossible.result).toBe('unknown');
  });

  it('fails closed on a missing receipt, a failing read or a failing observer', async () => {
    expect((await run1({ receipt: null })).result).toBe('unknown');
    expect((await run1({ receipt: () => { throw new Error('rpc down'); } })).result).toBe('unknown');
    expect((await run1({ finality: () => { throw new Error('observer down'); } })).result).toBe('unknown');
  });

  it('fails closed when the receipt lacks the gas fields, without throwing', async () => {
    const broken = { ...receipt(), effectiveGasPrice: undefined } as unknown as ObservedReceipt;
    const update = await run1({ receipt: broken });
    expect(update.result).toBe('unknown');
    expect(update.receipts).toHaveLength(0);
  });

  it('does not report final while any attempt is unresolved, and refuses a mixed reorg', async () => {
    let calls = 0;
    const mixedMissing = await reconcileRobinhood({ run, attempts: [attempt('1'), attempt('2')], mintPriceWei: 0n, quantity: 1, readReceipt: async () => (++calls === 1 ? receipt() : null), observe: async () => final });
    expect(mixedMissing.result).toBe('unknown');
    let seen = 0;
    const mixedReorg = await reconcileRobinhood({ run, attempts: [attempt('1'), attempt('2')], mintPriceWei: 0n, quantity: 1, readReceipt: async () => receipt(), observe: async () => (++seen === 1 ? final : { stage: 'soft', canonical: false, ready: false }) });
    expect(mixedReorg.result).toBe('unknown');
  });

  it('returns unknown when there are no submitted attempts', async () => {
    expect((await run1({ attempts: [{ ...attempt('1'), hash: undefined }] })).result).toBe('unknown');
  });

  it('reads gasUsedForL1 only from exact numeric forms', () => {
    expect(parseGasUsedForL1('0x1e9')).toBe(489n);
    expect(parseGasUsedForL1(489n)).toBe(489n);
    expect(parseGasUsedForL1(489)).toBe(489n);
    expect(parseGasUsedForL1('489')).toBe(489n);
    expect(parseGasUsedForL1(undefined)).toBeUndefined();
    expect(parseGasUsedForL1('abc')).toBeUndefined();
    expect(parseGasUsedForL1(-1)).toBeUndefined();
    expect(parseGasUsedForL1(1.5)).toBeUndefined();
  });

  describe('through the real coordinator (settlement, run state, and errors that would stop the loop)', () => {
    const NOW = '2026-10-17T00:00:00.000Z';
    async function harness(finality: ObservedFinality | (() => never), receiptOver: Partial<ObservedReceipt> = {}, reservationWei = 1_000_000_000_000_000n) {
      class Store extends DurableStore { override capabilities() { return { durable: true, atomicAcrossProcesses: true }; } }
      const store = new Store();
      const a = attempt('1');
      await store.transaction((state: BackendState) => {
        state.runs.push({ ...run });
        state.intents.push({ id: 'int1', runId: 'run1', campaignId: 'c1', campaignSnapshot: { chainId: 4663, mintPriceWei: 0n, quantity: 1 }, wallets: [a.wallet] } as never);
        state.attempts.push(a);
        state.reservations.push({ id: 'res1', runId: 'run1', campaignId: 'c1', chainId: 4663, wallet: a.wallet, amountWei: reservationWei, accountingDate: '2026-10-17', status: 'reserved', createdAt: NOW, updatedAt: NOW });
      });
      const adapter: EngineAdapter = {
        prepare: async () => { throw new Error('unused'); },
        execute: async () => { throw new Error('unused'); },
        reconcile: (r) => reconcileRobinhood({ run: r, attempts: store.snapshot().attempts.filter((x) => x.runId === r.id), mintPriceWei: 0n, quantity: 1, readReceipt: async () => receipt(receiptOver), observe: async () => (typeof finality === 'function' ? finality() : finality) }),
      };
      return { store, coordinator: new ExecutionCoordinator(store, adapter) };
    }

    it('final: settles the reservation at the observed cost and completes the run', async () => {
      const { store, coordinator } = await harness(final);
      await coordinator.reconcile();
      const state = store.snapshot();
      expect(state.reservations[0]).toMatchObject({ status: 'settled', actualAmountWei: 200_000n * 20_000_000n });
      expect(state.runs[0]?.state).toBe('Completed');
      expect(state.receipts).toHaveLength(1);
    });

    it('posted and soft: the loop does not throw, the reservation stays held and the run is not completed', async () => {
      for (const stage of ['posted', 'soft'] as const) {
        const { store, coordinator } = await harness({ stage, canonical: true, ready: false });
        await expect(coordinator.reconcile()).resolves.toBeUndefined();
        expect(store.snapshot().reservations[0]?.status).toBe('reserved');
        expect(store.snapshot().runs[0]?.state).not.toBe('Completed');
        expect(store.snapshot().receipts).toHaveLength(0);
      }
    });

    it('reverted: settles the gas only and fails the run', async () => {
      const { store, coordinator } = await harness(final, { status: 'reverted' });
      await coordinator.reconcile();
      expect(store.snapshot().reservations[0]).toMatchObject({ status: 'settled', actualAmountWei: 200_000n * 20_000_000n });
      expect(store.snapshot().runs[0]?.state).toBe('Failed');
    });

    it('reorged: marks the reservation reorged (held for the owner) and fails the run', async () => {
      const { store, coordinator } = await harness({ stage: 'soft', canonical: false, ready: false });
      await coordinator.reconcile();
      expect(store.snapshot().reservations[0]?.status).toBe('reorged');
      expect(store.snapshot().runs[0]?.state).toBe('Failed');
    });

    it('unknown (proof missing): changes nothing', async () => {
      const { store, coordinator } = await harness(final, { gasUsedForL1: undefined });
      await coordinator.reconcile();
      expect(store.snapshot().reservations[0]?.status).toBe('reserved');
      expect(store.snapshot().receipts).toHaveLength(0);
    });

    it('refuses to settle above the reservation: the coordinator throws and the reservation stays held', async () => {
      const { store, coordinator } = await harness(final, {}, 1n);
      await expect(coordinator.reconcile()).rejects.toThrow('INVALID_SETTLEMENT_AMOUNT');
      expect(store.snapshot().reservations[0]?.status).toBe('reserved');
    });
  });
});
