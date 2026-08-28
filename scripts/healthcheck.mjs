import { access, constants } from 'node:fs/promises';
import { connect as tlsConnect } from 'node:tls';
import { loadSecretStore } from './secret-store.mjs';

const checks = {};
const secretStorePath = process.env.SECRET_STORE_PATH;
const rpcSecretNames = (process.env.RPC_SECRET_NAMES ?? 'ETHEREUM_RPC_URL')
  .split(',').map((name) => name.trim()).filter(Boolean);
let secretStore;
if (secretStorePath) {
  try {
    secretStore = await loadSecretStore(secretStorePath);
  } catch (error) {
    checks.secretStore = { status: 'failed', error: error instanceof Error ? error.name : 'secret_store_error' };
  }
} else {
  checks.secretStore = { status: 'unknown', reason: 'SECRET_STORE_PATH is not configured' };
}

const rpcUrls = secretStore
  ? rpcSecretNames.map((name) => secretStore.get(name)).filter((value) => value !== undefined)
  : [];
const storePath = process.env.STORE_PATH;
const killSwitchPath = process.env.KILL_SWITCH_PATH;
const sequencerUrl = process.env.SEQUENCER_URL ?? 'https://sequencer.mainnet.chain.robinhood.com';
const feedUrl = process.env.FEED_URL ?? 'wss://feed.mainnet.chain.robinhood.com';
const archiveSecretName = process.env.ARCHIVE_FORK_SECRET_NAME ?? 'ANVIL_FORK_RPC';

checks.process = { status: 'ok' };

if (rpcUrls.length) {
  const endpoints = [];
  for (const [index, rpcUrl] of rpcUrls.entries()) {
    const started = performance.now();
    try {
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
        signal: AbortSignal.timeout(3000),
      });
      const body = await response.json();
      endpoints.push(response.ok && body.result
        ? { index, status: 'ok', chainId: body.result, latencyMs: Math.round(performance.now() - started) }
        : { index, status: 'failed' });
    } catch (error) {
      endpoints.push({ index, status: 'failed', error: error instanceof Error ? error.name : 'rpc_error' });
    }
  }
  const expectedChainId = process.env.EXPECTED_CHAIN_ID ?? '0x1';
  checks.rpc = endpoints.every((endpoint) => endpoint.status === 'ok' && endpoint.chainId === expectedChainId)
    ? { status: 'ok', expectedChainId, endpoints }
    : { status: 'failed', expectedChainId, endpoints };
} else {
  checks.rpc = { status: 'unknown', reason: 'approved RPC secret is not configured' };
}

async function checkRpc(url, expectedChainId) {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      signal: AbortSignal.timeout(3000),
    });
    const body = await response.json();
    return response.ok && body.result === expectedChainId;
  } catch {
    return false;
  }
}

checks.sequencer = process.env.CHECK_ROBINHOOD === 'true'
  ? (await checkRpc(sequencerUrl, '0x1237')
      ? { status: 'ok', chainId: '0x1237' }
      : { status: 'failed' })
  : { status: 'unknown', reason: 'Robinhood checks disabled until characterization is accepted' };

async function checkFeed(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:') return false;
    await new Promise((resolve, reject) => {
      const socket = tlsConnect({ host: parsed.hostname, port: Number(parsed.port || 443), servername: parsed.hostname });
      socket.setTimeout(3000, () => { socket.destroy(); reject(new Error('feed_timeout')); });
      socket.once('error', reject);
      socket.once('secureConnect', () => { socket.end(); resolve(); });
    });
    return true;
  } catch {
    return false;
  }
}

checks.feed = process.env.CHECK_ROBINHOOD === 'true'
  ? ((await checkFeed(feedUrl)) ? { status: 'ok', transport: 'reachable' } : { status: 'failed' })
  : { status: 'unknown', reason: 'Robinhood checks disabled until characterization is accepted' };

checks.archiveFork = process.env.CHECK_FORK === 'true'
  ? (secretStore?.has(archiveSecretName)
      ? { status: 'ok', reference: archiveSecretName }
      : { status: 'failed', reason: `missing archive reference ${archiveSecretName}` })
  : { status: 'unknown', reason: 'archive fork check disabled' };

if (storePath) {
  try {
    await access(storePath, constants.W_OK);
    checks.store = { status: 'ok' };
  } catch {
    checks.store = { status: 'failed' };
  }
} else {
  checks.store = { status: 'unknown', reason: 'STORE_PATH is not configured' };
}

checks.killSwitch = killSwitchPath
  ? await access(killSwitchPath, constants.F_OK)
      .then(() => ({ status: 'ok', engaged: true, source: 'file' }))
      .catch(() => ({ status: 'failed', engaged: false, reason: 'kill switch is not engaged' }))
  : { status: 'unknown', reason: 'KILL_SWITCH_PATH is not configured' };

function configuredBoolean(name) {
  const value = process.env[name];
  if (value === 'true') return { status: 'ok', value: true };
  if (value === 'false') return { status: 'failed', value: false };
  return { status: 'unknown', reason: `${name} is not configured` };
}

checks.chainVerification = configuredBoolean('CHAIN_VERIFIED');
checks.signer = configuredBoolean('SIGNER_READY');
checks.notification = configuredBoolean('NOTIFICATION_READY');

const reconciliationAt = process.env.LAST_RECONCILIATION_AT;
const reconciliationMaxAgeMs = Number(process.env.RECONCILIATION_MAX_AGE_MS ?? 120_000);
if (reconciliationAt && Number.isFinite(reconciliationMaxAgeMs) && reconciliationMaxAgeMs > 0) {
  const ageMs = Date.now() - Date.parse(reconciliationAt);
  checks.reconciliation = Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= reconciliationMaxAgeMs
    ? { status: 'ok', ageMs }
    : { status: 'failed', ageMs, maxAgeMs: reconciliationMaxAgeMs };
} else {
  checks.reconciliation = { status: 'unknown', reason: 'LAST_RECONCILIATION_AT is not configured' };
}

const failed = Object.values(checks).some((check) => check.status !== 'ok');
console.log(JSON.stringify({ status: failed ? 'failed' : 'ok', checks, timestamp: new Date().toISOString() }));
process.exitCode = failed ? 1 : 0;
