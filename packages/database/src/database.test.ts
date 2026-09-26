import { describe, expect, it } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { backupDatabase, migrate, openDatabase, pruneRawObservations, restoreDatabase, verifyBackup } from './database.js';
import { computeRequestFingerprint, DurableRepository, IdempotencyConflictError } from './repositories.js';
import { ReadModels } from './read-models.js';
import { SpendCapExceededError, SpendReservations } from './spend-reservations.js';
import { SqliteBackendStore } from './backend-store.js';

function fixture() {
  const db = openDatabase();
  db.prepare("INSERT INTO chain_profile (id, chain_id, name, rpc_endpoints_json, confirmation_depth, verification_status, verification_evidence_json, verification_approved_by, verification_approved_at, execution_enabled, created_at) VALUES ('chain', 1, 'Ethereum', '[]', 2, 'verified', '{\"fixture\":\"approved\",\"finalityPassed\":true}', 'fixture', '2025-12-31T00:00:00.000Z', 1, '2026-01-01T00:00:00.000Z')").run();
  db.prepare("INSERT INTO wallet (id, chain_profile_id, address, key_reference, created_at) VALUES ('wallet', 'chain', '0xabc', 'kms://wallet', '2026-01-01T00:00:00.000Z')").run();
  db.prepare("INSERT INTO spend_policy (id, wallet_id, daily_cap_wei, version, active) VALUES ('policy', 'wallet', '100', 'v1', 1)").run();
  return db;
}

function legacyFixture() {
  const db = new BetterSqlite3(':memory:');
  db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
  for (let version = 1; version <= 9; version += 1) {
    const file = readdirForTest(migrationsDirectory).find((candidate) => candidate.startsWith(`${String(version).padStart(3, '0')}_`));
    if (!file) throw new Error(`missing legacy migration ${version}`);
    db.exec(readFileSync(join(migrationsDirectory, file), 'utf8'));
    db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(version, file, '2026-01-01T00:00:00.000Z');
  }
  db.prepare("INSERT INTO chain_profile (id, chain_id, name, rpc_endpoints_json, confirmation_depth, created_at) VALUES ('legacy-chain', 1, 'Ethereum', '[]', 2, '2026-01-01T00:00:00.000Z')").run();
  db.prepare("INSERT INTO wallet (id, chain_profile_id, address, key_reference, created_at) VALUES ('legacy-wallet', 'legacy-chain', '0xlegacy', 'reference-only', '2026-01-01T00:00:00.000Z')").run();
  db.prepare("INSERT INTO spend_policy (id, wallet_id, daily_cap_wei, version, active) VALUES ('legacy-policy', 'legacy-wallet', '100', 'v1', 1)").run();
  db.prepare("INSERT INTO spend_reservation (id, wallet_id, idempotency_key, policy_id, amount_wei, usage_date, status, created_at) VALUES ('legacy-reservation', 'legacy-wallet', 'legacy-key', 'legacy-policy', '10', '2026-01-01', 'reserved', '2026-01-01T00:00:00.000Z')").run();
  return db;
}

function readdirForTest(directory: string): string[] {
  return readdirSync(directory).filter((file) => /^\d+_.+\.sql$/.test(file) && Number(file.slice(0, 3)) <= 9).sort();
}

function campaignFixture(db: ReturnType<typeof openDatabase>, suffix: string, chainProfileId = 'chain'): string {
  const contractId = `contract-${suffix}`;
  const collectionId = `collection-${suffix}`;
  const dropId = `drop-${suffix}`;
  const campaignId = `campaign-${suffix}`;
  db.prepare('INSERT INTO contract (id, chain_profile_id, address, kind) VALUES (?, ?, ?, ?)').run(contractId, chainProfileId, `0x${suffix}`, 'nft');
  db.prepare('INSERT INTO collection (id, contract_id, name) VALUES (?, ?, ?)').run(collectionId, contractId, suffix);
  db.prepare('INSERT INTO "drop" (id, collection_id, strategy, mint_price_wei, observed_at) VALUES (?, ?, ?, ?, ?)').run(dropId, collectionId, 'test', '0', '2026-01-01T00:00:00.000Z');
  db.prepare('INSERT INTO campaign (id, drop_id, state, created_at) VALUES (?, ?, ?, ?)').run(campaignId, dropId, 'draft', '2026-01-01T00:00:00.000Z');
  db.prepare('INSERT INTO campaign_wallet (campaign_id, wallet_id, enabled, selected_at) VALUES (?, ?, 1, ?)').run(campaignId, chainProfileId === 'chain' ? 'wallet' : chainProfileId === 'robinhood-disabled' ? 'robinhood-wallet' : `${chainProfileId}-wallet`, '2026-01-01T00:00:00.000Z');
  return campaignId;
}

function linkedExecutionFixture(db: ReturnType<typeof openDatabase>, campaignId: string, suffix: string, chainProfileId = 'chain', walletId = chainProfileId === 'chain' ? 'wallet' : chainProfileId === 'robinhood-disabled' ? 'robinhood-wallet' : `${chainProfileId}-wallet`, valueWei = 0n) {
  const repository = new DurableRepository(db);
  db.prepare('INSERT OR IGNORE INTO campaign_wallet (campaign_id, wallet_id, enabled, selected_at) VALUES (?, ?, 1, ?)').run(campaignId, walletId, '2026-01-01T00:00:00.000Z');
  const intentId = `intent-${suffix}`;
  const executionId = `execution-${suffix}`;
  repository.saveIntent({ id: intentId, campaignId, walletId, intentClass: 'mint', toAddress: '0xdef', valueWei, calldata: '0x', chainProfileId, createdAt: '2026-01-01T00:00:00.000Z' });
  repository.saveExecution({ id: executionId, campaignId, walletId, transactionIntentId: intentId, state: 'prepared', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
  return { intentId, transactionIntentId: intentId, executionId };
}

describe('database migrations and spend reservations', () => {
  it('applies migrations idempotently and enables integrity pragmas', () => {
    const db = fixture();
    migrate(db);
    expect(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()).toEqual({ count: 21 });
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('journal_mode', { simple: true })).toBe('memory');
    expect(() => db.prepare("INSERT INTO wallet (id, chain_profile_id, address, key_reference, created_at) VALUES ('other', 'chain', '0xABC', 'kms://other', '2026-01-01T00:00:00.000Z')").run()).toThrow();
    db.close();
  });

  it('uses WAL and bounded writer settings for file-backed databases', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mint-wal-'));
    const filename = join(directory, 'state.sqlite');
    const db = openDatabase(filename);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('synchronous', { simple: true })).toBe(1);
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('serializes concurrent migration startup without stale migration reads', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mint-migration-race-'));
    const filename = join(directory, 'state.sqlite');
    const databaseModule = JSON.stringify(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '../dist/index.js')).href);
    const workerSource = `
      const { workerData, parentPort } = await import('node:worker_threads');
      const { openDatabase } = await import(${databaseModule});
      try { const db = openDatabase(workerData.filename); parentPort.postMessage(String(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version)); db.close(); }
      catch (error) { parentPort.postMessage('error:' + error.message); }
    `;
    const run = () => new Promise<string>((resolve) => {
      const worker = new Worker(workerSource, { eval: true, execArgv: ['--input-type=module'], workerData: { filename } });
      worker.once('message', (message: string) => resolve(message));
      worker.once('error', (error: Error) => resolve(`error:${error.message}`));
    });
    const results = await Promise.all([run(), run()]);
    expect(results.sort()).toEqual(['21', '21']);
    rmSync(directory, { recursive: true, force: true });
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
    db.prepare("INSERT INTO audit_event (id, entity_type, entity_id, actor, reason, occurred_at) VALUES ('audit', 'wallet', 'wallet', 'system', 'test', '2026-01-01T00:00:00.000Z')").run();
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
    db.prepare("INSERT INTO campaign_wallet (campaign_id, wallet_id, enabled, selected_at) VALUES ('campaign', 'wallet', 1, '2026-01-01T00:00:00.000Z')").run();
    db.prepare("INSERT INTO transaction_intent (id, campaign_id, wallet_id, intent_class, to_address, value_wei, calldata, nonce, created_at) VALUES ('intent', 'campaign', 'wallet', 'mint', '0xdef', '1', '0x', 7, '2026-01-01T00:00:00.000Z')").run();
    const repository = new DurableRepository(db);
    repository.recordAttempt({ id: 'attempt', transactionIntentId: 'intent', endpoint: 'test', responseClass: 'accepted', txHash: '0xhash', nonce: 7, attemptedAt: '2026-01-01T00:00:01.000Z' });
    repository.recordSimulation({ id: 'simulation', walletId: 'wallet', campaignId: 'campaign', transactionIntentId: 'intent', sourceBlockNumber: 1, checkedAt: '2026-01-01T00:00:00.000Z', freshnessSeconds: 300, outcome: 'pass', toolVersion: 'test' });
    repository.recordReceipt({ id: 'receipt', transactionAttemptId: 'attempt', txHash: '0xhash', status: 'confirmed', confirmations: 2, gasUsed: 21n, effectiveGasPrice: 3n, finalityStage: 'ethereum_final', finalitySource: 'test', observedAt: '2026-01-01T00:00:02.000Z' });
    repository.recordLifecycleEvent({ id: 'transition', entityType: 'wallet', entityId: 'wallet', newState: 'prepared', actor: 'test', source: 'test', reason: 'fixture', occurredAt: '2026-01-01T00:00:00.000Z' });
    repository.recordAuditEvent({ id: 'audit-2', entityType: 'wallet', entityId: 'wallet', actor: 'test', reason: 'fixture', policySnapshot: { cap: '100' }, occurredAt: '2026-01-01T00:00:00.000Z' });
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
    expect(readiness).toEqual([{ campaignId: 'campaign', walletId: 'wallet', eligibilityStatus: null, simulationOutcome: 'pass', simulationCheckedAt: '2026-01-01T00:00:00.000Z', balanceSufficient: false, capacityAvailable: true, nextAction: 'resolve_eligibility' }]);
    db.close();
  });

  it('fails closed for unverified Robinhood and stores positive verification evidence', () => {
    const db = fixture();
    db.prepare("INSERT INTO chain_profile (id, chain_id, name, rpc_endpoints_json, confirmation_depth, created_at) VALUES ('robinhood', 4663, 'Robinhood Chain', '[]', 0, '2026-01-01T00:00:00.000Z')").run();
    const repository = new DurableRepository(db);
    repository.recordChainVerification({ id: 'rh-check', chainProfileId: 'robinhood', status: 'characterization_pending', chainId: 4663, sequencerEndpointReference: 'https://sequencer.mainnet.chain.robinhood.com', archiveEndpointReference: 'Rets/MINT_BOT_SECRETS.env:ROBINHOOD_RPC_URL', seaDropTestTxHash: '0xf24e0c85f6f4fa71d012b6ffbfbc871b901fb1e949635799d1821716013d891e', checkedAt: '2026-08-26T00:00:00.000Z' });
    repository.recordChainVerification({ id: 'rh-check-2', chainProfileId: 'robinhood', status: 'execution_blocked', chainId: 4663, sequencerEndpointReference: 'https://sequencer.mainnet.chain.robinhood.com', archiveEndpointReference: 'Rets/MINT_BOT_SECRETS.env:ROBINHOOD_RPC_URL', checkedAt: '2026-08-27T00:00:00.000Z' });
    expect(repository.canExecuteChain('robinhood')).toBe(false);
    repository.saveFeePolicy({ id: 'fee', chainProfileId: 'robinhood', version: 'v1', priorityFeeSemantics: 'fee_only', maxTotalFeeWei: 100n, freeMintTotalFeeCapWei: 10n, freeMintPriorityFeeComponentWei: 5n, freeMintPriorityFeeMultiplier: 2, active: true, createdAt: '2026-08-26T00:00:00.000Z' });
    repository.assertTotalFeeWithinPolicy('robinhood', 10n, true, 10n);
    expect(() => repository.assertTotalFeeWithinPolicy('robinhood', 11n, true)).toThrow('total fee exceeds policy');
    expect(() => repository.assertTotalFeeWithinPolicy('robinhood', 10n, true, 11n)).toThrow('priority fee component exceeds free-mint policy');
    repository.recordDocumentationFixture('positive', 'robinhood', '0xf24e0c85f6f4fa71d012b6ffbfbc871b901fb1e949635799d1821716013d891e', 'positive_reference', 'accepted positive reference metadata only', '2026-08-26T00:00:00.000Z');
    expect(db.prepare('SELECT COUNT(*) AS count FROM chain_verification WHERE chain_profile_id = ?').get('robinhood')).toEqual({ count: 2 });
    expect(new ReadModels(db).chainVerification('robinhood')).toMatchObject({ status: 'execution_blocked', checkedAt: '2026-08-27T00:00:00.000Z' });
    expect(db.prepare('SELECT sea_drop_test_tx_hash FROM chain_verification WHERE id = ?').get('rh-check')).toEqual({ sea_drop_test_tx_hash: '0xf24e0c85f6f4fa71d012b6ffbfbc871b901fb1e949635799d1821716013d891e' });
    db.close();
  });

  it('reserves Robinhood free-mint exposure by independent gas components', () => {
    const db = fixture();
    db.prepare("INSERT INTO contract (id, chain_profile_id, address, kind) VALUES ('contract-rh', 'chain', '0xdef', 'nft')").run();
    db.prepare("INSERT INTO collection (id, contract_id, name) VALUES ('collection-rh', 'contract-rh', 'Robinhood test')").run();
    db.prepare("INSERT INTO \"drop\" (id, collection_id, strategy, mint_price_wei, observed_at) VALUES ('drop-rh', 'collection-rh', 'test', '0', '2026-01-01T00:00:00.000Z')").run();
    db.prepare("INSERT INTO campaign (id, drop_id, state, created_at) VALUES ('campaign', 'drop-rh', 'prepared', '2026-01-01T00:00:00.000Z')").run();
    db.prepare("INSERT INTO campaign_wallet (campaign_id, wallet_id, enabled, selected_at) VALUES ('campaign', 'wallet', 1, '2026-01-01T00:00:00.000Z')").run();
    db.prepare("INSERT INTO fee_policy (id, chain_profile_id, version, priority_fee_semantics, max_total_fee_wei, free_mint_total_fee_cap_wei, free_mint_priority_fee_component_wei, free_mint_priority_fee_multiplier, paid_mints_enabled, active, created_at, zero_priority_fee_policy) VALUES ('fee', 'chain', 'v1', 'fee_only', '1000', '1000', '5', 2, 0, 1, '2026-01-01T00:00:00.000Z', 'allowed')").run();
    const reservations = new SpendReservations(db);
    const input = { walletId: 'wallet', chainProfileId: 'chain', campaignId: 'campaign', policyId: 'policy', freeMint: true, mintValueWei: 0n, l2ExecutionGasWei: 60n, l1DataGasWei: 30n, priorityFeeComponentWei: 0n, at: new Date('2026-01-01T00:00:00.000Z') };
    const campaignRh2 = campaignFixture(db, 'rh2');
    const campaignRh3 = campaignFixture(db, 'rh3');
    const campaignRh4 = campaignFixture(db, 'rh4');
    const rh1 = linkedExecutionFixture(db, 'campaign', 'rh-r1');
    const rh2 = linkedExecutionFixture(db, campaignRh2, 'rh-r2');
    const rh3 = linkedExecutionFixture(db, campaignRh3, 'rh-r3');
    const rh4 = linkedExecutionFixture(db, campaignRh4, 'rh-r4');
    expect(reservations.reserveExecution({ ...input, ...rh1, id: 'rh-r1', idempotencyKey: 'rh-1' })).toBe('reserved');
    expect(() => reservations.reserveExecution({ ...input, ...rh2, campaignId: campaignRh2, id: 'rh-r2', idempotencyKey: 'rh-2', l1DataGasWei: 11n })).toThrow(SpendCapExceededError);
    expect(() => reservations.reserveExecution({ ...input, ...rh3, campaignId: campaignRh3, id: 'rh-r3', idempotencyKey: 'rh-3', priorityFeeComponentWei: 11n })).toThrow('priority fee component exceeds free-mint policy');
    expect(() => reservations.reserveExecution({ ...input, ...rh4, campaignId: campaignRh4, id: 'rh-r4', idempotencyKey: 'rh-4', freeMint: false })).toThrow('paid-mint policy is not approved');
    expect(db.prepare('SELECT mint_value_wei, l2_execution_gas_wei, l1_data_gas_wei, priority_fee_component_wei, policy_snapshot_json FROM spend_reservation WHERE id = ?').get('rh-r1')).toMatchObject({ mint_value_wei: '0', l2_execution_gas_wei: '60', l1_data_gas_wei: '30', priority_fee_component_wei: '0' });
    expect(() => db.prepare("UPDATE spend_reservation SET policy_snapshot_json = '{}' WHERE id = 'rh-r1'").run()).toThrow('reservation policy snapshot is immutable');
    db.close();
  });

  it('fails closed when zero-priority-fee ambiguity is unresolved', () => {
    const db = fixture();
    const campaignId = campaignFixture(db, 'zero');
    db.prepare("INSERT INTO fee_policy (id, chain_profile_id, version, priority_fee_semantics, max_total_fee_wei, free_mint_total_fee_cap_wei, free_mint_priority_fee_component_wei, free_mint_priority_fee_multiplier, paid_mints_enabled, active, created_at) VALUES ('fee-zero', 'chain', 'v1', 'fee_only', '1000', '1000', '0', 2, 0, 1, '2026-01-01T00:00:00.000Z')").run();
    const reservations = new SpendReservations(db);
    const zeroExecution = linkedExecutionFixture(db, campaignId, 'zero');
    expect(() => reservations.reserveExecution({ id: 'zero', walletId: 'wallet', chainProfileId: 'chain', campaignId, ...zeroExecution, policyId: 'policy', freeMint: true, mintValueWei: 0n, l2ExecutionGasWei: 1n, l1DataGasWei: 1n, priorityFeeComponentWei: 0n, priorityFeeBufferWei: 1n, at: new Date('2026-01-01T00:00:00.000Z'), idempotencyKey: 'zero' })).toThrow('zero-priority-fee policy requires PO resolution');
    db.close();
  });

  it('prunes only raw observations and retains audit facts', () => {
    const db = fixture();
    db.prepare("INSERT INTO raw_observation (id, source, observed_at, payload_json, deduplication_key) VALUES ('old', 'watcher', '2020-01-01T00:00:00.000Z', '{}', 'old')").run();
    db.prepare("INSERT INTO raw_observation (id, source, observed_at, payload_json, deduplication_key) VALUES ('new', 'watcher', '2026-01-01T00:00:00.000Z', '{}', 'new')").run();
    db.prepare("INSERT INTO audit_event (id, entity_type, entity_id, actor, reason, occurred_at) VALUES ('retained', 'wallet', 'wallet', 'system', 'test', '2020-01-01T00:00:00.000Z')").run();
    expect(pruneRawObservations(db, new Date('2025-01-01T00:00:00.000Z'))).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS count FROM raw_observation').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM audit_event').get()).toEqual({ count: 1 });
    db.close();
  });

  it('backs up and restores the durable schema without secrets', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mint-backup-'));
    const source = fixture();
    source.prepare("INSERT INTO audit_event (id, entity_type, entity_id, actor, reason, occurred_at) VALUES ('backup-audit', 'wallet', 'wallet', 'system', 'backup test', '2026-01-01T00:00:00.000Z')").run();
    const destination = join(directory, 'state.sqlite');
    await backupDatabase(source, destination);
    const verification = verifyBackup(destination);
    expect(verification.schemaVersion).toBe(21);
    expect(verification.integrityCheck).toBe('ok');
    expect(verification.foreignKeyViolations).toBe(0);
    const restoredDestination = join(directory, 'restored.sqlite');
    const restoredVerification = await restoreDatabase(destination, restoredDestination);
    expect(restoredVerification).toMatchObject({ schemaVersion: 21, integrityCheck: 'ok', foreignKeyViolations: 0 });
    const staleDestination = join(directory, 'stale.sqlite');
    copyFileSync(destination, staleDestination);
    const staleDb = new BetterSqlite3(staleDestination);
    staleDb.prepare("UPDATE schema_migrations SET checksum = 'bad' WHERE version = 15").run();
    staleDb.close();
    expect(() => verifyBackup(staleDestination)).toThrow('backup migration mismatch');
    const missingReadModelDestination = join(directory, 'missing-read-model.sqlite');
    copyFileSync(destination, missingReadModelDestination);
    const missingReadModelDb = new BetterSqlite3(missingReadModelDestination);
    missingReadModelDb.exec('DROP TABLE readiness_snapshot');
    missingReadModelDb.close();
    expect(() => verifyBackup(missingReadModelDestination)).toThrow('backup is missing required object: readiness_snapshot');
    const restored = openDatabase(destination);
    expect(restored.prepare('SELECT COUNT(*) AS count FROM audit_event').get()).toEqual({ count: 1 });
    const repository = new DurableRepository(restored);
    repository.saveBackupPolicy({ id: 'backup-policy', approvalOwner: 'product-owner', approvedAt: '2026-01-01T00:00:00.000Z' });
    expect(restored.prepare('SELECT retention_days, encryption_required FROM backup_policy WHERE id = ?').get('backup-policy')).toEqual({ retention_days: 30, encryption_required: 1 });
    repository.recordBackupRestoreEvidence({ id: 'backup-evidence', storeReference: destination, backupReference: 's3://test/backup', sha256: verification.sha256, schemaVersion: 21, operation: 'verification', outcome: 'passed', killSwitchEngaged: true, encryptionVerified: true, integrityCheck: 'ok', verificationSha256: verification.sha256, evidence: { offHost: true, restoreVerified: true, postRestoreReconciliation: true, retentionDays: 30 }, recordedAt: '2026-01-01T00:00:00.000Z' });
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
    db.prepare("INSERT INTO campaign_wallet (campaign_id, wallet_id, enabled, selected_at) VALUES ('campaign-policy', 'wallet', 1, '2026-01-01T00:00:00.000Z')").run();
    db.prepare("INSERT INTO fee_policy (id, chain_profile_id, version, priority_fee_semantics, max_total_fee_wei, free_mint_total_fee_cap_wei, free_mint_priority_fee_component_wei, free_mint_priority_fee_multiplier, paid_mints_enabled, active, created_at, zero_priority_fee_policy) VALUES ('fee-policy', 'chain', 'v1', 'fee_only', '2000000000000000', '2000000000000000', '1', 2, 0, 1, '2026-01-01T00:00:00.000Z', 'allowed')").run();
    const policy = db.prepare('SELECT free_mint_wallet_cap_wei, free_mint_period_cap_wei FROM spend_policy WHERE id = ?').get('policy');
    expect(policy).toEqual({ free_mint_wallet_cap_wei: '200000000000000', free_mint_period_cap_wei: '2000000000000000' });
    const reservations = new SpendReservations(db);
    const policyFirst = linkedExecutionFixture(db, 'campaign-policy', 'policy-1');
    const campaignPolicy2 = campaignFixture(db, 'policy2');
    const policySecond = linkedExecutionFixture(db, campaignPolicy2, 'policy-2');
    const request = { walletId: 'wallet', chainProfileId: 'chain', campaignId: 'campaign-policy', mintPeriodId: 'campaign:campaign-policy', ...policyFirst, policyId: 'policy', freeMint: true, mintValueWei: 0n, l2ExecutionGasWei: 200000000000000n, l1DataGasWei: 0n, priorityFeeComponentWei: 0n, at: new Date('2026-01-01T00:00:00.000Z') };
    expect(reservations.reserveExecution({ ...request, id: 'policy-1', idempotencyKey: 'policy-1' })).toBe('reserved');
    expect(() => reservations.reserveExecution({ ...request, ...policySecond, campaignId: campaignPolicy2, mintPeriodId: `campaign:${campaignPolicy2}`, id: 'policy-2', idempotencyKey: 'policy-2', l2ExecutionGasWei: 1n })).toThrow(SpendCapExceededError);
    db.close();
  });

  it('counts only Ethereum-final receipts as successful', () => {
    const db = fixture();
    db.prepare("INSERT INTO contract (id, chain_profile_id, address, kind) VALUES ('contract-final', 'chain', '0xdef', 'nft')").run();
    db.prepare("INSERT INTO collection (id, contract_id, name) VALUES ('collection-final', 'contract-final', 'Finality')").run();
    db.prepare("INSERT INTO \"drop\" (id, collection_id, strategy, mint_price_wei, observed_at) VALUES ('drop-final', 'collection-final', 'test', '0', '2026-01-01T00:00:00.000Z')").run();
    db.prepare("INSERT INTO campaign (id, drop_id, state, created_at) VALUES ('campaign-final', 'drop-final', 'prepared', '2026-01-01T00:00:00.000Z')").run();
    db.prepare("INSERT INTO campaign_wallet (campaign_id, wallet_id, enabled, selected_at) VALUES ('campaign-final', 'wallet', 1, '2026-01-01T00:00:00.000Z')").run();
    const repository = new DurableRepository(db);
    repository.saveIntent({ id: 'intent-final', campaignId: 'campaign-final', walletId: 'wallet', intentClass: 'mint', toAddress: '0xdef', valueWei: 0n, calldata: '0x', createdAt: '2026-01-01T00:00:00.000Z' });
    repository.recordAttempt({ id: 'attempt-final', transactionIntentId: 'intent-final', endpoint: 'sequencer', responseClass: 'accepted', txHash: '0xfinal', attemptedAt: '2026-01-01T00:00:01.000Z' });
    expect(() => repository.recordReceipt({ id: 'receipt-soft', transactionAttemptId: 'attempt-final', txHash: '0xfinal', status: 'confirmed', confirmations: 1, finalityStage: 'soft', observedAt: '2026-01-01T00:00:02.000Z' })).toThrow('enabled-chain finality');
    repository.recordReceipt({ id: 'receipt-final', transactionAttemptId: 'attempt-final', txHash: '0xfinal', status: 'confirmed', confirmations: 10, finalityStage: 'ethereum_final', observedAt: '2026-01-01T00:00:03.000Z' });
    expect(repository.isFinalSuccess('chain', 'receipt-final')).toBe(true);
    repository.recordReceipt({ id: 'receipt-reorged', transactionAttemptId: 'attempt-final', txHash: '0xfinal', status: 'reorged', confirmations: 0, finalityStage: 'soft', observedAt: '2026-01-01T00:00:04.000Z' });
    expect(repository.isFinalSuccess('chain', 'receipt-final')).toBe(false);
    expect(repository.isFinalSuccess('chain', 'receipt-reorged')).toBe(false);
    expect(() => repository.recordReceipt({ id: 'receipt-invalid-finality', transactionAttemptId: 'attempt-final', txHash: '0xfinal', status: 'reverted', confirmations: 0, finalityStage: 'ethereum_final', observedAt: '2026-01-01T00:00:05.000Z' })).toThrow('receipt status and finality are inconsistent');
    db.close();
  });

  it('recovers reservations, intents, and audit while kill switch remains engaged', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mint-recovery-'));
    const source = fixture();
    source.prepare("INSERT INTO contract (id, chain_profile_id, address, kind) VALUES ('contract-recovery', 'chain', '0xdef', 'nft')").run();
    source.prepare("INSERT INTO collection (id, contract_id, name) VALUES ('collection-recovery', 'contract-recovery', 'Recovery')").run();
    source.prepare("INSERT INTO \"drop\" (id, collection_id, strategy, mint_price_wei, observed_at) VALUES ('drop-recovery', 'collection-recovery', 'test', '0', '2026-01-01T00:00:00.000Z')").run();
    source.prepare("INSERT INTO campaign (id, drop_id, state, created_at) VALUES ('campaign-recovery', 'drop-recovery', 'prepared', '2026-01-01T00:00:00.000Z')").run();
    source.prepare("INSERT INTO campaign_wallet (campaign_id, wallet_id, enabled, selected_at) VALUES ('campaign-recovery', 'wallet', 1, '2026-01-01T00:00:00.000Z')").run();
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
    db.prepare("INSERT INTO campaign_wallet (campaign_id, wallet_id, enabled, selected_at) VALUES ('campaign-store', 'wallet', 1, '2026-01-01T00:00:00.000Z')").run();
    db.prepare("INSERT INTO fee_policy (id, chain_profile_id, version, priority_fee_semantics, max_total_fee_wei, free_mint_total_fee_cap_wei, free_mint_priority_fee_component_wei, free_mint_priority_fee_multiplier, paid_mints_enabled, active, created_at, zero_priority_fee_policy) VALUES ('fee-store', 'chain', 'v1', 'fee_only', '1000', '1000', '10', 2, 0, 1, '2026-01-01T00:00:00.000Z', 'allowed')").run();
    const store = new SqliteBackendStore(db);
    store.saveIntent({ id: 'intent-store', campaignId: 'campaign-store', walletId: 'wallet', intentClass: 'mint', toAddress: '0xdef', valueWei: 0n, calldata: '0x', createdAt: '2026-01-01T00:00:00.000Z' });
    store.recordAttempt({ id: 'attempt-store', transactionIntentId: 'intent-store', endpoint: 'sequencer', responseClass: 'accepted', txHash: '0xstore', nonce: 1, attemptedAt: '2026-01-01T00:00:01.000Z' });
    store.saveExecution({ id: 'execution-store', campaignId: 'campaign-store', walletId: 'wallet', transactionIntentId: 'intent-store', state: 'submitted', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:01.000Z' });
    expect(store.pendingReconciliation()).toMatchObject([{ executionId: 'execution-store', attemptId: 'attempt-store', txHash: '0xstore', nonce: 1 }]);
    expect(store.reserveExecution({ id: 'reservation-store', walletId: 'wallet', chainProfileId: 'chain', campaignId: 'campaign-store', mintPeriodId: 'campaign:campaign-store', executionId: 'execution-store', transactionIntentId: 'intent-store', idempotencyKey: 'store-key', policyId: 'policy', mintValueWei: 0n, l2ExecutionGasWei: 10n, l1DataGasWei: 5n, priorityFeeComponentWei: 0n, freeMint: true, at: new Date('2026-01-01T00:00:00.000Z') })).toBe('reserved');
    store.setKillSwitch(true, 'backend-test');
    expect(() => store.reserveExecution({ id: 'blocked-store', walletId: 'wallet', chainProfileId: 'chain', campaignId: 'campaign-store', mintPeriodId: 'campaign:campaign-store', executionId: 'execution-store', transactionIntentId: 'intent-store', idempotencyKey: 'blocked-key', policyId: 'policy', mintValueWei: 0n, l2ExecutionGasWei: 1n, l1DataGasWei: 0n, priorityFeeComponentWei: 0n, freeMint: true, at: new Date('2026-01-01T00:00:00.000Z') })).toThrow('kill switch engaged');
    expect(store.isKillSwitchEngaged()).toBe(true);
    db.close();
  });

  it('upgrades a 001-009 database without losing legacy rows', () => {
    const db = legacyFixture();
    migrate(db);
    migrate(db);
    expect(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()).toEqual({ count: 21 });
    expect(db.prepare('SELECT reserved_amount_wei, request_fingerprint FROM spend_reservation WHERE id = ?').get('legacy-reservation')).toMatchObject({ reserved_amount_wei: '10' });
    expect(db.prepare('SELECT execution_enabled, success_finality_stage FROM chain_profile WHERE id = ?').get('legacy-chain')).toEqual({ execution_enabled: 0, success_finality_stage: 'ethereum_final' });
    db.close();
  });

  it('persists run and intent identity with fingerprint conflict semantics', () => {
    const db = fixture();
    const campaignId = campaignFixture(db, 'identity');
    const repository = new DurableRepository(db);
    const run = { id: 'run-identity', requestId: 'request-identity', campaignId, state: 'prepared' as const, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
    const runFingerprint = computeRequestFingerprint({ requestId: run.requestId, requestPayload: null, campaignId, state: run.state, actor: 'system', source: 'database', reason: null });
    repository.saveRun({ ...run, requestFingerprint: runFingerprint });
    repository.saveRun({ ...run, id: 'run-retry', requestFingerprint: runFingerprint, updatedAt: '2026-01-01T00:00:01.000Z' });
    expect(() => repository.saveRun({ ...run, id: 'run-conflict', requestFingerprint: 'different', updatedAt: '2026-01-01T00:00:01.000Z' })).toThrow(IdempotencyConflictError);
    const intent = { id: 'intent-identity', campaignId, walletId: 'wallet', intentClass: 'mint', toAddress: '0xdef', valueWei: 1n, calldata: '0x1234', nonce: 7, chainProfileId: 'chain', fromAddress: '0xabc', gasLimitWei: 100n, maxFeePerGasWei: 10n, maxPriorityFeePerGasWei: 2n, idempotencyKey: 'intent-request', requestId: 'intent-request', runId: 'run-identity', createdAt: '2026-01-01T00:00:00.000Z' };
    repository.saveIntent(intent);
    repository.saveIntent({ ...intent, id: 'intent-retry' });
    expect(db.prepare('SELECT COUNT(*) AS count FROM transaction_intent WHERE idempotency_key = ?').get('intent-request')).toEqual({ count: 1 });
    expect(() => repository.saveIntent({ ...intent, id: 'intent-conflict', calldata: '0xbeef' })).toThrow(IdempotencyConflictError);
    repository.saveExecution({ id: 'execution-identity', campaignId, walletId: 'wallet', transactionIntentId: 'intent-identity', runId: 'run-identity', state: 'prepared', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
    repository.recordAttempt({ id: 'attempt-identity', transactionIntentId: 'intent-identity', endpoint: 'test', responseClass: 'accepted', txHash: '0xidentity', executionId: 'execution-identity', attemptedAt: '2026-01-01T00:00:01.000Z' });
    expect(db.prepare('SELECT run_id, request_fingerprint, from_address, chain_profile_id FROM transaction_intent WHERE id = ?').get('intent-identity')).toMatchObject({ run_id: 'run-identity', from_address: '0xabc', chain_profile_id: 'chain' });
    expect(db.prepare('SELECT execution_id FROM transaction_attempt WHERE id = ?').get('attempt-identity')).toEqual({ execution_id: 'execution-identity' });
    db.close();
  });

  it('scopes run-level request IDs by wallet for multi-wallet admissions', () => {
    const db = fixture();
    const campaignId = campaignFixture(db, 'multi-wallet');
    db.prepare("INSERT INTO wallet (id, chain_profile_id, address, key_reference, created_at) VALUES ('wallet-two', 'chain', '0xdef', 'reference-only', '2026-01-01T00:00:00.000Z')").run();
    db.prepare("INSERT INTO campaign_wallet (campaign_id, wallet_id, enabled, selected_at) VALUES (?, 'wallet-two', 1, '2026-01-01T00:00:00.000Z')").run(campaignId);
    const repository = new DurableRepository(db);
    repository.saveIntent({ id: 'intent-wallet-one', campaignId, walletId: 'wallet', intentClass: 'mint', toAddress: '0xcontract', valueWei: 1n, calldata: '0x01', idempotencyKey: 'intent-wallet-one-key', requestId: 'shared-run-request', chainProfileId: 'chain', createdAt: '2026-01-01T00:00:00.000Z' });
    repository.saveIntent({ id: 'intent-wallet-two', campaignId, walletId: 'wallet-two', intentClass: 'mint', toAddress: '0xcontract', valueWei: 1n, calldata: '0x01', idempotencyKey: 'intent-wallet-two-key', requestId: 'shared-run-request', chainProfileId: 'chain', createdAt: '2026-01-01T00:00:00.000Z' });
    expect(db.prepare('SELECT COUNT(*) AS count FROM transaction_intent WHERE request_id = ?').get('shared-run-request')).toEqual({ count: 2 });
    expect(() => repository.saveIntent({ id: 'intent-wallet-two-conflict', campaignId, walletId: 'wallet-two', intentClass: 'mint', toAddress: '0xcontract', valueWei: 2n, calldata: '0x02', idempotencyKey: 'intent-wallet-two-key-2', requestId: 'shared-run-request', chainProfileId: 'chain', createdAt: '2026-01-01T00:00:00.000Z' })).toThrow(IdempotencyConflictError);
    db.close();
  });

  it('reserves paid Ethereum all-in exposure and settles bounded components into the ledger', () => {
    const db = fixture();
    db.prepare("UPDATE spend_policy SET daily_cap_wei = '1000' WHERE id = 'policy'").run();
    const campaignId = campaignFixture(db, 'paid');
    db.prepare("INSERT INTO fee_policy (id, chain_profile_id, version, priority_fee_semantics, max_total_fee_wei, free_mint_total_fee_cap_wei, free_mint_priority_fee_component_wei, free_mint_priority_fee_multiplier, paid_mints_enabled, active, created_at, zero_priority_fee_policy) VALUES ('paid-fee', 'chain', 'paid-v1', 'ordering', '1000', '1000', '10', 2, 1, 1, '2026-01-01T00:00:00.000Z', 'allowed')").run();
    const reservations = new SpendReservations(db);
    const paidExecution = linkedExecutionFixture(db, campaignId, 'paid', 'chain', 'wallet', 100n);
    const input = { walletId: 'wallet', chainProfileId: 'chain', campaignId, mintPeriodId: `campaign:${campaignId}`, ...paidExecution, policyId: 'policy', freeMint: false, mintValueWei: 100n, l2ExecutionGasWei: 20n, l1DataGasWei: 10n, priorityFeeComponentWei: 5n, replacementBudgetWei: 7n, mintValueBufferWei: 3n, l2ExecutionGasBufferWei: 2n, l1DataGasBufferWei: 1n, priorityFeeBufferWei: 1n, at: new Date('2026-01-01T00:00:00.000Z') };
    expect(reservations.reserveExecution({ ...input, id: 'paid-reservation', idempotencyKey: 'paid-key' })).toBe('reserved');
    expect(db.prepare('SELECT amount_wei, reserved_amount_wei, mint_value_wei, l2_execution_gas_wei, l1_data_gas_wei, priority_fee_component_wei, replacement_budget_wei FROM spend_reservation WHERE id = ?').get('paid-reservation')).toEqual({ amount_wei: '149', reserved_amount_wei: '149', mint_value_wei: '100', l2_execution_gas_wei: '20', l1_data_gas_wei: '10', priority_fee_component_wei: '5', replacement_budget_wei: '7' });
    const repository = new DurableRepository(db);
    repository.recordAttempt({ id: 'attempt-paid', transactionIntentId: paidExecution.intentId, endpoint: 'test', responseClass: 'accepted', txHash: '0xpaid', executionId: paidExecution.executionId, attemptedAt: '2026-01-01T00:00:01.000Z' });
    repository.recordReceipt({ id: 'receipt-paid', transactionAttemptId: 'attempt-paid', txHash: '0xpaid', status: 'confirmed', confirmations: 10, finalityStage: 'ethereum_final', observedAt: '2026-01-01T00:00:01.500Z' });
    expect(() => reservations.settleExecutionComponents('paid-reservation', { actualMintValueWei: 104n, actualL2ExecutionGasWei: 20n, actualL1DataGasWei: 10n })).toThrow('settled amount exceeds reservation bound');
    reservations.settleExecutionComponents('paid-reservation', { actualMintValueWei: 90n, actualL2ExecutionGasWei: 15n, actualL1DataGasWei: 8n, actualPriorityFeeComponentWei: 4n, actualReplacementBudgetWei: 5n }, new Date('2026-01-01T00:00:02.000Z'));
    expect(db.prepare('SELECT status, amount_wei, settled_amount_wei, settled_priority_fee_component_wei, settled_replacement_budget_wei FROM spend_reservation WHERE id = ?').get('paid-reservation')).toEqual({ status: 'settled', amount_wei: '122', settled_amount_wei: '122', settled_priority_fee_component_wei: '4', settled_replacement_budget_wei: '5' });
    expect(db.prepare('SELECT component, amount_wei FROM spend_ledger_entry WHERE reservation_id = ? ORDER BY component').all('paid-reservation')).toHaveLength(6);
    expect(db.prepare('SELECT SUM(CAST(amount_wei AS INTEGER)) AS amount FROM spend_ledger_entry WHERE reservation_id = ? AND component <> \'refund\'').get('paid-reservation')).toEqual({ amount: 122 });
    db.close();
  });

  it('keeps paid Robinhood blocked independently of fee configuration', () => {
    const db = fixture();
    db.prepare("INSERT INTO chain_profile (id, chain_id, name, rpc_endpoints_json, confirmation_depth, created_at) VALUES ('robinhood-disabled', 4663, 'Robinhood Chain', '[]', 0, '2026-01-01T00:00:00.000Z')").run();
    db.prepare("INSERT INTO wallet (id, chain_profile_id, address, key_reference, created_at) VALUES ('robinhood-wallet', 'robinhood-disabled', '0xrh', 'reference-only', '2026-01-01T00:00:00.000Z')").run();
    db.prepare("INSERT INTO spend_policy (id, wallet_id, daily_cap_wei, version, active) VALUES ('robinhood-policy', 'robinhood-wallet', '1000', 'v1', 1)").run();
    const campaignId = campaignFixture(db, 'rh', 'robinhood-disabled');
    db.prepare("INSERT INTO fee_policy (id, chain_profile_id, version, priority_fee_semantics, max_total_fee_wei, free_mint_total_fee_cap_wei, free_mint_priority_fee_component_wei, free_mint_priority_fee_multiplier, paid_mints_enabled, active, created_at, zero_priority_fee_policy) VALUES ('rh-fee', 'robinhood-disabled', 'v1', 'fee_only', '1000', '1000', '1', 2, 1, 1, '2026-01-01T00:00:00.000Z', 'allowed')").run();
    const reservations = new SpendReservations(db);
    const request = { id: 'rh-paid', walletId: 'robinhood-wallet', chainProfileId: 'robinhood-disabled', campaignId, policyId: 'robinhood-policy', idempotencyKey: 'rh-paid-key', freeMint: false, mintValueWei: 1n, l2ExecutionGasWei: 1n, l1DataGasWei: 1n, priorityFeeComponentWei: 1n };
    expect(() => reservations.reserveExecution(request)).toThrow('paid Robinhood mints are blocked');
    expect(() => reservations.reserveExecution({ ...request, id: 'rh-free', idempotencyKey: 'rh-free-key', freeMint: true, mintValueWei: 0n })).toThrow('Robinhood execution is disabled');
    db.close();
  });

  it('requires verified and explicitly enabled chains before reservation admission', () => {
    const db = fixture();
    db.prepare("UPDATE chain_profile SET verification_status = 'unverified', execution_enabled = 0 WHERE id = 'chain'").run();
    const campaignId = campaignFixture(db, 'admission');
    const execution = linkedExecutionFixture(db, campaignId, 'admission');
    db.prepare("INSERT INTO fee_policy (id, chain_profile_id, version, priority_fee_semantics, max_total_fee_wei, free_mint_total_fee_cap_wei, free_mint_priority_fee_component_wei, free_mint_priority_fee_multiplier, paid_mints_enabled, active, created_at, zero_priority_fee_policy) VALUES ('admission-fee', 'chain', 'v1', 'fee_only', '1000', '1000', '1', 2, 1, 1, '2026-01-01T00:00:00.000Z', 'allowed')").run();
    const reservations = new SpendReservations(db);
    const request = { id: 'admission-reservation', walletId: 'wallet', chainProfileId: 'chain', campaignId, ...execution, policyId: 'policy', mintPeriodId: `campaign:${campaignId}`, idempotencyKey: 'admission-key', freeMint: true, mintValueWei: 0n, l2ExecutionGasWei: 1n, l1DataGasWei: 1n, priorityFeeComponentWei: 1n };
    expect(() => reservations.reserveExecution(request)).toThrow('chain execution is not enabled or verified');
    const repository = new DurableRepository(db);
    repository.recordChainVerification({ id: 'admission-verification', chainProfileId: 'chain', status: 'verified', chainId: 1, executionEnabled: true, approvedBy: 'product-owner', approvedAt: '2026-01-01T00:00:00.000Z', evidence: { finalityPassed: true, confirmationDepth: 2 }, checkedAt: '2026-01-01T00:00:00.000Z' });
    expect(reservations.reserveExecution(request)).toBe('reserved');
    expect(db.prepare('SELECT verification_status, execution_enabled FROM chain_profile WHERE id = ?').get('chain')).toEqual({ verification_status: 'verified', execution_enabled: 1 });
    db.close();
  });

  it('exposes recovery projections and protects canonical append-only facts', () => {
    const db = fixture();
    const campaignId = campaignFixture(db, 'recovery');
    const repository = new DurableRepository(db);
    repository.saveIntent({ id: 'intent-recovery-view', campaignId, walletId: 'wallet', intentClass: 'mint', toAddress: '0xdef', valueWei: 0n, calldata: '0x', chainProfileId: 'chain', createdAt: '2026-01-01T00:00:00.000Z' });
    repository.saveExecution({ id: 'execution-recovery-view', campaignId, walletId: 'wallet', transactionIntentId: 'intent-recovery-view', state: 'submitted', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:01.000Z' });
    repository.recordAttempt({ id: 'attempt-recovery-view', transactionIntentId: 'intent-recovery-view', endpoint: 'test', responseClass: 'accepted', txHash: '0xrecovery', nonce: 7, attemptedAt: '2026-01-01T00:00:02.000Z' });
    repository.recordAttempt({ id: 'attempt-recovery-replacement', transactionIntentId: 'intent-recovery-view', endpoint: 'test', responseClass: 'accepted', txHash: '0xreplacement', nonce: 7, replacementOfId: 'attempt-recovery-view', attemptedAt: '2026-01-01T00:00:02.500Z' });
    expect(() => db.prepare("UPDATE transaction_attempt SET response_class = 'changed' WHERE id = 'attempt-recovery-view'").run()).toThrow('transaction attempts are append-only');
    repository.recordReceipt({ id: 'receipt-recovery-view', transactionAttemptId: 'attempt-recovery-view', txHash: '0xrecovery', status: 'reorged', confirmations: 0, finalityStage: 'soft', observedAt: '2026-01-01T00:00:03.000Z' });
    repository.recordReconciliation({ id: 'reconciliation-recovery-view', chainProfileId: 'chain', transactionAttemptId: 'attempt-recovery-view', txHash: '0xrecovery', fromAddress: '0xabc', nonce: 7, state: 'reorged', source: 'test', policyVersion: 'reconciliation-v1', details: { sourceEvidence: 'receipt-and-attempt' }, checkedAt: '2026-01-01T00:00:04.000Z' });
    repository.recordReorgEvent({ id: 'reorg-recovery-view', chainProfileId: 'chain', transactionAttemptId: 'attempt-recovery-view', executionId: 'execution-recovery-view', previousFinalityStage: 'ethereum_final', newFinalityStage: 'soft', detectedAt: '2026-01-01T00:00:04.500Z' });
    expect(() => db.prepare("DELETE FROM transaction_receipt WHERE id = 'receipt-recovery-view'").run()).toThrow('transaction receipts are append-only');
    db.prepare("INSERT INTO raw_observation (id, source, observed_at, payload_json, deduplication_key) VALUES ('stale-simulation-observation', 'watcher', '2026-01-01T00:00:00.000Z', '{}', 'stale-simulation-observation')").run();
    repository.recordSimulation({ id: 'stale-simulation', walletId: 'wallet', campaignId, transactionIntentId: 'intent-recovery-view', sourceBlockNumber: 1, checkedAt: '2026-01-01T00:00:00.000Z', freshnessSeconds: 300, outcome: 'pass', toolVersion: 'test' });
    const reservations = new SpendReservations(db);
    reservations.reserve({ id: 'orphan-recovery', walletId: 'wallet', idempotencyKey: 'orphan-recovery', policyId: 'policy', amountWei: 10n, at: new Date('2026-01-01T00:00:00.000Z') });
    const models = new ReadModels(db);
    expect(models.pendingReconciliation().some((row) => row.executionId === 'execution-recovery-view' && row.attemptId === 'attempt-recovery-view' && row.reconciliationState === 'reorged')).toBe(true);
    expect(models.reorgExposure()).toMatchObject([{ executionId: 'execution-recovery-view', attemptId: 'attempt-recovery-view', finalityStage: 'soft', reconciliationState: 'reorged', reorgEventId: 'reorg-recovery-view' }]);
    expect(models.replacementExposure()).toMatchObject([{ attemptId: 'attempt-recovery-replacement', replacementOfId: 'attempt-recovery-view', reconciliationState: 'unresolved' }]);
    repository.recordReorgResolution({ id: 'reorg-resolution-recovery-view', reorgEventId: 'reorg-recovery-view', state: 'resolved', reason: 'replacement retained as recovery work item', resolvedAt: '2026-01-01T00:00:05.000Z' });
    expect(models.reorgExposure()).toHaveLength(0);
    expect(models.orphanReservations()).toMatchObject([{ reservationId: 'orphan-recovery' }]);
    expect(models.staleSimulations(new Date('2026-01-02T00:00:00.000Z'))).toMatchObject([{ simulationId: 'stale-simulation' }]);
    db.prepare("INSERT INTO transaction_intent (id, campaign_id, wallet_id, intent_class, to_address, value_wei, calldata, created_at) VALUES ('intent-recovery-view-2', ?, 'wallet', 'mint', '0xdef', '0', '0x', '2026-01-01T00:00:00.000Z')").run(campaignId);
    repository.recordAttempt({ id: 'attempt-recovery-view-3', transactionIntentId: 'intent-recovery-view-2', endpoint: 'test', responseClass: 'accepted', txHash: '0xrecovery3', nonce: 7, attemptedAt: '2026-01-01T00:00:05.000Z' });
    expect(models.duplicateNonceIdentities()).toMatchObject([{ fromAddress: '0xabc', nonce: 7, intentCount: 2 }]);
    expect(() => db.prepare("INSERT INTO campaign (id, drop_id, state, created_at) VALUES ('invalid-campaign-state', 'drop-recovery', 'not-a-state', '2026-01-01T00:00:00.000Z')").run()).toThrow('campaigns must be created in draft state');
    db.close();
  });

  it('records retention evidence alongside backup verification evidence', () => {
    const db = fixture();
    const repository = new DurableRepository(db);
    repository.recordRetentionEvidence({ id: 'retention-evidence', policyId: 'raw-observation-30d', entityType: 'raw_observation', cutoffAt: '2026-01-01T00:00:00.000Z', rowsDeleted: 3, rowsRetained: 1, outcome: 'passed', recordedAt: '2026-01-01T00:00:01.000Z' });
    expect(db.prepare('SELECT entity_type, rows_deleted, rows_retained, outcome FROM retention_evidence WHERE id = ?').get('retention-evidence')).toEqual({ entity_type: 'raw_observation', rows_deleted: 3, rows_retained: 1, outcome: 'passed' });
    expect(db.prepare('SELECT retention_days, retain_indefinitely FROM retention_policy WHERE entity_type = ?').get('raw_observation')).toEqual({ retention_days: 30, retain_indefinitely: 0 });
    repository.recordBackupRestoreEvidence({ id: 'backup-evidence-integrity', storeReference: 's3://test/store', backupReference: 's3://test/backup', sha256: 'a'.repeat(64), schemaVersion: 21, operation: 'verification', outcome: 'passed', killSwitchEngaged: true, encryptionVerified: true, integrityCheck: 'ok', verificationSha256: 'a'.repeat(64), evidence: { offHost: true, restoreVerified: true, postRestoreReconciliation: true, retentionDays: 30 }, recordedAt: '2026-01-01T00:00:02.000Z' });
    expect(db.prepare('SELECT encryption_verified, integrity_check FROM backup_restore_evidence WHERE id = ?').get('backup-evidence-integrity')).toEqual({ encryption_verified: 1, integrity_check: 'ok' });
    expect(() => repository.recordAuditEvent({ id: 'secret-audit', entityType: 'run', entityId: 'run', actor: 'test', reason: 'secret boundary', policySnapshot: { privateKey: 'not-written' }, occurredAt: '2026-01-01T00:00:03.000Z' })).toThrow('approved secret store');
    expect(() => db.prepare("UPDATE retention_evidence SET rows_deleted = 4 WHERE id = 'retention-evidence'").run()).toThrow('retention evidence is append-only');
    db.close();
  });

  it('rejects reservation lineage mismatches and releases only before submission', () => {
    const db = fixture();
    const campaignId = campaignFixture(db, 'lineage');
    db.prepare("INSERT INTO fee_policy (id, chain_profile_id, version, priority_fee_semantics, max_total_fee_wei, free_mint_total_fee_cap_wei, free_mint_priority_fee_component_wei, free_mint_priority_fee_multiplier, paid_mints_enabled, active, created_at, zero_priority_fee_policy) VALUES ('lineage-fee', 'chain', 'v1', 'fee_only', '1000', '1000', '1', 2, 0, 1, '2026-01-01T00:00:00.000Z', 'allowed')").run();
    const first = linkedExecutionFixture(db, campaignId, 'lineage');
    const reservations = new SpendReservations(db);
    const request = { id: 'lineage-reservation', walletId: 'wallet', chainProfileId: 'chain', campaignId, ...first, policyId: 'policy', mintPeriodId: `campaign:${campaignId}`, idempotencyKey: 'lineage-key', freeMint: true, mintValueWei: 0n, l2ExecutionGasWei: 1n, l1DataGasWei: 1n, priorityFeeComponentWei: 1n };
    expect(reservations.reserveExecution(request)).toBe('reserved');
    expect(() => reservations.reserveExecution({ ...request, id: 'lineage-duplicate', idempotencyKey: 'lineage-duplicate-key' })).toThrow('execution already has a reservation');
    expect(() => reservations.transition('lineage-reservation', 'released')).not.toThrow();
    const campaignSubmitted = campaignFixture(db, 'lineage-submitted');
    const submitted = linkedExecutionFixture(db, campaignSubmitted, 'lineage-submitted');
    reservations.reserveExecution({ ...request, ...submitted, id: 'lineage-submitted-reservation', campaignId: campaignSubmitted, mintPeriodId: `campaign:${campaignSubmitted}`, idempotencyKey: 'lineage-submitted-key' });
    const repository = new DurableRepository(db);
    repository.recordAttempt({ id: 'lineage-submitted-attempt', transactionIntentId: submitted.intentId, executionId: submitted.executionId, endpoint: 'test', responseClass: 'accepted', txHash: '0xlineage', attemptedAt: '2026-01-01T00:00:01.000Z' });
    expect(() => reservations.transition('lineage-submitted-reservation', 'released')).toThrow('submitted reservations cannot be released');
    expect(() => reservations.reserveExecution({ ...request, id: 'lineage-mismatch', idempotencyKey: 'lineage-mismatch-key', transactionIntentId: submitted.intentId, executionId: submitted.executionId })).toThrow('reservation execution and intent linkage mismatch');
    expect(() => reservations.reserveExecution({ ...request, id: 'lineage-value-mismatch', idempotencyKey: 'lineage-value-mismatch-key', mintValueWei: 1n })).toThrow('reservation mint value does not match transaction intent');
    db.close();
  });

  it('uses configured policy timezones and measures policy-driven retention', () => {
    const db = fixture();
    db.prepare("UPDATE spend_policy SET timezone = 'America/New_York' WHERE id = 'policy'").run();
    const campaignId = campaignFixture(db, 'timezone');
    const execution = linkedExecutionFixture(db, campaignId, 'timezone');
    db.prepare("INSERT INTO fee_policy (id, chain_profile_id, version, priority_fee_semantics, max_total_fee_wei, free_mint_total_fee_cap_wei, free_mint_priority_fee_component_wei, free_mint_priority_fee_multiplier, paid_mints_enabled, active, created_at, zero_priority_fee_policy) VALUES ('timezone-fee', 'chain', 'v1', 'fee_only', '1000', '1000', '1', 2, 0, 1, '2026-01-01T00:00:00.000Z', 'allowed')").run();
    new SpendReservations(db).reserveExecution({ id: 'timezone-reservation', walletId: 'wallet', chainProfileId: 'chain', campaignId, ...execution, policyId: 'policy', mintPeriodId: `campaign:${campaignId}`, idempotencyKey: 'timezone-key', freeMint: true, mintValueWei: 0n, l2ExecutionGasWei: 1n, l1DataGasWei: 1n, priorityFeeComponentWei: 1n, at: new Date('2026-01-02T01:00:00.000Z') });
    expect(db.prepare('SELECT usage_date FROM spend_reservation WHERE id = ?').get('timezone-reservation')).toEqual({ usage_date: '2026-01-01' });
    db.prepare("INSERT INTO raw_observation (id, source, observed_at, payload_json, deduplication_key) VALUES ('retention-old', 'test', '2020-01-01T00:00:00.000Z', '{}', 'retention-old')").run();
    expect(pruneRawObservations(db, new Date('2025-01-01T00:00:00.000Z'))).toBe(1);
    expect(db.prepare("SELECT rows_deleted, outcome FROM retention_evidence WHERE entity_type = 'raw_observation' ORDER BY recorded_at DESC LIMIT 1").get()).toEqual({ rows_deleted: 1, outcome: 'passed' });
    expect(() => pruneRawObservations(db, new Date('2026-09-01T00:00:00.000Z'))).toThrow('retention cutoff exceeds');
    db.close();
  });

  it('maps opportunity evidence and rejects fingerprint or backup evidence forgery', () => {
    const db = fixture();
    db.prepare("INSERT INTO opportunity (id, chain_profile_id, fingerprint, disposition, score, created_at) VALUES ('opportunity-map', 'chain', 'fingerprint-map', 'discovered', 4.5, '2026-01-01T00:00:00.000Z')").run();
    db.prepare("INSERT INTO signal (id, opportunity_id, source, signal_type, value_json, observed_at) VALUES ('signal-map', 'opportunity-map', 'test', 'score', '{}', '2026-01-01T00:00:00.000Z')").run();
    expect(new ReadModels(db).opportunityEvidence()).toEqual([{ opportunityId: 'opportunity-map', fingerprint: 'fingerprint-map', disposition: 'discovered', score: 4.5, freshnessAt: null, signalCount: 1 }]);
    const repository = new DurableRepository(db);
    const campaignId = campaignFixture(db, 'fingerprint');
    expect(() => repository.saveIntent({ id: 'fingerprint-intent', campaignId, walletId: 'wallet', intentClass: 'mint', toAddress: '0xdef', valueWei: 0n, calldata: '0x', requestFingerprint: 'not-a-computed-fingerprint', createdAt: '2026-01-01T00:00:00.000Z' })).toThrow(IdempotencyConflictError);
    expect(() => repository.recordBackupRestoreEvidence({ id: 'forged-backup', storeReference: 'store', backupReference: 'backup', sha256: 'a'.repeat(64), schemaVersion: 21, operation: 'verification', outcome: 'passed', killSwitchEngaged: false, recordedAt: '2026-01-01T00:00:00.000Z' })).toThrow('passed backup evidence requires encrypted');
    db.close();
  });

  it('detects migration checksum drift before applying further changes', () => {
    const db = fixture();
    db.prepare("UPDATE schema_migrations SET checksum = 'bad' WHERE version = 15").run();
    expect(() => migrate(db)).toThrow('migration 15 checksum mismatch');
    db.close();
  });

  it('evaluates stale simulations against the requested recovery time', () => {
    const db = fixture();
    const campaignId = campaignFixture(db, 'stale-as-of');
    const { intentId } = linkedExecutionFixture(db, campaignId, 'stale-as-of');
    const checkedAt = new Date().toISOString();
    new DurableRepository(db).recordSimulation({ id: 'future-stale-simulation', walletId: 'wallet', campaignId, transactionIntentId: intentId, sourceBlockNumber: 1, checkedAt, freshnessSeconds: 3600, outcome: 'pass', toolVersion: 'test' });
    const models = new ReadModels(db);
    expect(models.staleSimulations(new Date(Date.parse(checkedAt) + 1800 * 1000))).toEqual([]);
    expect(models.staleSimulations(new Date(Date.parse(checkedAt) + 3601 * 1000))).toMatchObject([{ simulationId: 'future-stale-simulation' }]);
    const scopedCampaignId = campaignFixture(db, 'stale-as-of-scoped');
    new DurableRepository(db).recordSimulation({ id: 'future-stale-scoped-simulation', walletId: 'wallet', campaignId: scopedCampaignId, sourceBlockNumber: 1, checkedAt, freshnessSeconds: 3600, outcome: 'pass', toolVersion: 'test' });
    expect(models.staleSimulations(new Date(Date.parse(checkedAt) + 3601 * 1000))).toEqual(expect.arrayContaining([expect.objectContaining({ simulationId: 'future-stale-scoped-simulation', transactionIntentId: null })]));
    const futureSimulationCampaignId = campaignFixture(db, 'stale-as-of-future');
    const futureIntent = linkedExecutionFixture(db, futureSimulationCampaignId, 'stale-as-of-future').intentId;
    const historicalCheckedAt = new Date(Date.now() - 7200 * 1000).toISOString();
    new DurableRepository(db).recordSimulation({ id: 'stale-as-of-old-simulation', walletId: 'wallet', campaignId: futureSimulationCampaignId, transactionIntentId: futureIntent, sourceBlockNumber: 1, checkedAt: historicalCheckedAt, freshnessSeconds: 300, outcome: 'pass', toolVersion: 'test' });
    new DurableRepository(db).recordSimulation({ id: 'stale-as-of-future-simulation', walletId: 'wallet', campaignId: futureSimulationCampaignId, transactionIntentId: futureIntent, sourceBlockNumber: 2, checkedAt: new Date(Date.parse(historicalCheckedAt) + 3600 * 1000).toISOString(), freshnessSeconds: 3600, outcome: 'pass', toolVersion: 'test' });
    expect(models.staleSimulations(new Date(Date.parse(historicalCheckedAt) + 1800 * 1000))).toMatchObject([{ simulationId: 'stale-as-of-old-simulation' }]);
    db.close();
  });

  it('rejects simulations that cross wallet, campaign, or intent boundaries', () => {
    const db = fixture();
    const campaignId = campaignFixture(db, 'simulation-identity');
    const otherCampaignId = campaignFixture(db, 'simulation-identity-other');
    const { intentId } = linkedExecutionFixture(db, campaignId, 'simulation-identity');
    const repository = new DurableRepository(db);
    expect(() => repository.recordSimulation({ id: 'simulation-campaign-mismatch', walletId: 'wallet', campaignId: otherCampaignId, transactionIntentId: intentId, sourceBlockNumber: 1, checkedAt: '2026-01-01T00:00:00.000Z', freshnessSeconds: 300, outcome: 'pass', toolVersion: 'test' })).toThrow('simulation does not match transaction intent');
    expect(() => repository.recordSimulation({ id: 'simulation-invalid-block', walletId: 'wallet', campaignId, sourceBlockNumber: -1, checkedAt: '2026-01-01T00:00:00.000Z', freshnessSeconds: 300, outcome: 'pass', toolVersion: 'test' })).toThrow('simulation source block must be a non-negative integer');
    expect(() => repository.recordSimulation({ id: 'simulation-invalid-time', walletId: 'wallet', campaignId, sourceBlockNumber: 1, checkedAt: 'not-a-date', freshnessSeconds: 300, outcome: 'pass', toolVersion: 'test' })).toThrow('simulation checked time is invalid or in the future');
    expect(() => repository.recordSimulation({ id: 'simulation-future-time', walletId: 'wallet', campaignId, sourceBlockNumber: 1, checkedAt: new Date(Date.now() + 60_000).toISOString(), freshnessSeconds: 300, outcome: 'pass', toolVersion: 'test' })).toThrow('simulation checked time is invalid or in the future');
    db.close();
  });
});
