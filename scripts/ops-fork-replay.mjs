import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

const root = resolve(process.cwd());
const secretRoot = process.env.MINT_BOT_SECRETS_ROOT ?? [
  resolve(root, 'Rets'),
  resolve(root, '../../../Rets'),
].find((candidate) => existsSync(resolve(candidate, 'MINT_BOT_SECRETS.env'))) ?? resolve(root, 'Rets');

// Read the archive source internally by approved reference name. Never print it.
const archiveUrl = readReference(resolve(secretRoot, 'MINT_BOT_SECRETS.env'), 'ROBINHOOD_ARCHIVE_RPC');
const port = 8545;
const host = '127.0.0.1';
const forkBlock = Number(0x2c92c19n);
const anvil = spawn(process.env.ANVIL_BIN ?? 'anvil', [
  '--fork-url', archiveUrl,
  '--fork-block-number', String(forkBlock),
  '--chain-id', '4663',
  '--host', host,
  '--port', String(port),
  '--silent',
], { cwd: root, stdio: 'ignore', windowsHide: true });
const anvilFailure = new Promise((_, reject) => {
  anvil.once('error', () => reject(new Error('Anvil binary unavailable')));
});

try {
  await Promise.race([waitForRpc(`http://${host}:${port}`), anvilFailure]);
  const vitest = resolve(root, 'packages/engine/node_modules/vitest/vitest.mjs');
  if (!existsSync(vitest)) throw new Error('Engine Vitest binary is unavailable');
  const result = await run(process.execPath, [vitest, 'run', '--config', 'vitest.fork.config.ts'], root);
  if (result !== 0) process.exitCode = result;
} finally {
  anvil.kill('SIGTERM');
}

function readReference(file, name) {
  const line = readFileSync(file, 'utf8').split(/\r?\n/).map((entry) => entry.trim()).find((entry) => entry.startsWith(`${name}=`));
  if (!line) throw new Error(`Missing required archive reference: ${name}`);
  const value = line.slice(name.length + 1).trim();
  if (!value) throw new Error(`Empty required archive reference: ${name}`);
  return value;
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
  throw new Error('Local Anvil did not become ready on 127.0.0.1:8545');
}

function run(command, args, cwd) {
  return new Promise((resolveCode) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', windowsHide: true, env: { ...process.env, MINT_BOT_FORK_REPLAY: 'true', ANVIL_RPC_URL: 'http://127.0.0.1:8545' } });
    child.on('error', () => resolveCode(1));
    child.on('exit', (code) => resolveCode(code ?? 1));
  });
}
