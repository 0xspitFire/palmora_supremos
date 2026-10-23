import { describe, expect, it } from 'vitest';
import { CanonicalStoreBridge } from './canonical-store.js';
import { OPEN_FLEET_POLICY, ROBINHOOD, armed, campaign, close, fixture } from './canonical-fixtures.js';

/**
 * T-032 part C, first piece (row storage): once the owner has switched Robinhood free execution on, can the database actually
 * store an execution, an attempt and staged receipts for chain 4663? D-051 exists because it could not before. These tests are
 * the proof, and they show where the staged-finality path stops (an Ethereum-final observer is still needed for settlement).
 */
const REAL = new Date().toISOString();
const EVIDENCE = { E1: true, E2: true, E3: true, E4: true, E5: true, E6: true, E7: true } as const;

class ProvenStore extends CanonicalStoreBridge {
  protected override hasConfirmedLiveEthereumMint(): boolean { return true; }
}

async function enabledAdmission() {
  const value = await fixture(ROBINHOOD);
  const proven = new ProvenStore(value.db, { now: () => new Date(REAL) });
  await proven.open();
  proven.enableRobinhood({ id: 'rh-rows', approvedAt: REAL, expiresAt: '9999-12-31T23:59:59.999Z', evidence: { ...EVIDENCE }, paidAllowed: false, confirmationDigest: 'c'.repeat(64) });
  const campaignValue = await campaign(value, ROBINHOOD);
  const prepared = await armed(value, campaignValue);
  const store = new CanonicalStoreBridge(value.db, { now: () => new Date(REAL), fleetPolicy: OPEN_FLEET_POLICY });
  await store.open();
  const admission = await store.admitExecution(prepared.input);
  return { value, proven, store, prepared, admission };
}

describe('Robinhood rows can be stored once the owner has switched free execution on (D-051)', () => {
  it('stores the admitted execution, its reservation, an attempt and a pending staged receipt for chain 4663', async () => {
    const { value, proven, store, admission } = await enabledAdmission();
    try {
      expect(admission.executions).toHaveLength(1);
      expect(admission.reservations).toHaveLength(1);
      const executionId = admission.executions[0]!.executionId;
      const transactionIntentId = admission.executions[0]!.intentId;
      const txHash = `0x${'7'.repeat(64)}`;
      await store.persistEngineAttempt({ id: 'rh-attempt', executionId, transactionIntentId, endpoint: 'sequencer', responseClass: 'accepted', txHash, nonce: 4, attemptedAt: REAL });
      await store.persistEngineReceipt({ id: 'rh-soft', executionId, transactionAttemptId: 'rh-attempt', txHash, status: 'pending', blockNumber: 99n, blockHash: `0x${'6'.repeat(64)}`, finalityStage: 'soft', observedAt: REAL });
      expect(value.db.prepare("SELECT status, finality_stage AS stage FROM transaction_receipt WHERE id = 'rh-soft'").get()).toEqual({ status: 'pending', stage: 'soft' });
      expect(value.db.prepare('SELECT status FROM spend_reservation WHERE id = ?').get(admission.reservations[0]!.id)).toEqual({ status: 'reserved' });
      expect(store.snapshot().attempts.find((item) => item.id === 'rh-attempt')).toMatchObject({ endpoint: 'sequencer' });
    } finally { store.close(); proven.close(); await close(value); }
  });

  it('keeps a confirmed Robinhood receipt at the posted stage pending and the reservation held (posted is not final)', async () => {
    const { value, proven, store, admission } = await enabledAdmission();
    try {
      const executionId = admission.executions[0]!.executionId;
      const transactionIntentId = admission.executions[0]!.intentId;
      const txHash = `0x${'5'.repeat(64)}`;
      await store.persistEngineAttempt({ id: 'rh-attempt-2', executionId, transactionIntentId, endpoint: 'sequencer', responseClass: 'accepted', txHash, nonce: 5, attemptedAt: REAL });
      await store.persistEngineReceipt({ id: 'rh-posted', executionId, transactionAttemptId: 'rh-attempt-2', txHash, status: 'confirmed', blockNumber: 100n, blockHash: `0x${'4'.repeat(64)}`, confirmations: 1, gasUsed: 100_000n, effectiveGasPrice: 20_000_000n, l1DataFeeWei: 5_000_000_000n, finalityStage: 'posted', observedAt: REAL });
      // A confirmed L2 receipt below the Ethereum-final stage is stored as pending: success needs the success stage (migration 008/018).
      expect(value.db.prepare("SELECT status, finality_stage AS stage FROM transaction_receipt WHERE id = 'rh-posted'").get()).toEqual({ status: 'pending', stage: 'posted' });
      expect(value.db.prepare('SELECT status FROM spend_reservation WHERE id = ?').get(admission.reservations[0]!.id)).toEqual({ status: 'reserved' });
    } finally { store.close(); proven.close(); await close(value); }
  });

  const finalReceipt = async (ctx: Awaited<ReturnType<typeof enabledAdmission>>, tag: string) => {
    const executionId = ctx.admission.executions[0]!.executionId;
    const transactionIntentId = ctx.admission.executions[0]!.intentId;
    const txHash = `0x${tag.repeat(64)}`;
    await ctx.store.persistEngineAttempt({ id: `rh-attempt-${tag}`, executionId, transactionIntentId, endpoint: 'sequencer', responseClass: 'accepted', txHash, nonce: 6, attemptedAt: REAL });
    await ctx.store.persistEngineReceipt({ id: `rh-final-${tag}`, executionId, transactionAttemptId: `rh-attempt-${tag}`, txHash, status: 'confirmed', blockNumber: 101n, blockHash: `0x${'2'.repeat(64)}`, confirmations: 1, gasUsed: 100_000n, effectiveGasPrice: 20_000_000n, l1DataFeeWei: 5_000_000_000n, finalityStage: 'ethereum_final', observedAt: REAL });
    const reserved = BigInt((ctx.value.db.prepare('SELECT amount_wei AS a FROM spend_reservation WHERE id = ?').get(ctx.admission.reservations[0]!.id) as { a: string }).a);
    return { reserved, receiptId: `rh-final-${tag}` };
  };

  it('stores an Ethereum-final receipt as confirmed and settles a reservation whose observed L2 gas and L1 data fee fit inside it', async () => {
    const ctx = await enabledAdmission();
    try {
      const { reserved, receiptId } = await finalReceipt(ctx, '3');
      expect(ctx.value.db.prepare('SELECT status, finality_stage AS stage FROM transaction_receipt WHERE id = ?').get(receiptId)).toEqual({ status: 'confirmed', stage: 'ethereum_final' });
      expect(reserved).toBeGreaterThan(0n);
      await ctx.store.settleExecutionComponents(ctx.admission.reservations[0]!.id, { actualMintValueWei: 0n, actualL2ExecutionGasWei: reserved / 10n, actualL1DataGasWei: reserved / 10n, authoritativeReceiptId: receiptId });
      expect(ctx.value.db.prepare('SELECT status FROM spend_reservation WHERE id = ?').get(ctx.admission.reservations[0]!.id)).toEqual({ status: 'settled' });
    } finally { ctx.store.close(); ctx.proven.close(); await close(ctx.value); }
  });

  it('refuses to settle when the observed L2 gas plus L1 data fee exceed what was reserved, and leaves the reservation held (D-040 item 4)', async () => {
    const ctx = await enabledAdmission();
    try {
      const { reserved, receiptId } = await finalReceipt(ctx, '1');
      await expect(ctx.store.settleExecutionComponents(ctx.admission.reservations[0]!.id, { actualMintValueWei: 0n, actualL2ExecutionGasWei: reserved, actualL1DataGasWei: 1n, authoritativeReceiptId: receiptId })).rejects.toThrow(/exceeds reservation bound/);
      expect(ctx.value.db.prepare('SELECT status FROM spend_reservation WHERE id = ?').get(ctx.admission.reservations[0]!.id)).toEqual({ status: 'reserved' });
      // A paid-style settlement (mint value above zero) is refused for Robinhood as well.
      await expect(ctx.store.settleExecutionComponents(ctx.admission.reservations[0]!.id, { actualMintValueWei: 1n, actualL2ExecutionGasWei: 1n, actualL1DataGasWei: 1n, authoritativeReceiptId: receiptId })).rejects.toThrow();
    } finally { ctx.store.close(); ctx.proven.close(); await close(ctx.value); }
  });

  it('refuses to store anything once the owner has revoked the record (the database and the policy both say no)', async () => {
    const { value, proven, store, prepared } = await enabledAdmission();
    try {
      proven.revokeRobinhood({ id: 'rev-rows', confirmationDigest: 'd'.repeat(64) });
      const later = new CanonicalStoreBridge(value.db, { now: () => new Date(REAL), fleetPolicy: OPEN_FLEET_POLICY });
      await later.open();
      await expect(later.admitExecution(prepared.input)).rejects.toThrow('ROBINHOOD_EXECUTION_DISABLED');
      later.close();
    } finally { store.close(); proven.close(); await close(value); }
  });
});
