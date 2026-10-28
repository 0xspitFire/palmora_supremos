import { describe, expect, it } from 'vitest';
import { CanonicalStoreBridge } from './canonical-store.js';
import { OPEN_FLEET_POLICY, ROBINHOOD, armed, campaign, close, fixture } from './canonical-fixtures.js';

/**
 * T-094: a replacement transaction is a second attempt for the same execution, intent and nonce, linked to the one it replaces.
 * These tests run on the real SQLite schema (triggers included) with the same fixture as the Robinhood row tests.
 */
const REAL = new Date().toISOString();
const EVIDENCE = { E1: true, E2: true, E3: true, E4: true, E5: true, E6: true, E7: true } as const;
const H1 = `0x${'1'.repeat(64)}`;
const H2 = `0x${'2'.repeat(64)}`;

class ProvenStore extends CanonicalStoreBridge {
  protected override hasConfirmedLiveEthereumMint(): boolean { return true; }
}

async function setup() {
  const value = await fixture(ROBINHOOD);
  const proven = new ProvenStore(value.db, { now: () => new Date(REAL) });
  await proven.open();
  proven.enableRobinhood({ id: 'rh-replacement', approvedAt: REAL, expiresAt: '9999-12-31T23:59:59.999Z', evidence: { ...EVIDENCE }, paidAllowed: false, confirmationDigest: 'c'.repeat(64) });
  const campaignValue = await campaign(value, ROBINHOOD);
  const prepared = await armed(value, campaignValue);
  const store = new CanonicalStoreBridge(value.db, { now: () => new Date(REAL), fleetPolicy: OPEN_FLEET_POLICY });
  await store.open();
  const admission = await store.admitExecution(prepared.input);
  const executionId = admission.executions[0]!.executionId;
  const transactionIntentId = admission.executions[0]!.intentId;
  const base = { executionId, transactionIntentId, endpoint: 'sequencer', nonce: 4, attemptedAt: REAL };
  await store.persistEngineAttempt({ ...base, id: 's0', responseClass: 'signed', txHash: H1 });
  await store.persistEngineAttempt({ ...base, id: 'a0', responseClass: 'accepted', txHash: H1 });
  return { value, proven, store, base, executionId };
}

describe('T-094 replacement lineage on the real schema', () => {
  it('stores a replacement as another attempt of the same execution, linked to the attempt it replaces', async () => {
    const { value, proven, store, base } = await setup();
    try {
      await store.persistEngineAttempt({ ...base, id: 's1', responseClass: 'signed', txHash: H2, replacementOfId: 's0' });
      await store.persistEngineAttempt({ ...base, id: 'a1', responseClass: 'accepted', txHash: H2, replacementOfId: 's0' });
      const rows = value.db.prepare('SELECT id, tx_hash AS hash, replacement_of_id AS replaces FROM transaction_attempt ORDER BY id').all();
      expect(rows).toEqual([
        { id: 'a0', hash: H1, replaces: null }, { id: 'a1', hash: H2, replaces: 's0' }, { id: 's0', hash: H1, replaces: null }, { id: 's1', hash: H2, replaces: 's0' },
      ]);
    } finally { store.close(); proven.close(); await close(value); }
  });

  it('a receipt is accepted only against the attempt that carries the same hash (the winner), not against the loser', async () => {
    const { value, proven, store, base, executionId } = await setup();
    try {
      await store.persistEngineAttempt({ ...base, id: 's1', responseClass: 'signed', txHash: H2, replacementOfId: 's0' });
      await store.persistEngineAttempt({ ...base, id: 'a1', responseClass: 'accepted', txHash: H2, replacementOfId: 's0' });
      const receipt = { executionId, txHash: H2, status: 'pending', blockNumber: 99n, blockHash: `0x${'6'.repeat(64)}`, finalityStage: 'soft', observedAt: REAL };
      await expect(store.persistEngineReceipt({ ...receipt, id: 'wrong', transactionAttemptId: 'a0' })).rejects.toThrow();
      await store.persistEngineReceipt({ ...receipt, id: 'right', transactionAttemptId: 'a1' });
      expect(value.db.prepare("SELECT transaction_attempt_id AS attempt, tx_hash AS hash FROM transaction_receipt WHERE id = 'right'").get()).toEqual({ attempt: 'a1', hash: H2 });
    } finally { store.close(); proven.close(); await close(value); }
  });

  it('refuses a replacement that does not match the attempt it claims to replace', async () => {
    const { value, proven, store, base } = await setup();
    try {
      await expect(store.persistEngineAttempt({ ...base, nonce: 5, id: 'bad-nonce', responseClass: 'signed', txHash: H2, replacementOfId: 's0' })).rejects.toThrow();
      await expect(store.persistEngineAttempt({ ...base, id: 'bad-parent', responseClass: 'signed', txHash: H2, replacementOfId: 'does-not-exist' })).rejects.toThrow();
      expect(value.db.prepare("SELECT COUNT(*) AS n FROM transaction_attempt WHERE id IN ('bad-nonce', 'bad-parent')").get()).toEqual({ n: 0 });
    } finally { store.close(); proven.close(); await close(value); }
  });

  it('reconciles the WINNING attempt as matched; the loser has no reconciliation row (the schema has no replaced state) and stays visible in the recovery view', async () => {
    const { value, proven, store, base, executionId } = await setup();
    try {
      await store.persistEngineAttempt({ ...base, id: 's1', responseClass: 'signed', txHash: H2, replacementOfId: 's0' });
      await store.persistEngineAttempt({ ...base, id: 'a1', responseClass: 'accepted', txHash: H2, replacementOfId: 's0' });
      const address = (value.db.prepare('SELECT from_address AS a FROM transaction_attempt WHERE id = ?').get('a1') as { a: string | null }).a ?? '0x0000000000000000000000000000000000000001';
      await store.persistEngineReconciliation({ id: 'rec-winner', executionId, transactionAttemptId: 'a1', txHash: H2, fromAddress: address, nonce: 4, state: 'matched', source: 'receipt-watcher', details: { finalityStage: 'soft' }, checkedAt: REAL });
      expect(value.db.prepare("SELECT state, transaction_attempt_id AS attempt FROM reconciliation_record WHERE id = 'rec-winner'").get()).toEqual({ state: 'matched', attempt: 'a1' });
      // the schema cannot hold a "replaced" reconciliation: this is why the engine does not write one for a loser
      await expect(store.persistEngineReconciliation({ id: 'rec-loser', executionId, transactionAttemptId: 'a0', txHash: H1, fromAddress: address, nonce: 4, state: 'replaced', source: 'receipt-watcher', checkedAt: REAL })).rejects.toThrow();
      const exposure = value.db.prepare('SELECT attempt_id AS id FROM recovery_replacement_exposure ORDER BY attempt_id').all().map((row) => (row as { id: string }).id);
      expect(exposure).toEqual(['s1']);
    } finally { store.close(); proven.close(); await close(value); }
  });
});
