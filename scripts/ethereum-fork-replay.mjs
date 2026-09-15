import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { runStrictVitest } from './strict-vitest.mjs';

const root = resolve(process.cwd());
const sourceReference = process.env.ETHEREUM_FORK_SOURCE ?? 'Rets/MINT_BOT_SECRETS.env:ETHEREUM_FORK_RPC';
const [sourcePath, sourceName] = sourceReference.split(':');
const normalizedSourcePath = sourcePath?.replaceAll('\\', '/') ?? '';
const approvedSource = ((normalizedSourcePath === 'Rets/MINT_BOT_SECRETS.env' || normalizedSourcePath.endsWith('/Rets/MINT_BOT_SECRETS.env')) && sourceName === 'ETHEREUM_FORK_RPC')
  || ((normalizedSourcePath === 'Rets/eth-archive-rpc.env' || normalizedSourcePath.endsWith('/Rets/eth-archive-rpc.env')) && sourceName === 'ETHEREUM_ARCHIVE_RPC');
if (!approvedSource) throw new Error('Ethereum archive source must be an approved Rets reference');
const secretFile = resolve(root, sourcePath);
const forkRpc = readReference(secretFile, sourceName);
const forkBlock = process.env.ETHEREUM_FORK_BLOCK;
if (!forkBlock || !/^\d+$/.test(forkBlock)) throw new Error('ETHEREUM_FORK_BLOCK is required');
for (const name of ['ETHEREUM_SEADROP_NFT', 'ETHEREUM_SEADROP_FEE_RECIPIENT', 'ETHEREUM_SEADROP_MINT_VALUE_WEI']) {
  if (!process.env[name]) throw new Error(`${name} fixture reference is required`);
}

const anvil = spawn(process.env.ANVIL_BIN ?? 'anvil', ['--fork-url', forkRpc, '--fork-block-number', forkBlock, '--chain-id', '1', '--host', '127.0.0.1', '--port', '8546', '--mnemonic-random'], { cwd: root, stdio: 'ignore', windowsHide: true });
try {
  await waitForRpc('http://127.0.0.1:8546');
  const vitest = resolve(root, 'packages/engine/node_modules/vitest/vitest.mjs');
  if (!existsSync(vitest)) throw new Error('Engine Vitest binary is unavailable');
  const environment = {
    MINT_BOT_FORK_REPLAY: 'true',
    ANVIL_ETHEREUM_RPC_URL: 'http://127.0.0.1:8546',
    ETHEREUM_SEADROP_NFT: process.env.ETHEREUM_SEADROP_NFT,
    ETHEREUM_SEADROP_FEE_RECIPIENT: process.env.ETHEREUM_SEADROP_FEE_RECIPIENT,
    ETHEREUM_SEADROP_MINT_VALUE_WEI: process.env.ETHEREUM_SEADROP_MINT_VALUE_WEI,
  };
  const code = await runStrictVitest({
    root,
    vitest,
    config: resolve(root, 'vitest.fork.config.ts'),
    files: [resolve(root, 'packages/engine/src/ethereum.fork.test.ts')],
    environment,
  });
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
