import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

const root = resolve(process.cwd());
const fixtureValues = readFixtureValues(resolveFixtureFile(root, 'robinhood-testmint-fixture.env'));
const forkBlock = readForkBlock(process.env.ROBINHOOD_FORK_BLOCK ?? fixtureValues.ROBINHOOD_FORK_BLOCK);
const rpcUrl = resolveLoopbackRpcUrl(process.env.ANVIL_ROBINHOOD_RPC_URL ?? 'http://127.0.0.1:8545');
const fixture = {
  nft: readAddress('ROBINHOOD_SEADROP_NFT'),
  feeRecipient: readAddress('ROBINHOOD_SEADROP_FEE_RECIPIENT'),
  mintValueWei: readUint('ROBINHOOD_SEADROP_MINT_VALUE_WEI'),
};
const archiveFile = resolveArchiveFile(root);
// Read the archive source internally by approved reference name. Never print it.
const archiveUrl = readReference(archiveFile, 'ROBINHOOD_ARCHIVE_RPC');
const anvilHost = '127.0.0.1';
const anvilPort = Number(new URL(rpcUrl).port || 8545);
const anvil = spawn(process.env.ANVIL_BIN ?? 'anvil', [
  '--fork-url', archiveUrl,
  '--fork-block-number', forkBlock.toString(),
  '--chain-id', '4663',
  '--host', anvilHost,
  '--port', String(anvilPort),
  '--silent',
], { cwd: root, stdio: 'ignore', windowsHide: true, env: toolEnvironment() });
const anvilFailure = new Promise((_, reject) => {
  anvil.once('error', () => reject(new Error('Anvil binary unavailable')));
});

try {
  await Promise.race([waitForRpc(rpcUrl), anvilFailure]);
  const vitest = resolve(root, 'packages/engine/node_modules/vitest/vitest.mjs');
  if (!existsSync(vitest)) throw new Error('Engine Vitest binary is unavailable');
  const reportDir = mkdtempSync(join(tmpdir(), 'mintbot-robinhood-replay-'));
  const reportFile = join(reportDir, 'report.json');
  const result = await run(process.execPath, [
    vitest,
    'run',
    '--config', 'vitest.fork.config.ts',
    'packages/engine/src/robinhood.fork.test.ts',
    '--reporter=json',
    '--outputFile', reportFile,
  ], root, {
    ANVIL_ROBINHOOD_RPC_URL: rpcUrl,
    ROBINHOOD_FORK_BLOCK: forkBlock.toString(),
    ROBINHOOD_SEADROP_NFT: fixture.nft,
    ROBINHOOD_SEADROP_FEE_RECIPIENT: fixture.feeRecipient,
    ROBINHOOD_SEADROP_MINT_VALUE_WEI: fixture.mintValueWei,
  });
  if (result !== 0) process.exitCode = result;
  if (result === 0) assertStrictReport(reportFile, 'Robinhood');
  rmSync(reportDir, { recursive: true, force: true });
} finally {
  anvil.kill('SIGTERM');
}

function resolveArchiveFile(repoRoot) {
  const explicitRoot = process.env.MINT_BOT_SECRETS_ROOT;
  const approvedRetsRoot = resolve(process.env.HOME ?? '', 'W3/Rets');
  const candidates = [
    ...(explicitRoot ? [resolve(explicitRoot, 'archive-rpc.env'), resolve(explicitRoot, 'MINT_BOT_SECRETS.env')] : []),
    resolve(approvedRetsRoot, 'archive-rpc.env'),
    resolve(repoRoot, 'Rets/archive-rpc.env'),
    resolve(repoRoot, 'Rets/MINT_BOT_SECRETS.env'),
    resolve(repoRoot, '../../../../Rets/archive-rpc.env'),
    resolve(repoRoot, '../../../../Rets/MINT_BOT_SECRETS.env'),
  ];
  if (explicitRoot && resolve(explicitRoot) !== approvedRetsRoot && resolve(explicitRoot) !== resolve(repoRoot, 'Rets')) {
    throw new Error('MINT_BOT_SECRETS_ROOT must reference an approved Rets directory');
  }
  const file = candidates.find((candidate) => existsSync(candidate));
  if (!file) throw new Error('Robinhood archive reference file unavailable; expected ~/W3/Rets/archive-rpc.env');
  return file;
}

function readReference(file, name) {
  const line = readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`${name}=`));
  if (!line) throw new Error('Missing required Robinhood archive reference');
  const value = line.slice(line.indexOf('=') + 1).trim();
  if (!value) throw new Error('Empty required archive reference');
  return value;
}

function readForkBlock(value) {
  if (!value || !/^\d+$/.test(value)) throw new Error('ROBINHOOD_FORK_BLOCK is required');
  const block = BigInt(value);
  if (block < 0x2c92c19n) throw new Error('ROBINHOOD_FORK_BLOCK must include the approved positive fixture block');
  return block;
}

function readAddress(name) {
  const value = process.env[name] ?? fixtureValues[name];
  if (!value || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`${name} is required`);
  return value;
}

function readUint(name) {
  const value = process.env[name] ?? fixtureValues[name];
  if (!value || !/^\d+$/.test(value) || BigInt(value) <= 0n) throw new Error(`${name} is required`);
  return value;
}

function resolveLoopbackRpcUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('ANVIL_ROBINHOOD_RPC_URL must be a local HTTP URL');
  }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('ANVIL_ROBINHOOD_RPC_URL must target loopback Anvil');
  }
  return url.toString().replace(/\/$/, '');
}

function toolEnvironment() {
  return {
    ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
  };
}

function resolveFixtureFile(repoRoot, name) {
  const explicitRoot = process.env.MINT_BOT_FIXTURE_ROOT;
  const candidates = [
    ...(explicitRoot ? [resolve(explicitRoot, name)] : []),
    resolve(repoRoot, 'Fixtures', name),
    resolve(repoRoot, '../../../Fixtures', name),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

function readFixtureValues(file) {
  if (!file) return {};
  const values = {};
  for (const entry of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = entry.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
    values[key] = value;
  }
  return values;
}

function assertStrictReport(file, label) {
  if (!existsSync(file)) throw new Error(`${label} strict runner produced no JSON report`);
  const report = JSON.parse(readFileSync(file, 'utf8'));
  const pending = Number(report.numPendingTests ?? 0);
  const todo = Number(report.numTodoTests ?? 0);
  const skipped = Number(report.numSkippedTests ?? 0);
  if (pending !== 0 || todo !== 0 || skipped !== 0) {
    throw new Error(`${label} strict runner requires zero skipped or todo tests`);
  }
}

async function waitForRpc(url) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) });
      const body = await response.json();
      if (body.result === '0x1237') return;
    } catch {
      // Anvil is still starting.
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Local Anvil did not become ready on ${url}`);
}

function run(command, args, cwd, values) {
  return new Promise((resolveCode) => {
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
      windowsHide: true,
      env: {
        ...toolEnvironment(),
        MINT_BOT_FORK_REPLAY: 'true',
        ...values,
      },
    });
    child.on('error', () => resolveCode(1));
    child.on('exit', (code) => resolveCode(code ?? 1));
  });
}
