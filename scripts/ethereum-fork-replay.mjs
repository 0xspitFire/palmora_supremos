import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

const root = resolve(process.cwd());
const secretRoot = process.env.MINT_BOT_SECRETS_ROOT ?? [resolve(root, 'Rets'), resolve(root, '../../../Rets')].find((candidate) => existsSync(resolve(candidate, 'MINT_BOT_SECRETS.env'))) ?? resolve(root, 'Rets');
const sourceReference = process.env.ETHEREUM_FORK_SOURCE ?? 'Rets/MINT_BOT_SECRETS.env:ETHEREUM_FORK_RPC';
if (sourceReference !== 'Rets/MINT_BOT_SECRETS.env:ETHEREUM_FORK_RPC') throw new Error('Ethereum archive source must be the approved Rets reference');
const forkRpc = readReference(resolve(secretRoot, 'MINT_BOT_SECRETS.env'), 'ETHEREUM_FORK_RPC');
const forkBlock = process.env.ETHEREUM_FORK_BLOCK;
if (!forkBlock || !/^\d+$/.test(forkBlock)) throw new Error('ETHEREUM_FORK_BLOCK is required');
for (const name of ['ETHEREUM_SEADROP_NFT', 'ETHEREUM_SEADROP_FEE_RECIPIENT', 'ETHEREUM_SEADROP_MINT_VALUE_WEI']) {
  if (!process.env[name]) throw new Error(`${name} fixture reference is required`);
}

const anvil = spawn(process.env.ANVIL_BIN ?? 'anvil', ['--fork-url', forkRpc, '--fork-block-number', forkBlock, '--chain-id', '1', '--host', '127.0.0.1', '--port', '8546', '--silent'], { cwd: root, stdio: 'ignore', windowsHide: true });
try {
  await waitForRpc('http://127.0.0.1:8546');
  const vitest = resolve(root, 'packages/engine/node_modules/vitest/vitest.mjs');
  if (!existsSync(vitest)) throw new Error('Engine Vitest binary is unavailable');
  const environment = { ...process.env, MINT_BOT_FORK_REPLAY: 'true', ANVIL_ETHEREUM_RPC_URL: 'http://127.0.0.1:8546' };
  delete environment.ETHEREUM_FORK_RPC;
  delete environment.ETHEREUM_FORK_SOURCE;
  const code = await run(process.execPath, [vitest, 'run', 'packages/engine/src/ethereum.fork.test.ts'], environment);
  if (code !== 0) process.exitCode = code;
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
    const child = spawn(command, args, { cwd: root, env, stdio: 'inherit', windowsHide: true });
    child.on('error', () => resolveCode(1));
    child.on('exit', (code) => resolveCode(code ?? 1));
  });
}
