import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { readArchiveValue } from './archive-reference.mjs';

const root = resolve(process.cwd());
const fixture = readFixture(resolve(root, 'Fixtures/base-seadrop-fixture.env'));
const archive = await readArchiveValue(undefined, 'BASE_ARCHIVE_RPC');
const rpcUrl = 'http://127.0.0.1:8547';
const required = ['BASE_FORK_BLOCK', 'BASE_SEADROP_TX_HASH', 'BASE_SEADROP_NFT', 'BASE_SEADROP_FEE_RECIPIENT', 'BASE_SEADROP_MINT_VALUE_WEI', 'BASE_SEADROP_QUANTITY'];
for (const name of required) if (!fixture[name]) throw new Error(`${name} fixture reference is required`);
if (!/^\d+$/.test(fixture.BASE_FORK_BLOCK)) throw new Error('BASE_FORK_BLOCK must be a decimal block number');

const anvil = spawn(process.env.ANVIL_BIN ?? 'anvil', [
  '--fork-url', archive,
  '--fork-block-number', fixture.BASE_FORK_BLOCK,
  '--chain-id', '8453',
  '--host', '127.0.0.1',
  '--port', '8547',
  '--mnemonic-random',
  '--silent',
], { cwd: root, stdio: 'ignore', windowsHide: true, env: toolEnvironment() });

try {
  await waitForRpc();
  const reportDir = mkdtempSync(join(tmpdir(), 'mintbot-base-replay-'));
  const reportFile = join(reportDir, 'report.json');
  const vitest = resolve(root, 'packages/engine/node_modules/vitest/vitest.mjs');
  if (!existsSync(vitest)) throw new Error('Engine Vitest binary is unavailable');
  const code = await run(process.execPath, [vitest, 'run', 'packages/engine/src/base.fork.test.ts', '--reporter=json', '--outputFile', reportFile], {
    ANVIL_BASE_RPC_URL: rpcUrl,
    ...Object.fromEntries(required.map((name) => [name, fixture[name]])),
  });
  if (code !== 0) printFailures(reportFile);
  assertStrictReport(reportFile);
  const report = JSON.parse(readFileSync(reportFile, 'utf8'));
  console.log(`Base fork tests: ${report.numPassedTests ?? 0} passed, ${report.numFailedTests ?? 0} failed, ${(report.numPendingTests ?? 0) + (report.numTodoTests ?? 0)} skipped`);
  rmSync(reportDir, { recursive: true, force: true });
  if (code !== 0) process.exitCode = code;
} finally {
  anvil.kill('SIGTERM');
}

function readFixture(file) {
  const values = {};
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator > 0) values[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return values;
}

function toolEnvironment() {
  return { ...(process.env.PATH ? { PATH: process.env.PATH } : {}), ...(process.env.HOME ? { HOME: process.env.HOME } : {}) };
}

function run(command, args, env) {
  return new Promise((resolveCode) => {
    const child = spawn(command, args, { cwd: root, env: { ...toolEnvironment(), MINT_BOT_FORK_REPLAY: 'true', ...env }, stdio: 'ignore', windowsHide: true });
    child.on('error', () => resolveCode(1));
    child.on('exit', (code) => resolveCode(code ?? 1));
  });
}

async function waitForRpc() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) });
      const body = await response.json();
      if (body.result === '0x2105') return;
    } catch {}
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error('Base fork Anvil did not become ready');
}

function redact(value) {
  let text = String(value);
  text = text.split(archive).join('[REDACTED_ARCHIVE]');
  return text.replace(/\b(?:https?|wss?):\/\/(?!(?:127\.0\.0\.1|localhost|\[::1\])[:/])[^\s"'`)]+/gi, '[REDACTED_URL]');
}

function printFailures(file) {
  if (!existsSync(file)) return;
  const report = JSON.parse(readFileSync(file, 'utf8'));
  for (const suite of report.testResults ?? []) for (const test of suite.assertionResults ?? []) {
    if (test.status === 'failed') console.error(`FAILED ${redact(test.fullName ?? test.title)}: ${redact(String((test.failureMessages ?? [])[0] ?? '').split('\n')[0]).slice(0, 300)}`);
  }
}

function assertStrictReport(file) {
  if (!existsSync(file)) throw new Error('Base strict runner produced no JSON report');
  const report = JSON.parse(readFileSync(file, 'utf8'));
  if (Number(report.numPendingTests ?? 0) !== 0 || Number(report.numTodoTests ?? 0) !== 0 || Number(report.numSkippedTests ?? 0) !== 0) throw new Error('Base strict runner requires zero skipped or todo tests');
}

