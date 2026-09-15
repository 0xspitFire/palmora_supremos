import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

const root = resolve(process.cwd());
const forkBlock = readForkBlock(process.env.ROBINHOOD_FORK_BLOCK);
const rpcUrl = resolveLoopbackRpcUrl(process.env.ANVIL_ROBINHOOD_RPC_URL ?? 'http://127.0.0.1:8545');
const fixture = {
  nft: readAddress('ROBINHOOD_SEADROP_NFT'),
  feeRecipient: readAddress('ROBINHOOD_SEADROP_FEE_RECIPIENT'),
  mintValueWei: readUint('ROBINHOOD_SEADROP_MINT_VALUE_WEI'),
};
const archiveFile = resolveArchiveFile(root);
// Read the archive source internally by approved reference name. Never print it.
const archiveUrl = readReference(archiveFile, [
  'ROBINHOOD_ARCHIVE_RPC',
  'ROBINHOOD_FORK_RPC',
  'ARCHIVE_RPC',
  'ARCHIVE_RPC_URL',
]);
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
  const result = await run(process.execPath, [vitest, 'run', '--config', 'vitest.fork.config.ts'], root, {
    ANVIL_ROBINHOOD_RPC_URL: rpcUrl,
    ROBINHOOD_FORK_BLOCK: forkBlock.toString(),
    ROBINHOOD_SEADROP_NFT: fixture.nft,
    ROBINHOOD_SEADROP_FEE_RECIPIENT: fixture.feeRecipient,
    ROBINHOOD_SEADROP_MINT_VALUE_WEI: fixture.mintValueWei,
  });
  if (result !== 0) process.exitCode = result;
} finally {
  anvil.kill('SIGTERM');
}

function resolveArchiveFile(repoRoot) {
  const explicitRoot = process.env.MINT_BOT_SECRETS_ROOT;
  const candidates = [
    ...(explicitRoot ? [resolve(explicitRoot, 'archive-rpc.env'), resolve(explicitRoot, 'MINT_BOT_SECRETS.env')] : []),
    resolve(process.env.HOME ?? '', 'W3/Rets/archive-rpc.env'),
    resolve(repoRoot, 'Rets/archive-rpc.env'),
    resolve(repoRoot, 'Rets/MINT_BOT_SECRETS.env'),
    resolve(repoRoot, '../../../../Rets/archive-rpc.env'),
    resolve(repoRoot, '../../../../Rets/MINT_BOT_SECRETS.env'),
  ];
  const file = candidates.find((candidate) => existsSync(candidate));
  if (!file) throw new Error('Robinhood archive reference file unavailable; expected ~/W3/Rets/archive-rpc.env');
  return file;
}

function readReference(file, names) {
  const line = readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => names.some((name) => entry.startsWith(`${name}=`)));
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
