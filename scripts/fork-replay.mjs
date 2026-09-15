import { access, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { APPROVED_ARCHIVE_REFERENCE, readArchiveValue } from './archive-reference.mjs';
import { runStrictVitest } from './strict-vitest.mjs';

const root = resolve(process.cwd());
const sourceReference = process.env.ROBINHOOD_FORK_SOURCE
  ?? process.env.ARCHIVE_FORK_SOURCE
  ?? `${APPROVED_ARCHIVE_REFERENCE}:ROBINHOOD_ARCHIVE_RPC`;
const forkRpc = await readArchiveValue(sourceReference, 'ROBINHOOD_ARCHIVE_RPC');

async function hasForkTests(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && await hasForkTests(path)) return true;
    if (entry.isFile() && entry.name.endsWith('.fork.test.ts')) return true;
  }
  return false;
}

if (!await hasForkTests(join(root, 'packages'))) throw new Error('Archive fork replay requires at least one *.fork.test.ts fixture');

const anvil = spawn('anvil', ['--fork-url', forkRpc, '--chain-id', '4663', '--host', '127.0.0.1', '--port', '8545', '--mnemonic-random'], { cwd: root, stdio: 'ignore' });
let anvilError;
anvil.once('error', (error) => { anvilError = error; });
try {
  let ready = false;
  for (let attempt = 0; attempt < 30 && !ready; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (anvilError) throw new Error('Anvil failed to start');
    try {
      const response = await fetch('http://127.0.0.1:8545', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) });
      const body = await response.json();
      ready = response.ok && body.result === '0x1237';
    } catch { /* wait for Anvil */ }
  }
  if (!ready) throw new Error('Anvil did not become ready for archive replay');
  const testEnvironment = { MINT_BOT_FORK_REPLAY: 'true', ANVIL_RPC_URL: 'http://127.0.0.1:8545' };
  const vitest = join(root, 'packages', 'engine', 'node_modules', 'vitest', 'vitest.mjs');
  if (!await access(vitest).then(() => true).catch(() => false)) {
    throw new Error('Engine Vitest binary is unavailable');
  }
  const code = await runStrictVitest({
    root,
    vitest,
    config: join(root, 'vitest.fork.config.ts'),
    files: ['packages/engine/src/robinhood.fork.test.ts', 'packages/engine/src/ethereum.fork.test.ts'],
    environment: testEnvironment,
  });
  if (code !== 0) throw new Error(`Fork replay failed with exit code ${code}`);
} finally {
  anvil.kill();
}
