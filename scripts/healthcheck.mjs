import { access, constants, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { loadSecretStore } from './secret-store.mjs';

const require = createRequire(new URL('../packages/database/package.json', import.meta.url));
const Database = require('better-sqlite3');
const checks = {};
const mode = process.env.OPS_HEALTH_MODE ?? 'phase1';
const secretReference = process.env.SECRET_STORE_REFERENCE;
const storePath = process.env.STORE_PATH;
const probeTtlMs = Number(process.env.RUNTIME_PROBE_TTL_MS ?? '120000');

checks.process = { status: 'ok' };

let secretStore;
if (!secretReference) {
  checks.secretStore = { status: 'failed', reason: 'SECRET_STORE_REFERENCE_REQUIRED' };
} else {
  try {
    secretStore = await loadSecretStore(secretReference);
    checks.secretStore = { status: 'ok', reference: 'configured' };
  } catch (error) {
    checks.secretStore = { status: 'failed', error: error instanceof Error ? error.name : 'secret_store_error' };
  }
}

let state;
if (!storePath || /[\r\n]/.test(storePath)) {
  checks.store = { status: 'failed', reason: 'STORE_PATH_REQUIRED' };
} else {
  try {
    const database = new Database(resolve(storePath), { readonly: true, fileMustExist: true });
    try {
      const integrity = database.pragma('integrity_check', { simple: true });
      if (integrity !== 'ok') throw new Error('sqlite_integrity_failed');
      const row = database.prepare('SELECT state_json FROM backend_state WHERE id = ?').get('global');
      if (!row?.state_json) throw new Error('backend_state_missing');
      state = JSON.parse(row.state_json, (_key, value) => typeof value === 'string' && /^\d+n$/.test(value) ? BigInt(value.slice(0, -1)) : value);
      checks.store = { status: 'ok', integrity: 'ok' };
      const runtimeControl = database.prepare("SELECT kill_switch_engaged FROM runtime_control WHERE id = 'global'").get();
      const killSwitchEngaged = Boolean(state.killed) || runtimeControl?.kill_switch_engaged === 1;
      checks.killSwitch = killSwitchEngaged ? { status: 'failed', engaged: true } : { status: 'ok', engaged: false };
      const backup = database.prepare("SELECT outcome FROM backup_restore_evidence WHERE outcome = 'passed' ORDER BY recorded_at DESC LIMIT 1").get();
      checks.backup = backup ? { status: 'ok', evidence: 'recorded' } : { status: 'failed', reason: 'BACKUP_EVIDENCE_REQUIRED' };
    } finally {
      database.close();
    }
  } catch (error) {
    checks.store = { status: 'failed', error: error instanceof Error ? error.name : 'store_probe_error' };
    checks.killSwitch = { status: 'failed', reason: 'STORE_PROBE_REQUIRED' };
    checks.backup = { status: 'failed', reason: 'STORE_PROBE_REQUIRED' };
  }
}

const stateDirectory = storePath ? dirname(resolve(storePath)) : undefined;
const projectRoot = stateDirectory ? dirname(stateDirectory) : undefined;
const walletFile = projectRoot ? join(projectRoot, 'wallets', 'wallets.json') : undefined;
if (!walletFile) {
  checks.signer = { status: 'failed', reason: 'STORE_PATH_REQUIRED' };
} else {
  try {
    const content = JSON.parse(await readFile(walletFile, 'utf8'));
    const valid = Array.isArray(content.wallets) && content.wallets.length > 0 && content.wallets.every((wallet) => typeof wallet.address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(wallet.address));
    checks.signer = valid ? { status: 'ok', publicMetadata: 'available' } : { status: 'failed', reason: 'WALLET_PUBLIC_METADATA_INVALID' };
  } catch {
    checks.signer = { status: 'failed', reason: 'WALLET_PUBLIC_METADATA_UNAVAILABLE' };
  }
}

const engineArtifacts = [
  join(process.cwd(), 'packages', 'engine', 'dist', 'index.js'),
  join(process.cwd(), 'packages', 'backend', 'dist', 'index.js'),
  join(process.cwd(), 'packages', 'cli', 'dist', 'index.js'),
];
try {
  await Promise.all(engineArtifacts.map((file) => access(file, constants.R_OK)));
  checks.engine = { status: 'ok', artifacts: engineArtifacts.length };
} catch {
  checks.engine = { status: 'failed', reason: 'BUILD_ARTIFACTS_REQUIRED' };
}

const rpcNames = mode === 'robinhood' ? ['ROBINHOOD_RPC_URL'] : ['ETHEREUM_RPC_URL'];
const rpcChecks = [];
for (const name of rpcNames) {
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
    const expected = name === 'ROBINHOOD_RPC_URL' ? '0x1237' : '0x1';
    rpcChecks.push({ name, status: response.ok && body.result === expected ? 'ok' : 'failed', chainId: body.result, latencyMs: Math.round(performance.now() - started) });
  } catch (error) {
    rpcChecks.push({ name, status: 'failed', error: error instanceof Error ? error.name : 'rpc_probe_error' });
  }
}
checks.rpc = rpcChecks.length > 0 && rpcChecks.every((check) => check.status === 'ok') ? { status: 'ok', endpoints: rpcChecks } : { status: 'failed', reason: 'RPC_CHAIN_ID_PROBE_FAILED', endpoints: rpcChecks };
checks.chainVerification = state?.runtime?.operational?.chainVerification === 'verified' || (mode === 'phase1' && checks.rpc.status === 'ok')
  ? { status: 'ok', source: state?.runtime?.operational?.chainVerification === 'verified' ? 'durable_runtime_state' : 'rpc_chain_id' }
  : { status: 'failed', reason: 'CHAIN_VERIFICATION_REQUIRED' };

const reconciliationAt = state?.runtime?.reconciliationCompletedAt ?? state?.runtime?.operational?.lastReconciliationAt;
const reconciliationAge = reconciliationAt ? Date.now() - Date.parse(reconciliationAt) : Number.POSITIVE_INFINITY;
checks.reconciliation = Number.isFinite(probeTtlMs) && probeTtlMs > 0 && reconciliationAge >= 0 && reconciliationAge <= probeTtlMs
  ? { status: 'ok', ageMs: reconciliationAge }
  : { status: 'failed', reason: 'RECONCILIATION_STALE' };

checks.notification = mode === 'phase1'
  ? { status: 'ok', mode: 'not_required_in_phase1' }
  : { status: 'failed', reason: 'NOTIFICATION_PROBE_REQUIRED' };
checks.finality = state?.runtime?.operational?.chainVerification === 'verified'
  ? { status: 'ok', source: 'durable_runtime_state' }
  : { status: 'failed', reason: 'FINALITY_EVIDENCE_REQUIRED' };

const failed = Object.values(checks).some((check) => check.status !== 'ok');
console.log(JSON.stringify({ status: failed ? 'failed' : 'ok', mode, checks, timestamp: new Date().toISOString() }));
process.exitCode = failed ? 1 : 0;
