import { access, constants } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { connect as tcpConnect } from 'node:net';
import { resolve } from 'node:path';
import { connect as tlsConnect } from 'node:tls';
import { loadSecretStore } from './secret-store.mjs';

const require = createRequire(new URL('../packages/database/package.json', import.meta.url));
const Database = require('better-sqlite3');
const checks = {};
const mode = process.env.OPS_HEALTH_MODE ?? 'phase1';
const secretStorePath = process.env.SECRET_STORE_PATH;
const rpcSecretNames = (process.env.RPC_SECRET_NAMES ?? 'ETHEREUM_RPC_URL')
  .split(',').map((name) => name.trim()).filter(Boolean);
const probeTtlMs = Number(process.env.RUNTIME_PROBE_TTL_MS ?? '120000');
const expectedChainId = process.env.EXPECTED_CHAIN_ID ?? (mode === 'robinhood' ? '0x1237' : '0x1');
const storePath = process.env.STORE_PATH;
const killSwitchPath = process.env.KILL_SWITCH_PATH;
const custodyMode = process.env.MINT_BOT_CUSTODY;

let secretStore;
let turnkeySecretStore;
let state;
let databaseKillSwitchEngaged = false;
let unresolvedSubmissionCount = 0;
let durableFinalityEvidence = false;

checks.process = process.platform === 'win32'
  ? { status: 'failed', reason: 'LINUX_RUNTIME_REQUIRED' }
  : { status: 'ok', platform: process.platform };

if (custodyMode === 'turnkey' && process.env.TURNKEY_SECRET_FILE) {
  try {
    turnkeySecretStore = await loadSecretStore(process.env.TURNKEY_SECRET_FILE);
    checks.custody = turnkeySecretStore.get('TURNKEY_ORGANIZATION_ID')
      ? { status: 'ok', provider: 'turnkey' }
      : { status: 'failed', reason: 'TURNKEY_ORGANIZATION_REQUIRED' };
  } catch {
    checks.custody = { status: 'failed', reason: 'TURNKEY_SECRET_FILE_INVALID' };
  }
} else {
  checks.custody = { status: 'failed', reason: custodyMode === 'turnkey' ? 'TURNKEY_SECRET_FILE_REQUIRED' : 'TURNKEY_CUSTODY_REQUIRED' };
}

if (!secretStorePath || /[\r\n]/.test(secretStorePath)) {
  checks.secretStore = { status: 'failed', reason: 'SECRET_STORE_PATH_REQUIRED' };
} else {
  try {
    secretStore = await loadSecretStore(secretStorePath);
    checks.secretStore = { status: 'ok', reference: 'configured' };
  } catch (error) {
    checks.secretStore = { status: 'failed', error: error instanceof Error ? error.name : 'secret_store_error' };
  }
}

const invalidRpcName = rpcSecretNames.find((name) => !/^[A-Z][A-Z0-9_]*$/.test(name));
if (invalidRpcName) {
  checks.rpc = { status: 'failed', reason: 'RPC_SECRET_NAMES_INVALID' };
} else {
  const rpcChecks = [];
  for (const name of rpcSecretNames) {
    const rpc = secretStore?.get(name);
    if (!rpc) continue;
    const started = performance.now();
    try {
      const response = await fetch(rpc, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
        signal: AbortSignal.timeout(3000),
      });
      const body = await response.json();
      rpcChecks.push({ name, status: response.ok && body.result === expectedChainId ? 'ok' : 'failed', chainId: body.result, latencyMs: Math.round(performance.now() - started) });
    } catch (error) {
      rpcChecks.push({ name, status: 'failed', error: error instanceof Error ? error.name : 'rpc_probe_error' });
    }
  }
  checks.rpc = rpcChecks.length > 0 && rpcChecks.every((check) => check.status === 'ok')
    ? { status: 'ok', expectedChainId, endpoints: rpcChecks }
    : { status: 'failed', reason: 'RPC_CHAIN_ID_PROBE_FAILED', expectedChainId, endpoints: rpcChecks };
}

if (!storePath || /[\r\n]/.test(storePath)) {
  checks.store = { status: 'failed', reason: 'STORE_PATH_REQUIRED' };
  checks.migration = { status: 'failed', reason: 'STORE_PROBE_REQUIRED' };
} else {
  try {
    const database = new Database(resolve(storePath), { readonly: true, fileMustExist: true });
    try {
      const integrity = database.pragma('integrity_check', { simple: true });
      if (integrity !== 'ok') throw new Error('sqlite_integrity_failed');
      const migration = database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get();
      const schemaVersion = Number(migration?.version);
      checks.migration = Number.isInteger(schemaVersion) && schemaVersion >= 15
        ? { status: 'ok', version: schemaVersion }
        : { status: 'failed', reason: 'SCHEMA_MIGRATION_REQUIRED' };
      if (checks.migration.status !== 'ok') throw new Error('schema_migration_required');
      const legacyStateTable = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'backend_state'").get();
      if (legacyStateTable) throw new Error('legacy_backend_state_not_supported');
      const runtimeRow = database.prepare('SELECT policy_snapshot_json FROM runtime_readiness_snapshot ORDER BY captured_at DESC, rowid DESC LIMIT 1').get();
      const runtimeSnapshot = parseJson(runtimeRow?.policy_snapshot_json);
      if (!runtimeSnapshot?.runtime) throw new Error('runtime_readiness_snapshot_missing');
      state = { runtime: runtimeSnapshot.runtime };
      const runtimeControl = database.prepare("SELECT kill_switch_engaged FROM runtime_control WHERE id = 'global'").get();
      databaseKillSwitchEngaged = Boolean(state.runtime?.operational?.killSwitchEngaged) || runtimeControl?.kill_switch_engaged === 1;
      const verification = database.prepare("SELECT cp.execution_enabled, cv.status, cv.evidence_json, cv.approved_by, cv.approved_at FROM chain_profile cp JOIN chain_verification cv ON cv.chain_profile_id = cp.id WHERE cp.chain_id = ? ORDER BY cv.checked_at DESC, cv.id DESC LIMIT 1").get(1);
      const verificationEvidence = parseJson(verification?.evidence_json);
      const verificationExpiry = Date.parse(verificationEvidence?.expiresAt ?? '');
      durableFinalityEvidence = verification?.status === 'verified'
        && verification?.approved_by
        && verification?.approved_at
        && verificationEvidence?.finalityPassed === true
        && Number.isFinite(verificationExpiry)
        && verificationExpiry > Date.now();
      const backup = database.prepare("SELECT outcome, kill_switch_engaged, schema_version, encryption_verified, integrity_check, evidence_json, recorded_at FROM backup_restore_evidence WHERE outcome = 'passed' ORDER BY recorded_at DESC LIMIT 1").get();
      const backupEvidence = parseJson(backup?.evidence_json);
      const backupAge = backup?.recorded_at ? Date.now() - Date.parse(backup.recorded_at) : Number.POSITIVE_INFINITY;
      const backupMaxAge = Number(process.env.BACKUP_MAX_AGE_MS ?? String(30 * 24 * 60 * 60 * 1000));
      checks.backup = backup?.kill_switch_engaged === 1
        && Number(backup.schema_version) >= schemaVersion
        && backup.encryption_verified === 1
        && backup.integrity_check === 'ok'
        && backupEvidence?.offHost === true
        && backupEvidence?.restoreVerified === true
        && backupEvidence?.postRestoreReconciliation === true
        && Number(backupEvidence?.retentionDays) >= 30
        && Number.isFinite(backupMaxAge)
        && backupMaxAge > 0
        && backupAge >= 0
        && backupAge <= backupMaxAge
        ? { status: 'ok', evidence: 'recorded', killSwitch: 'engaged' }
        : { status: 'failed', reason: 'BACKUP_EVIDENCE_REQUIRED' };
      const unresolved = database.prepare('SELECT COUNT(*) AS count FROM recovery_unresolved_submissions').get();
      unresolvedSubmissionCount = Number(unresolved?.count ?? 0);
      checks.store = { status: 'ok', integrity: 'ok', schemaVersion, store: 'canonical-sqlite' };
    } finally {
      database.close();
    }
  } catch (error) {
    const reason = error instanceof Error && [
      'legacy_backend_state_not_supported',
      'runtime_readiness_snapshot_missing',
      'schema_migration_required',
    ].includes(error.message)
      ? error.message.toUpperCase()
      : 'STORE_PROBE_FAILED';
    checks.store = { status: 'failed', reason };
    checks.migration ??= { status: 'failed', reason: 'STORE_PROBE_REQUIRED' };
    checks.backup = { status: 'failed', reason: 'STORE_PROBE_REQUIRED' };
  }
}

let fileKillSwitchEngaged = false;
if (!killSwitchPath || /[\r\n]/.test(killSwitchPath)) {
  checks.killSwitch = { status: 'failed', reason: 'KILL_SWITCH_PATH_REQUIRED' };
} else {
  fileKillSwitchEngaged = await access(killSwitchPath, constants.F_OK).then(() => true).catch(() => false);
  const engaged = databaseKillSwitchEngaged || fileKillSwitchEngaged;
  checks.killSwitch = engaged
    ? { status: 'failed', engaged: true }
    : { status: 'ok', engaged: false };
}

checks.engine = await Promise.all([
  access(resolve(process.cwd(), 'packages', 'engine', 'dist', 'index.js'), constants.R_OK),
  access(resolve(process.cwd(), 'packages', 'backend', 'dist', 'index.js'), constants.R_OK),
  access(resolve(process.cwd(), 'packages', 'cli', 'dist', 'index.js'), constants.R_OK),
]).then(() => ({ status: 'ok', artifacts: 3 })).catch(() => ({ status: 'failed', reason: 'BUILD_ARTIFACTS_REQUIRED' }));

checks.chainVerification = state?.runtime?.operational?.chainVerification === 'verified' || checks.rpc.status === 'ok'
  ? { status: 'ok', source: state?.runtime?.operational?.chainVerification === 'verified' ? 'durable_runtime_state' : 'rpc_chain_id' }
  : { status: 'failed', reason: 'CHAIN_VERIFICATION_REQUIRED' };

const reconciliationAt = state?.runtime?.reconciliationCompletedAt
  ?? state?.runtime?.operational?.lastReconciliationAt
  ?? process.env.LAST_RECONCILIATION_AT;
const reconciliationAge = reconciliationAt ? Date.now() - Date.parse(reconciliationAt) : Number.POSITIVE_INFINITY;
checks.reconciliation = unresolvedSubmissionCount === 0
  && Number.isFinite(probeTtlMs) && probeTtlMs > 0 && reconciliationAge >= 0 && reconciliationAge <= probeTtlMs
  ? { status: 'ok', ageMs: reconciliationAge }
  : { status: 'failed', reason: unresolvedSubmissionCount > 0 ? 'UNRESOLVED_SUBMISSIONS_PRESENT' : 'RECONCILIATION_STALE' };

checks.signer = await checkService(process.env.SIGNER_HEALTH_URL, 'SIGNER_HEALTH_URL', custodyMode === 'turnkey' ? 'turnkey' : undefined, turnkeySecretStore?.get('TURNKEY_ORGANIZATION_ID'));
checks.notification = mode === 'phase1'
  ? { status: 'ok', mode: 'not_required_in_phase1' }
  : await checkService(process.env.NOTIFICATION_HEALTH_URL, 'NOTIFICATION_HEALTH_URL');

const robinhoodProbe = process.env.CHECK_ROBINHOOD === 'true';
checks.sequencer = robinhoodProbe
  ? (await checkRpcUrl(process.env.SEQUENCER_URL ?? 'https://sequencer.mainnet.chain.robinhood.com', '0x1237')
    ? { status: 'ok', chainId: '0x1237' }
    : { status: 'failed', reason: 'SEQUENCER_CHAIN_ID_PROBE_FAILED' })
  : { status: 'ok', mode: 'not_requested' };
checks.feed = robinhoodProbe
  ? ((await checkFeed(process.env.FEED_URL ?? 'wss://feed.mainnet.chain.robinhood.com'))
    ? { status: 'ok', transport: 'reachable' }
    : { status: 'failed', reason: 'FEED_PROBE_FAILED' })
  : { status: 'ok', mode: 'not_requested' };

if (process.env.CHECK_FORK === 'true') {
  const archiveSecretName = process.env.ARCHIVE_FORK_SECRET_NAME ?? 'ROBINHOOD_ARCHIVE_RPC';
  const normalizedPath = secretStorePath?.replaceAll('\\', '/');
  checks.archiveFork = normalizedPath === '/home/Junayd/W3/Rets/archive-rpc.env' && secretStore?.has(archiveSecretName)
    ? { status: 'ok', reference: archiveSecretName }
    : { status: 'failed', reason: 'ARCHIVE_REFERENCE_REQUIRED' };
} else {
  checks.archiveFork = { status: 'ok', mode: 'not_requested' };
}

checks.finality = durableFinalityEvidence && state?.runtime?.operational?.chainVerification === 'verified'
  ? { status: 'ok', source: 'durable_runtime_state' }
  : { status: 'failed', reason: 'FINALITY_EVIDENCE_REQUIRED' };

const failed = Object.values(checks).some((check) => check.status !== 'ok');
console.log(JSON.stringify({ status: failed ? 'failed' : 'ok', mode, checks, timestamp: new Date().toISOString() }));
process.exitCode = failed ? 1 : 0;

async function checkService(url, name, expectedProvider, expectedOrganizationId) {
  if (!url || /[\r\n]/.test(url)) return { status: 'failed', reason: `${name}_REQUIRED` };
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return { status: 'failed', reason: `${name}_PROTOCOL_INVALID` };
    const response = await fetch(parsed, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return { status: 'failed', httpStatus: response.status };
    if (!expectedProvider) return { status: 'ok' };
    const body = await response.json();
    if (body?.status !== 'ok' || body.provider !== expectedProvider || (expectedOrganizationId && body.organizationId !== expectedOrganizationId) || !Number.isSafeInteger(body.walletCount) || body.walletCount < 1 || typeof body.organizationId !== 'string' || typeof body.policyId !== 'string' || body.policyId.length === 0 || typeof body.policyDigest !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(body.policyDigest)) {
      return { status: 'failed', reason: `${name}_IDENTITY_INVALID` };
    }
    return { status: 'ok', ...(expectedProvider ? { provider: expectedProvider, walletCount: body.walletCount } : {}) };
  } catch (error) {
    return { status: 'failed', error: error instanceof Error ? error.name : 'service_probe_error' };
  }
}

async function checkRpcUrl(url, expected) {
  if (!url || /[\r\n]/.test(url)) return false;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      signal: AbortSignal.timeout(3000),
    });
    const body = await response.json();
    return response.ok && body.result === expected;
  } catch {
    return false;
  }
}

async function checkFeed(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:') return false;
    const port = Number(parsed.port || (parsed.protocol === 'wss:' ? 443 : 80));
    await new Promise((resolvePromise, reject) => {
      const socket = parsed.protocol === 'wss:'
        ? tlsConnect({ host: parsed.hostname, port, servername: parsed.hostname })
        : tcpConnect({ host: parsed.hostname, port });
      socket.setTimeout(3000, () => { socket.destroy(); reject(new Error('feed_timeout')); });
      socket.once('error', reject);
      socket.once(parsed.protocol === 'wss:' ? 'secureConnect' : 'connect', () => { socket.end(); resolvePromise(); });
    });
    return true;
  } catch {
    return false;
  }
}

function parseJson(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  try { return JSON.parse(value); } catch { return undefined; }
}
