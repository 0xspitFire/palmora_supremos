import { existsSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

/**
 * Robinhood step E2 (T-022): bot-path rehearsal on a local Anvil fork of chain 4663.
 *
 *   pnpm ops:robinhood-rehearsal --nft 0x<an open FREE public SeaDrop drop on Robinhood>
 *
 * It reads the approved archive reference internally (never printed), starts a loopback Anvil fork, runs
 * `packages/engine/src/bot-path.fork.test.ts` against it with fresh local wallets that exist only on the fork,
 * and stops Anvil. No signer, no secret and no real funds are used; nothing is broadcast to the real chain.
 * Pick the drop from the E1 survey (a contract with public mints) that is still open and free.
 */
const root = resolve(process.cwd());
const nft = readNft();
const port = Number(process.env.ANVIL_REHEARSAL_PORT ?? '8547');
const rpcUrl = `http://127.0.0.1:${port}`;
const archiveUrl = readReference(resolveArchiveFile(root), 'ROBINHOOD_ARCHIVE_RPC');
const forkBlock = process.env.ROBINHOOD_FORK_BLOCK;
if (forkBlock !== undefined && !/^\d+$/.test(forkBlock)) throw new Error('ROBINHOOD_FORK_BLOCK must be a block number');

const anvil = spawn(process.env.ANVIL_BIN ?? 'anvil', [
  '--fork-url', archiveUrl,
  ...(forkBlock ? ['--fork-block-number', forkBlock] : []),
  '--chain-id', '4663',
  '--host', '127.0.0.1',
  '--port', String(port),
  '--mnemonic-random',
  '--silent',
], { cwd: root, stdio: 'ignore', windowsHide: true, env: toolEnvironment() });
const anvilFailure = new Promise((_, reject) => { anvil.once('error', () => reject(new Error('Anvil binary unavailable'))); });

try {
  await Promise.race([waitForRpc(rpcUrl), anvilFailure]);
  const vitest = resolve(root, 'packages/engine/node_modules/vitest/vitest.mjs');
  if (!existsSync(vitest)) throw new Error('Engine Vitest binary is unavailable');
  const reportDir = mkdtempSync(join(tmpdir(), 'mintbot-rehearsal-report-'));
  const reportFile = join(reportDir, 'report.json');
  const code = await run(process.execPath, [vitest, 'run', '--config', 'vitest.fork.config.ts', 'packages/engine/src/bot-path.fork.test.ts', '--reporter=verbose', '--reporter=json', '--outputFile', reportFile], root, {
    ANVIL_REHEARSAL_RPC_URL: rpcUrl,
    REHEARSAL_CHAIN: 'robinhood',
    REHEARSAL_NFT: nft,
    ...(process.env.REHEARSAL_MAX_FEE_GWEI ? { REHEARSAL_MAX_FEE_GWEI: process.env.REHEARSAL_MAX_FEE_GWEI } : {}),
  });
  if (code !== 0) process.exitCode = code;
  if (code === 0) assertAllRan(reportFile);
  rmSync(reportDir, { recursive: true, force: true });
} finally {
  anvil.kill('SIGTERM');
}

function readNft() {
  const flag = process.argv.indexOf('--nft');
  const value = flag >= 0 ? process.argv[flag + 1] : process.env.REHEARSAL_NFT;
  if (!value || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error('Pass --nft 0x<address of an open, free public SeaDrop drop on Robinhood>');
  return value;
}

function resolveArchiveFile(repoRoot) {
  const explicitRoot = process.env.MINT_BOT_SECRETS_ROOT;
  const approvedRetsRoot = resolve(process.env.HOME ?? '', 'W3/Rets');
  const candidates = [
    ...(explicitRoot ? [resolve(explicitRoot, 'archive-rpc.env'), resolve(explicitRoot, 'MINT_BOT_SECRETS.env')] : []),
    resolve(approvedRetsRoot, 'archive-rpc.env'),
    resolve(repoRoot, 'Rets/archive-rpc.env'),
    resolve(repoRoot, 'Rets/MINT_BOT_SECRETS.env'),
  ];
  if (explicitRoot && resolve(explicitRoot) !== approvedRetsRoot && resolve(explicitRoot) !== resolve(repoRoot, 'Rets')) {
    throw new Error('MINT_BOT_SECRETS_ROOT must reference an approved Rets directory');
  }
  const file = candidates.find((candidate) => existsSync(candidate));
  if (!file) throw new Error('Robinhood archive reference file unavailable; expected ~/W3/Rets/archive-rpc.env');
  return file;
}

function readReference(file, name) {
  const line = readFileSync(file, 'utf8').split(/\r?\n/).map((entry) => entry.trim()).find((entry) => entry.startsWith(`${name}=`));
  if (!line) throw new Error('Missing required Robinhood archive reference');
  const value = line.slice(line.indexOf('=') + 1).trim();
  if (!value) throw new Error('Empty required archive reference');
  return value;
}

function toolEnvironment() {
  return {
    ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
  };
}

function assertAllRan(file) {
  if (!existsSync(file)) throw new Error('Rehearsal produced no JSON report');
  const report = JSON.parse(readFileSync(file, 'utf8'));
  if (Number(report.numPendingTests ?? 0) !== 0 || Number(report.numTodoTests ?? 0) !== 0 || Number(report.numFailedTests ?? 0) !== 0) {
    throw new Error('Rehearsal requires zero skipped, todo or failed tests');
  }
}

async function waitForRpc(url) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) });
      if ((await response.json()).result === '0x1237') return;
    } catch {
      // Anvil is still starting.
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Local Anvil did not become ready on ${url}`);
}

function run(command, args, cwd, values) {
  return new Promise((resolveCode) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', windowsHide: true, env: { ...toolEnvironment(), ...values } });
    child.on('error', () => resolveCode(1));
    child.on('exit', (code) => resolveCode(code ?? 1));
  });
}
