import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

const root = resolve(process.cwd());
const fixtureValues = readFixtureValues(resolveFixtureFile(root, 'ethereum-seadrop-fixture.env'));
const archiveFile = '/home/Junayd/W3/Rets/eth-archive-rpc.env';
const sourceReference = process.env.ETHEREUM_FORK_SOURCE ?? `${archiveFile}:ETHEREUM_ARCHIVE_RPC`;
if (sourceReference !== `${archiveFile}:ETHEREUM_ARCHIVE_RPC`) throw new Error('Ethereum archive source must be the approved absolute Rets reference');
if (!existsSync(archiveFile)) throw new Error('Ethereum archive reference file is unavailable');
const forkRpc = readReference(archiveFile, 'ETHEREUM_ARCHIVE_RPC');
const forkBlock = readForkBlock(process.env.ETHEREUM_FORK_BLOCK ?? fixtureValues.ETHEREUM_FORK_BLOCK);
const rpcUrl = resolveLoopbackRpcUrl(process.env.ANVIL_ETHEREUM_RPC_URL ?? 'http://127.0.0.1:8546');
for (const name of ['ETHEREUM_SEADROP_NFT', 'ETHEREUM_SEADROP_FEE_RECIPIENT', 'ETHEREUM_SEADROP_MINT_VALUE_WEI']) {
  if (!(process.env[name] ?? fixtureValues[name])) throw new Error(`${name} fixture reference is required`);
}
const testFiles = resolveTestFiles(process.argv.slice(2));

const anvil = spawn(process.env.ANVIL_BIN ?? 'anvil', [
  '--fork-url', forkRpc,
  '--fork-block-number', forkBlock.toString(),
  '--chain-id', '1',
  '--host', '127.0.0.1',
  '--port', '8546',
  '--mnemonic-random',
  '--silent',
], { cwd: root, stdio: 'ignore', windowsHide: true, env: toolEnvironment() });
try {
  await waitForRpc(rpcUrl);
  const vitest = resolve(root, 'packages/engine/node_modules/vitest/vitest.mjs');
  if (!existsSync(vitest)) throw new Error('Engine Vitest binary is unavailable');
  const reportDir = mkdtempSync(join(tmpdir(), 'mintbot-ethereum-replay-'));
  const reportFile = join(reportDir, 'report.json');
  const code = await run(process.execPath, [
    vitest,
    'run',
    ...testFiles,
    '--reporter=json',
    '--outputFile', reportFile,
  ], {
    ANVIL_ETHEREUM_RPC_URL: rpcUrl,
    ETHEREUM_FORK_BLOCK: forkBlock.toString(),
    ETHEREUM_SEADROP_NFT: process.env.ETHEREUM_SEADROP_NFT ?? fixtureValues.ETHEREUM_SEADROP_NFT,
    ETHEREUM_SEADROP_FEE_RECIPIENT: process.env.ETHEREUM_SEADROP_FEE_RECIPIENT ?? fixtureValues.ETHEREUM_SEADROP_FEE_RECIPIENT,
    ETHEREUM_SEADROP_MINT_VALUE_WEI: process.env.ETHEREUM_SEADROP_MINT_VALUE_WEI ?? fixtureValues.ETHEREUM_SEADROP_MINT_VALUE_WEI,
  });
  if (code !== 0) process.exitCode = code;
  if (code !== 0) printFailures(reportFile);
  if (existsSync(reportFile)) {
    const summary = JSON.parse(readFileSync(reportFile, 'utf8'));
    console.log(`Fork tests: ${summary.numPassedTests ?? 0} passed, ${summary.numFailedTests ?? 0} failed, ${(summary.numPendingTests ?? 0) + (summary.numTodoTests ?? 0)} skipped`);
  }
  if (code === 0) assertStrictReport(reportFile, 'Ethereum');
  rmSync(reportDir, { recursive: true, force: true });
} finally {
  anvil.kill('SIGTERM');
}

function readReference(file, name) {
  const line = readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`${name}=`));
  if (!line) throw new Error(`Missing required archive reference: ${name}`);
  const value = line.slice(name.length + 1).trim();
  if (!value) throw new Error(`Empty required archive reference`);
  return value;
}

function readForkBlock(value) {
  if (!value || !/^\d+$/.test(value) || BigInt(value) <= 0n) throw new Error('ETHEREUM_FORK_BLOCK is required');
  return BigInt(value);
}

function resolveLoopbackRpcUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('ANVIL_ETHEREUM_RPC_URL must be a local HTTP URL');
  }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('ANVIL_ETHEREUM_RPC_URL must target loopback Anvil');
  }
  if (Number(url.port || 8546) !== 8546) throw new Error('ANVIL_ETHEREUM_RPC_URL must use port 8546');
  return url.toString().replace(/\/$/, '');
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
    values[line.slice(0, separator).trim()] = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
  }
  return values;
}

function toolEnvironment() {
  return {
    ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
  };
}

function resolveTestFiles(requested) {
  if (requested.length === 0) return ['packages/engine/src/ethereum.fork.test.ts'];
  for (const file of requested) {
    if (!/^packages\/[a-z-]+\/src\/[A-Za-z0-9.-]+\.fork\.test\.ts$/.test(file)) throw new Error('Fork test files must be packages/<package>/src/<name>.fork.test.ts');
    if (!existsSync(resolve(root, file))) throw new Error(`Fork test file not found: ${file}`);
  }
  return requested;
}

// The Vitest child never receives the archive endpoint, but Anvil errors relayed by tests can quote its
// upstream URL. Every printed message is redacted: the exact archive value, any non-loopback URL, and long tokens.
function redact(text) {
  let out = String(text);
  if (forkRpc) out = out.split(forkRpc).join('[REDACTED_ARCHIVE]');
  out = out.replace(/\b(?:https?|wss?):\/\/(?!(?:127\.0\.0\.1|localhost|\[::1\])[:/])[^\s"'`)]+/gi, '[REDACTED_URL]');
  return out.replace(/\b[A-Za-z0-9_-]{32,}\b/g, (token) => (/^0x[0-9a-fA-F]+$/.test(token) ? token : '[REDACTED_TOKEN]'));
}

function printFailures(file) {
  if (!existsSync(file)) { console.error('Fork test runner produced no JSON report'); return; }
  const report = JSON.parse(readFileSync(file, 'utf8'));
  for (const suite of report.testResults ?? []) {
    if (suite.status === 'failed' && (suite.assertionResults ?? []).length === 0) console.error(`FAILED ${redact(suite.name)}: ${redact(String(suite.message ?? '').split('\n')[0])}`);
    for (const test of suite.assertionResults ?? []) {
      if (test.status !== 'failed') continue;
      console.error(`FAILED ${redact(test.fullName ?? test.title)}: ${redact(String((test.failureMessages ?? [])[0] ?? '').split('\n')[0]).slice(0, 300)}`);
    }
  }
}

function assertStrictReport(file, label) {
  if (!existsSync(file)) throw new Error(`${label} strict runner produced no JSON report`);
  const report = JSON.parse(readFileSync(file, 'utf8'));
  const pending = Number(report.numPendingTests ?? 0);
  const todo = Number(report.numTodoTests ?? 0);
  const skipped = Number(report.numSkippedTests ?? 0);
  if (pending !== 0 || todo !== 0 || skipped !== 0) throw new Error(`${label} strict runner requires zero skipped or todo tests`);
}

async function waitForRpc(url) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) });
      const body = await response.json();
      if (body.result === '0x1') return;
    } catch {
      // Wait for Anvil to start.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error('Ethereum fork Anvil did not become ready');
}

function run(command, args, env) {
  return new Promise((resolveCode) => {
    const child = spawn(command, args, { cwd: root, env: { ...toolEnvironment(), MINT_BOT_FORK_REPLAY: 'true', ...env }, stdio: 'ignore', windowsHide: true });
    child.on('error', () => resolveCode(1));
    child.on('exit', (code) => resolveCode(code ?? 1));
  });
}
