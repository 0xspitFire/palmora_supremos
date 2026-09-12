import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const forkRpc = process.env.ROBINHOOD_ARCHIVE_RPC;
const sourceReference = process.env.ARCHIVE_FORK_SOURCE ?? '';
if (!forkRpc) throw new Error('ROBINHOOD_ARCHIVE_RPC must be injected by the approved secret manager');
if (sourceReference !== 'Rets/MINT_BOT_SECRETS.env:ROBINHOOD_ARCHIVE_RPC') throw new Error('Archive fork source must be Rets/MINT_BOT_SECRETS.env:ROBINHOOD_ARCHIVE_RPC');

async function hasForkTests(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && await hasForkTests(path)) return true;
    if (entry.isFile() && entry.name.endsWith('.fork.test.ts')) return true;
  }
  return false;
}

if (!await hasForkTests('packages')) throw new Error('Archive fork replay requires at least one *.fork.test.ts fixture');

const anvil = spawn('anvil', ['--fork-url', forkRpc, '--chain-id', '31337', '--host', '127.0.0.1'], { stdio: 'ignore' });
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
      ready = response.ok && body.result === '0x7a69';
    } catch { /* wait for Anvil */ }
  }
  if (!ready) throw new Error('Anvil did not become ready for archive replay');
  const runner = process.platform === 'win32' ? 'corepack.cmd' : 'corepack';
  const testEnvironment = { ...process.env, ANVIL_RPC_URL: 'http://127.0.0.1:8545' };
  delete testEnvironment.ROBINHOOD_ARCHIVE_RPC;
  delete testEnvironment.ARCHIVE_FORK_SOURCE;
  await new Promise((resolve, reject) => {
    const child = spawn(runner, ['pnpm', 'exec', 'vitest', 'run', '--config', 'vitest.fork.config.ts'], { stdio: 'inherit', env: testEnvironment });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`Fork replay failed with exit code ${code}`)));
  });
} finally {
  anvil.kill();
}
