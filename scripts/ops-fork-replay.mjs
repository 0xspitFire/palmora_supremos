import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { APPROVED_ARCHIVE_REFERENCE, readArchiveValue } from './archive-reference.mjs';
import { runStrictVitest } from './strict-vitest.mjs';

const root = resolve(process.cwd());
const sourceReference = process.env.ROBINHOOD_FORK_SOURCE ?? `${APPROVED_ARCHIVE_REFERENCE}:ROBINHOOD_ARCHIVE_RPC`;
// Read the archive source internally by approved reference name. Never print it.
const archiveUrl = await readArchiveValue(sourceReference, 'ROBINHOOD_ARCHIVE_RPC');
const forkBlock = readForkBlock(process.env.ROBINHOOD_FORK_BLOCK);
const rpcUrl = resolveLoopbackRpcUrl(process.env.ANVIL_ROBINHOOD_RPC_URL ?? 'http://127.0.0.1:8545');
const fixture = {
  nft: readAddress('ROBINHOOD_SEADROP_NFT'),
  feeRecipient: readAddress('ROBINHOOD_SEADROP_FEE_RECIPIENT'),
  mintValueWei: readUint('ROBINHOOD_SEADROP_MINT_VALUE_WEI'),
};
const anvilHost = '127.0.0.1';
const anvilPort = Number(new URL(rpcUrl).port || 8545);
const anvil = spawn(process.env.ANVIL_BIN ?? 'anvil', [
  '--fork-url', archiveUrl,
  '--fork-block-number', forkBlock.toString(),
  '--chain-id', '4663',
  '--host', anvilHost,
  '--port', String(anvilPort),
  '--mnemonic-random',
], { cwd: root, stdio: 'ignore', windowsHide: true, env: toolEnvironment() });
const anvilFailure = new Promise((_, reject) => {
  anvil.once('error', () => reject(new Error('Anvil binary unavailable')));
});

try {
  await Promise.race([waitForRpc(rpcUrl), anvilFailure]);
  const vitest = resolve(root, 'packages/engine/node_modules/vitest/vitest.mjs');
  if (!existsSync(vitest)) throw new Error('Engine Vitest binary is unavailable');
  const result = await runStrictVitest({
    root,
    vitest,
    config: resolve(root, 'vitest.fork.config.ts'),
    files: [resolve(root, 'packages/engine/src/robinhood.fork.test.ts')],
    environment: {
      MINT_BOT_FORK_REPLAY: 'true',
      ANVIL_ROBINHOOD_RPC_URL: rpcUrl,
      ROBINHOOD_FORK_BLOCK: forkBlock.toString(),
      ROBINHOOD_SEADROP_NFT: fixture.nft,
      ROBINHOOD_SEADROP_FEE_RECIPIENT: fixture.feeRecipient,
      ROBINHOOD_SEADROP_MINT_VALUE_WEI: fixture.mintValueWei,
    },
  });
  if (result !== 0) process.exitCode = result;
} finally {
  anvil.kill('SIGTERM');
}

function readForkBlock(value) {
  if (!value || !/^\d+$/.test(value)) throw new Error('ROBINHOOD_FORK_BLOCK is required');
  const block = BigInt(value);
  if (block < 0x2c92c19n) throw new Error('ROBINHOOD_FORK_BLOCK must include the approved positive fixture block');
  return block;
}

function readAddress(name) {
  const value = process.env[name];
  if (!value || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`${name} is required`);
  return value;
}

function readUint(name) {
  const value = process.env[name];
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
