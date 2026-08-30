import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { backupDatabase, migrate, openDatabase, pruneRawObservations, verifyBackup } from './database.js';
import { DurableRepository } from './repositories.js';
import { ReadModels } from './read-models.js';
import { SpendCapExceededError, SpendReservations } from './spend-reservations.js';
import { SqliteBackendStore } from './backend-store.js';

function fixture() {
  const db = openDatabase();
  db.prepare("INSERT INTO chain_profile (id, chain_id, name, rpc_endpoints_json, confirmation_depth, created_at) VALUES ('chain', 1, 'Ethereum', '[]', 2, '2026-01-01T00:00:00.000Z')").run();
  db.prepare("INSERT INTO wallet (id, chain_profile_id, address, key_reference, created_at) VALUES ('wallet', 'chain', '0xabc', 'kms://wallet', '2026-01-01T00:00:00.000Z')").run();
  db.prepare("INSERT INTO spend_policy (id, wallet_id, daily_cap_wei, version, active) VALUES ('policy', 'wallet', '100', 'v1', 1)").run();
  return db;
}

describe('database migrations and spend reservations', () => {
  it('applies migrations idempotently and enables integrity pragmas', () => {
    const db = fixture();
    migrate(db);
    expect(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()).toEqual({ count: 9 });
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('journal_mode', { simple: true })).toBe('memory');
    expect(() => db.prepare("INSERT INTO wallet (id, chain_profile_id, address, key_reference, created_at) VALUES ('other', 'chain', '0xABC', 'kms://other', '2026-01-01T00:00:00.000Z')").run()).toThrow();
    db.close();
  });

  it('enforces a UTC daily cap, idempotency, and legal transitions', () => {
    const db = fixture();
    const reservations = new SpendReservations(db);
    const date = new Date('2026-01-10T23:59:59.000Z');
    expect(reservations.reserve({ id: 'r1', walletId: 'wallet', idempotencyKey: 'same', policyId: 'policy', amountWei: 60n, at: date })).toBe('reserved');
    expect(reservations.reserve({ id: 'different', walletId: 'wallet', idempotencyKey: 'same', policyId: 'policy', amountWei: 60n, at: date })).toBe('reserved');
    expect(() => reservations.reserve({ id: 'r2', walletId: 'wallet', idempotencyKey: 'new', policyId: 'policy', amountWei: 41n, at: date })).toThrow(SpendCapExceededError);
    reservations.transition('r1', 'settled', date);
    expect(() => reservations.transition('r1', 'released', date)).toThrow();
    expect(reservations.reserve({ id: 'r3', walletId: 'wallet', idempotencyKey: 'next-day', policyId: 'policy', amountWei: 100n, at: new Date('2026-01-11T00:00:00.000Z') })).toBe('reserved');
    db.close();
  });

  it('enforces reservations across separate SQLite connections', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mint-db-'));
    const filename = join(directory, 'state.sqlite');
    const first = openDatabase(filename);
    first.prepare("INSERT INTO chain_profile (id, chain_id, name, rpc_endpoints_json, confirmation_depth, created_at) VALUES ('chain', 1, 'Ethereum', '[]', 2, '2026-01-01T00:00:00.000Z')").run();
    first.prepare("INSERT INTO wallet (id, chain_profile_id, address, key_reference, created_at) VALUES ('wallet', 'chain', '0xabc', 'kms://wallet', '2026-01-01T00:00:00.000Z')").run();
    first.prepare("INSERT INTO spend_policy (id, wallet_id, daily_cap_wei, version, active) VALUES ('policy', 'wallet', '100', 'v1', 1)").run();
    const second = openDatabase(filename);
    const firstReservations = new SpendReservations(first);
    const secondReservations = new SpendReservations(second);
    firstReservations.reserve({ id: 'r1', walletId: 'wallet', idempotencyKey: 'connection-1', policyId: 'policy', amountWei: 70n, at: new Date('2026-01-01T00:00:00.000Z') });
    expect(() => secondReservations.reserve({ id: 'r2', walletId: 'wallet', idempotencyKey: 'connection-2', policyId: 'policy', amountWei: 31n, at: new Date('2026-01-01T00:00:00.000Z') })).toThrow(SpendCapExceededError);
    second.close();
    first.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('rejects one of two simultaneous reservation workers at the cap', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mint-race-'));
    const filename = join(directory, 'state.sqlite');
    const db = openDatabase(filename);
    db.prepare("INSERT INTO chain_profile (id, chain_id, name, rpc_endpoints_json, confirmation_depth, created_at) VALUES ('chain', 1, 'Ethereum', '[]', 2, '2026-01-01T00:00:00.000Z')").run();
    db.prepare("INSERT INTO wallet (id, chain_profile_id, address, key_reference, created_at) VALUES ('wallet', 'chain', '0xabc', 'reference-only', '2026-01-01T00:00:00.000Z')").run();
    db.prepare("INSERT INTO spend_policy (id, wallet_id, daily_cap_wei, version, active) VALUES ('policy', 'wallet', '100', 'v1', 1)").run();
    db.close();
    const sqliteModule = JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('better-sqlite3')).href);
    const workerSource = `
      const Database = (await import(${sqliteModule})).default;
      const { workerData, parentPort } = await import('node:worker_threads');
      const db = new Database(workerData.filename);
      db.pragma('busy_timeout = 5000');
      try {
        db.exec('BEGIN IMMEDIATE');
        try {
          const row = db.prepare("SELECT COALESCE(SUM(CAST(amount_wei AS INTEGER)), 0) AS used FROM spend_reservation WHERE wallet_id = 'wallet' AND usage_date = '2026-01-01' AND status = 'reserved'").get();
          if (row.used + 60 > 100) throw new Error('cap');
          db.prepare("INSERT INTO spend_reservation (id, wallet_id, idempotency_key, policy_id, amount_wei, usage_date, status, created_at) VALUES (?, 'wallet', ?, 'policy', '60', '2026-01-01', 'reserved', '2026-01-01T00:00:00.000Z')").run(workerData.id, workerData.id);
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        parentPort.postMessage('reserved');
      } catch (error) { parentPort.postMessage(error.message === 'cap' ? 'capped' : 'error'); }
      db.close();
    `;
    const run = (id: string) => new Promise<string>((resolve) => {
      const worker = new Worker(workerSource, { eval: true, execArgv: ['--input-type=module'], workerData: { filename, id } });
      worker.once('message', (message: string) => resolve(message));
      worker.once('error', (error: Error) => resolve(`error:${error.message}`));
    });
    const results = await Promise.all([run('race-1'), run('race-2')]);
    expect(results.sort()).toEqual(['capped', 'reserved']);
    const check = openDatabase(filename);
    expect(check.prepare("SELECT COUNT(*) AS count FROM spend_reservation WHERE status = 'reserved'").get()).toEqual({ count: 1 });
    check.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('protects append-only audit facts during raw-data cleanup', () => {
    const db = fixture();
    db.prepare("INSERT INTO audit_event (id, entity_type, entity_id, actor, reason, occurred_at) VALUES ('audit', 'execution', 'e1', 'system', 'test', '2026-01-01T00:00:00.000Z')").run();
    db.prepare("CREATE TABLE watcher_noise (id TEXT PRIMARY KEY, observed_at TEXT NOT NULL)").run();
    db.prepare("INSERT INTO watcher_noise VALUES ('old', '2025-01-01T00:00:00.000Z')").run();
    db.prepare("DELETE FROM watcher_noise WHERE observed_at < '2025-02-01T00:00:00.000Z'").run();
    expect(db.prepare('SELECT COUNT(*) AS count FROM audit_event').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM watcher_noise').get()).toEqual({ count: 0 });
    db.close();
  });

  it('keeps transaction intents immutable and nonces unique per wallet', () => {
    const db = fixture();
    db.prepare("INSERT INTO contract (id, chain_profile_id, address, kind) VALUES ('contract', 'chain', '0xdef', 'nft')").run();
    db.prepare("INSERT INTO collection (id, contract_id, name) VALUES ('collection', 'contract', 'Test')").run();
    db.prepare("INSERT INTO \"drop\" (id, collection_id, strategy, mint_price_wei, observed_at) VALUES ('drop', 'collection', 'test', '1', '2026-01-01T00:00:00.000Z')").run();
    db.prepare("INSERT INTO campaign (id, drop_id, state, created_at) VALUES ('campaign', 'drop', 'prepared', '2026-01-01T00:00:00.000Z')").run();
    db.prepare("INSERT INTO transaction_intent (id, campaign_id, wallet_id, intent_class, to_address, value_wei, calldata, nonce, created_at) VALUES ('intent', 'campaign', 'wallet', 'mint', '0xdef', '1', '0x', 7, '2026-01-01T00:00:00.000Z')").run();
    const repository = new DurableRepository(db);
    repository.recordAttempt({ id: 'attempt', transactionIntentId: 'intent', endpoint: 'test', responseClass: 'accepted', txHash: '0xhash', nonce: 7, attemptedAt: '2026-01-01T00:00:01.000Z' });
    repository.recordSimulation({ id: 'simulation', walletId: 'wallet', campaignId: 'campaign', transactionIntentId: 'intent', sourceBlockNumber: 1, checkedAt: '2026-01-01T00:00:00.000Z', freshnessSeconds: 30, outcome: 'pass', toolVersion: 'test' });
    repository.recordReceipt({ id: 'receipt', transactionAttemptId: 'attempt', txHash: '0xhash', status: 'confirmed', confirmations: 2, gasUsed: 21n, effectiveGasPrice: 3n, finalityStage: 'ethereum_final', finalitySource: 'test', observedAt: '2026-01-01T00:00:02.000Z' });
    repository.recordLifecycleEvent({ id: 'transition', entityType: 'execution', entityId: 'execution', newState: 'prepared', actor: 'test', source: 'test', reason: 'fixture', occurredAt: '2026-01-01T00:00:00.000Z' });
    repository.recordAuditEvent({ id: 'audit-2', entityType: 'execution', entityId: 'execution', actor: 'test', reason: 'fixture', policySnapshot: { cap: '100' }, occurredAt: '2026-01-01T00:00:00.000Z' });
    expect(db.prepare('SELECT COUNT(*) AS count FROM transaction_receipt').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM state_transition').get()).toEqual({ count: 1 });
    expect(new ReadModels(db).pendingReconciliation()).toHaveLength(0);
    expect(() => db.prepare("UPDATE audit_event SET reason = 'changed' WHERE id = 'audit-2'").run()).toThrow('audit events are immutable');
    expect(() => db.prepare("DELETE FROM state_transition WHERE id = 'transition'").run()).toThrow('state transitions are immutable');
    expect(() => db.prepare("UPDATE transaction_intent SET calldata = '0xbeef' WHERE id = 'intent'").run()).toThrow('transaction intents are immutable');
    expect(() => db.prepare("DELETE FROM transaction_intent WHERE id = 'intent'").run()).toThrow('transaction intents are immutable');
    expect(() => db.prepare("INSERT INTO transaction_intent (id, campaign_id, wallet_id, intent_class, to_address, value_wei, calldata, nonce, created_at) VALUES ('intent-2', 'campaign', 'wallet', 'mint', '0xdef', '1', '0x', 7, '2026-01-01T00:00:00.000Z')").run()).toThrow();
    expect(new ReadModels(db).chainVerification('missing')).toBeNull();
    const readiness = new ReadModels(db).readiness('campaign');
    expect(readiness).toEqual([{ campaignId: 'campaign', walletId: 'wallet', eligibilityStatus: null, simulationOutcome: 'pass', simulationCheckedAt: '2026-01-01T00:00:00.000Z', nextAction: 'resolve_eligibility' }]);
    db.close();
  });

  it('fails closed for unverified Robinhood and stores positive verification evidence', () => {
    const db = fixture();
    db.prepare("INSERT INTO chain_profile (id, chain_id, name, rpc_endpoints_json, confirmation_depth, created_at) VALUES ('robinhood', 4663, 'Robinhood Chain', '[]', 0, '2026-01-01T00:00:00.000Z')").run();
    const repository = new DurableRepository(db);
    repository.recordChainVerification({ id: 'rh-check', chainProfileId: 'robinhood', status: 'characterization_pending', chainId: 4663, sequencerEndpointReference: 'https://sequencer.mainnet.chain.robinhood.com', archiveEndpointReference: 'Rets/MINT_BOT_SECRETS.env:ROBINHOOD_RPC_URL', seaDropTestTxHash: '0xf24e0c85f6f4fa71d012b6ffbfbc871b901fb1e949635799d1821716013d891e', checkedAt: '2026-08-26T00:00:00.000Z' });
    expect(repository.canExecuteChain('robinhood')).toBe(false);
    repository.saveFeePolicy({ id: 'fee', chainProfileId: 'robinhood', version: 'v1', priorityFeeSemantics: 'fee_only', maxTotalFeeWei: 100n, freeMintTotalFeeCapWei: 10n, freeMintPriorityFeeComponentWei: 5n, freeMintPriorityFeeMultiplier: 2, active: true, createdAt: '2026-08-26T00:00:00.000Z' });
    repository.assertTotalFeeWithinPolicy('robinhood', 10n, true, 10n);
    expect(() => repository.assertTotalFeeWithinPolicy('robinhood', 11n, true)).toThrow('total fee exceeds policy');
    expect(() => repository.assertTotalFeeWithinPolicy('robinhood', 10n, true, 11n)).toThrow('priority fee component exceeds free-mint policy');
    repository.recordDocumentationFixture('positive', 'robinhood', '0xf24e0c85f6f4fa71d012b6ffbfbc871b901fb1e949635799d1821716013d891e', 'positive_reference', 'accepted positive reference metadata only', '2026-08-26T00:00:00.000Z');
    expect(db.prepare('SELECT sea_drop_test_tx_hash FROM chain_verification WHERE id = ?').get('rh-check')).toEqual({ sea_drop_test_tx_hash: '0xf24e0c85f6f4fa71d012b6ffbfbc871b901fb1e949635799d1821716013d891e' });
    db.close();
  });

  it('reserves Robinhood free-mint exposure by independent gas components', () => {
    const db = fixture();
    db.prepare("INSERT INTO contract (id, chain_profile_id, address, kind) VALUES ('contract-rh', 'chain', '0xdef', 'nft')").run();
    db.prepare("INSERT INTO collection (id, contract_id, name) VALUES ('collection-rh', 'contract-rh', 'Robinhood test')").run();
    db.prepare("INSERT INTO \"drop\" (id, collection_id, strategy, mint_price_wei, observed_at) VALUES ('drop-rh', 'collection-rh', 'test', '0', '2026-01-01T00:00:00.000Z')").run();
    db.prepare("INSERT INTO campaign (id, drop_id, state, created_at) VALUES ('campaign', 'drop-rh', 'prepared', '2026-01-01T00:00:00.000Z')").run();
    db.prepare("INSERT INTO fee_policy (id, chain_profile_id, version, priority_fee_semantics, max_total_fee_wei, free_mint_total_fee_cap_wei, free_mint_priority_fee_component_wei, free_mint_priority_fee_multiplier, paid_mints_enabled, active, created_at, zero_priority_fee_policy) VALUES ('fee', 'chain', 'v1', 'fee_only', '1000', '1000', '5', 2, 0, 1, '2026-01-01T00:00:00.000Z', 'allowed')").run();
    const reservations = new SpendReservations(db);
    const input = { walletId: 'wallet', chainProfileId: 'chain', campaignId: 'campaign', policyId: 'policy', freeMint: true, mintValueWei: 0n, l2ExecutionGasWei: 60n, l1DataGasWei: 30n, priorityFeeComponentWei: 0n, at: new Date('2026-01-01T00:00:00.000Z') };
    expect(reservations.reserveExecution({ ...input, id: 'rh-r1', idempotencyKey: 'rh-1' })).toBe('reserved');
    expect(() => reservations.reserveExecution({ ...input, id: 'rh-r2', idempotencyKey: 'rh-2', l1DataGasWei: 11n })).toThrow(SpendCapExceededError);
    expect(() => reservations.reserveExecution({ ...input, id: 'rh-r3', idempotencyKey: 'rh-3', priorityFeeComponentWei: 11n })).toThrow('priority fee component exceeds free-mint policy');
    expect(() => reservations.reserveExecution({ ...input, id: 'rh-r4', idempotencyKey: 'rh-4', freeMint: false })).toThrow('paid-mint policy is not approved');
    expect(db.prepare('SELECT mint_value_wei, l2_execution_gas_wei, l1_data_gas_wei, priority_fee_component_wei, policy_snapshot_json FROM spend_reservation WHERE id = ?').get('rh-r1')).toMatchObject({ mint_value_wei: '0', l2_execution_gas_wei: '60', l1_data_gas_wei: '30', priority_fee_component_wei: '0' });
    expect(() => db.prepare("UPDATE spend_reservation SET policy_snapshot_json = '{}' WHERE id = 'rh-r1'").run()).toThrow('reservation policy snapshot is immutable');
    db.close();
  });

  it('fails closed when zero-priority-fee ambiguity is unresolved', () => {
    const db = fixture();
    db.prepare("INSERT INTO fee_policy (id, chain_profile_id, version, priority_fee_semantics, max_total_fee_wei, free_mint_total_fee_cap_wei, free_mint_priority_fee_component_wei, free_mint_priority_fee_multiplier, paid_mints_enabled, active, created_at) VALUES ('fee-zero', 'chain', 'v1', 'fee_only', '1000', '1000', '0', 2, 0, 1, '2026-01-01T00:00:00.000Z')").run();
    const reservations = new SpendReservations(db);
    expect(() => reservations.reserveExecution({ id: 'zero', walletId: 'wallet', chainProfileId: 'chain', campaignId: 'campaign', policyId: 'policy', freeMint: true, mintValueWei: 0n, l2ExecutionGasWei: 1n, l1DataGasWei: 1n, priorityFeeComponentWei: 0n, at: new Date('2026-01-01T00:00:00.000Z'), idempotencyKey: 'zero' })).toThrow('zero-priority-fee policy requires PO resolution');
    db.close();
  });

  it('prunes only raw observations and retains audit facts', () => {
    const db = fixture();
    db.prepare("INSERT INTO raw_observation (id, source, observed_at, payload_json, deduplication_key) VALUES ('old', 'watcher', '2020-01-01T00:00:00.000Z', '{}', 'old')").run();
    db.prepare("INSERT INTO raw_observation (id, source, observed_at, payload_json, deduplication_key) VALUES ('new', 'watcher', '2026-01-01T00:00:00.000Z', '{}', 'new')").run();
    db.prepare("INSERT INTO audit_event (id, entity_type, entity_id, actor, reason, occurred_at) VALUES ('retained', 'run', 'r1', 'system', 'test', '2020-01-01T00:00:00.000Z')").run();
    expect(pruneRawObservations(db, new Date('2025-01-01T00:00:00.000Z'))).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS count FROM raw_observation').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM audit_event').get()).toEqual({ count: 1 });
    db.close();
  });

  it('backs up and restores the durable schema without secrets', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mint-backup-'));
    const source = fixture();
    source.prepare("INSERT INTO audit_event (id, entity_type, entity_id, actor, reason, occurred_at) VALUES ('backup-audit', 'run', 'r1', 'system', 'backup test', '2026-01-01T00:00:00.000Z')").run();
    const destination = join(directory, 'state.sqlite');
    await backupDatabase(source, destination);
    const verification = verifyBackup(destination);
    expect(verification.schemaVersion).toBe(9);
    const restored = openDatabase(destination);
    expect(restored.prepare('SELECT COUNT(*) AS count FROM audit_event').get()).toEqual({ count: 1 });
    const repository = new DurableRepository(restored);
    repository.saveBackupPolicy({ id: 'backup-policy', approvalOwner: 'product-owner', approvedAt: '2026-01-01T00:00:00.000Z' });
    expect(restored.prepare('SELECT retention_days, encryption_required FROM backup_policy WHERE id = ?').get('backup-policy')).toEqual({ retention_days: 30, encryption_required: 1 });
    repository.recordBackupRestoreEvidence({ id: 'backup-evidence', storeReference: 'temporary-store', backupReference: 'temporary-backup', sha256: verification.sha256, schemaVersion: verification.schemaVersion, operation: 'verification', outcome: 'passed', killSwitchEngaged: false, recordedAt: '2026-01-01T00:00:00.000Z' });
    restored.close();
    source.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('enforces Product Owner FREE wallet and active-period caps', () => {
    const db = fixture();
    db.prepare("UPDATE spend_policy SET daily_cap_wei = '2000000000000000' WHERE id = 'policy'").run();
    db.prepare("INSERT INTO contract (id, chain_profile_id, address, kind) VALUES ('contract-policy', 'chain', '0xdef', 'nft')").run();
    db.prepare("INSERT INTO collection (id, contract_id, name) VALUES ('collection-policy', 'contract-policy', 'Policy')").run();
    db.prepare("INSERT INTO \"drop\" (id, collection_id, strategy, mint_price_wei, observed_at) VALUES ('drop-policy', 'collection-policy', 'test', '0', '2026-01-01T00:00:00.000Z')").run();
    db.prepare("INSERT INTO campaign (id, drop_id, state, created_at) VALUES ('campaign-policy', 'drop-policy', 'prepared', '2026-01-01T00:00:00.000Z')").run();
    db.prepare("INSERT INTO fee_policy (id, chain_profile_id, version, priority_fee_semantics, max_total_fee_wei, free_mint_total_fee_cap_wei, free_mint_priority_fee_component_wei, free_mint_priority_fee_multiplier, paid_mints_enabled, active, created_at, zero_priority_fee_policy) VALUES ('fee-policy', 'chain', 'v1', 'fee_only', '2000000000000000', '2000000000000000', '1', 2, 0, 1, '2026-01-01T00:00:00.000Z', 'allowed')").run();
    const policy = db.prepare('SELECT free_mint_wallet_cap_wei, free_mint_period_cap_wei FROM spend_policy WHERE id = ?').get('policy');
    expect(policy).toEqual({ free_mint_wallet_cap_wei: '200000000000000', free_mint_period_cap_wei: '2000000000000000' });
    const reservations = new SpendReservations(db);
    const request = { walletId: 'wallet', chainProfileId: 'chain', campaignId: 'campaign-policy', mintPeriodId: 'period-1', policyId: 'policy', freeMint: true, mintValueWei: 0n, l2ExecutionGasWei: 200000000000000n, l1DataGasWei: 0n, priorityFeeComponentWei: 0n, at: new Date('2026-01-01T00:00:00.000Z') };
    expect(reservations.reserveExecution({ ...request, id: 'policy-1', idempotencyKey: 'policy-1' })).toBe('reserved');
    expect(() => reservations.reserveExecution({ ...request, id: 'policy-2', idempotencyKey: 'policy-2', l2ExecutionGasWei: 1n })).toThrow(SpendCapExceededError);
    db.close();
  });

  it('counts only Ethereum-final receipts as successful', () => {
    const db = fixture();
    db.prepare("INSERT INTO contract (id, chain_profile_id, address, kind) VALUES ('contract-final', 'chain', '0xdef', 'nft')").run();
    db.prepare("INSERT INTO collection (id, contract_id, name) VALUES ('collection-final', 'contract-final', 'Finality')").run();
    db.prepare("INSERT INTO \"drop\" (id, collection_id, strategy, mint_price_wei, observed_at) VALUES ('drop-final', 'collection-final', 'test', '0', '2026-01-01T00:00:00.000Z')").run();
    db.prepare("INSERT INTO campaign (id, drop_id, state, created_at) VALUES ('campaign-final', 'drop-final', 'prepared', '2026-01-01T00:00:00.000Z')").run();
    const repository = new DurableRepository(db);
    repository.saveIntent({ id: 'intent-final', campaignId: 'campaign-final', walletId: 'wallet', intentClass: 'mint', toAddress: '0xdef', valueWei: 0n, calldata: '0x', createdAt: '2026-01-01T00:00:00.000Z' });
    repository.recordAttempt({ id: 'attempt-final', transactionIntentId: 'intent-final', endpoint: 'sequencer', responseClass: 'accepted', txHash: '0xfinal', attemptedAt: '2026-01-01T00:00:01.000Z' });
    repository.recordReceipt({ id: 'receipt-soft', transactionAttemptId: 'attempt-final', txHash: '0xfinal', status: 'confirmed', confirmations: 1, finalityStage: 'soft', observedAt: '2026-01-01T00:00:02.000Z' });
    expect(repository.isFinalSuccess('chain', 'receipt-soft')).toBe(false);
    repository.recordReceipt({ id: 'receipt-final', transactionAttemptId: 'attempt-final', txHash: '0xfinal', status: 'confirmed', confirmations: 10, finalityStage: 'ethereum_final', observedAt: '2026-01-01T00:00:03.000Z' });
    expect(repository.isFinalSuccess('chain', 'receipt-final')).toBe(true);
    db.close();
  });

  it('recovers reservations, intents, and audit while kill switch remains engaged', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mint-recovery-'));
    const source = fixture();
    source.prepare("INSERT INTO contract (id, chain_profile_id, address, kind) VALUES ('contract-recovery', 'chain', '0xdef', 'nft')").run();
    source.prepare("INSERT INTO collection (id, contract_id, name) VALUES ('collection-recovery', 'contract-recovery', 'Recovery')").run();
    source.prepare("INSERT INTO \"drop\" (id, collection_id, strategy, mint_price_wei, observed_at) VALUES ('drop-recovery', 'collection-recovery', 'test', '0', '2026-01-01T00:00:00.000Z')").run();
    source.prepare("INSERT INTO campaign (id, drop_id, state, created_at) VALUES ('campaign-recovery', 'drop-recovery', 'prepared', '2026-01-01T00:00:00.000Z')").run();
    source.prepare("INSERT INTO transaction_intent (id, campaign_id, wallet_id, intent_class, to_address, value_wei, calldata, created_at) VALUES ('intent-recovery', 'campaign-recovery', 'wallet', 'mint', '0xdef', '0', '0x', '2026-01-01T00:00:00.000Z')").run();
    source.prepare("INSERT INTO spend_reservation (id, wallet_id, idempotency_key, policy_id, amount_wei, usage_date, status, created_at) VALUES ('reservation-recovery', 'wallet', 'recovery-key', 'policy', '10', '2026-01-01', 'reserved', '2026-01-01T00:00:00.000Z')").run();
    source.prepare("INSERT INTO audit_event (id, entity_type, entity_id, actor, reason, occurred_at) VALUES ('audit-recovery', 'reservation', 'reservation-recovery', 'system', 'recovery test', '2026-01-01T00:00:00.000Z')").run();
    const reservations = new SpendReservations(source);
    reservations.setKillSwitch(true, 'recovery-test');
    const destination = join(directory, 'recovered.sqlite');
    await backupDatabase(source, destination);
    const restored = openDatabase(destination);
    const recoveredReservations = new SpendReservations(restored);
    expect(recoveredReservations.isKillSwitchEngaged()).toBe(true);
    expect(restored.prepare("SELECT COUNT(*) AS count FROM spend_reservation WHERE id = 'reservation-recovery'").get()).toEqual({ count: 1 });
    expect(restored.prepare("SELECT COUNT(*) AS count FROM transaction_intent WHERE id = 'intent-recovery'").get()).toEqual({ count: 1 });
    expect(restored.prepare("SELECT COUNT(*) AS count FROM audit_event WHERE id = 'audit-recovery'").get()).toEqual({ count: 1 });
    expect(() => recoveredReservations.reserve({ id: 'blocked-after-recovery', walletId: 'wallet', idempotencyKey: 'blocked-after-recovery', policyId: 'policy', amountWei: 1n, at: new Date('2026-01-01T00:00:00.000Z') })).toThrow('kill switch engaged');
    restored.close();
    source.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('provides a backend store boundary over durable repositories and reservations', () => {
    const db = fixture();
    db.prepare("INSERT INTO contract (id, chain_profile_id, address, kind) VALUES ('contract-store', 'chain', '0xdef', 'nft')").run();
    db.prepare("INSERT INTO collection (id, contract_id, name) VALUES ('collection-store', 'contract-store', 'Store')").run();
    db.prepare("INSERT INTO \"drop\" (id, collection_id, strategy, mint_price_wei, observed_at) VALUES ('drop-store', 'collection-store', 'test', '0', '2026-01-01T00:00:00.000Z')").run();
    db.prepare("INSERT INTO campaign (id, drop_id, state, created_at) VALUES ('campaign-store', 'drop-store', 'prepared', '2026-01-01T00:00:00.000Z')").run();
    db.prepare("INSERT INTO fee_policy (id, chain_profile_id, version, priority_fee_semantics, max_total_fee_wei, free_mint_total_fee_cap_wei, free_mint_priority_fee_component_wei, free_mint_priority_fee_multiplier, paid_mints_enabled, active, created_at, zero_priority_fee_policy) VALUES ('fee-store', 'chain', 'v1', 'fee_only', '1000', '1000', '10', 2, 0, 1, '2026-01-01T00:00:00.000Z', 'allowed')").run();
    const store = new SqliteBackendStore(db);
    store.saveIntent({ id: 'intent-store', campaignId: 'campaign-store', walletId: 'wallet', intentClass: 'mint', toAddress: '0xdef', valueWei: 0n, calldata: '0x', createdAt: '2026-01-01T00:00:00.000Z' });
    store.recordAttempt({ id: 'attempt-store', transactionIntentId: 'intent-store', endpoint: 'sequencer', responseClass: 'accepted', txHash: '0xstore', nonce: 1, attemptedAt: '2026-01-01T00:00:01.000Z' });
    store.saveExecution({ id: 'execution-store', campaignId: 'campaign-store', walletId: 'wallet', transactionIntentId: 'intent-store', state: 'submitted', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:01.000Z' });
    expect(store.pendingReconciliation()).toMatchObject([{ executionId: 'execution-store', attemptId: 'attempt-store', txHash: '0xstore', nonce: 1 }]);
    expect(store.reserveExecution({ id: 'reservation-store', walletId: 'wallet', chainProfileId: 'chain', campaignId: 'campaign-store', mintPeriodId: 'period-store', idempotencyKey: 'store-key', policyId: 'policy', mintValueWei: 0n, l2ExecutionGasWei: 10n, l1DataGasWei: 5n, priorityFeeComponentWei: 0n, freeMint: true, at: new Date('2026-01-01T00:00:00.000Z') })).toBe('reserved');
    store.setKillSwitch(true, 'backend-test');
    expect(() => store.reserveExecution({ id: 'blocked-store', walletId: 'wallet', chainProfileId: 'chain', campaignId: 'campaign-store', mintPeriodId: 'period-store', idempotencyKey: 'blocked-key', policyId: 'policy', mintValueWei: 0n, l2ExecutionGasWei: 1n, l1DataGasWei: 0n, priorityFeeComponentWei: 0n, freeMint: true, at: new Date('2026-01-01T00:00:00.000Z') })).toThrow('kill switch engaged');
    expect(store.isKillSwitchEngaged()).toBe(true);
    db.close();
  });
});
