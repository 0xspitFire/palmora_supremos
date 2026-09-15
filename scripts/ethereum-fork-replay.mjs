import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { APPROVED_ARCHIVE_REFERENCE, readArchiveValues } from './archive-reference.mjs';
import { runStrictVitest } from './strict-vitest.mjs';

const root = resolve(process.cwd());
const sourceReference = process.env.ETHEREUM_FORK_SOURCE ?? `${APPROVED_ARCHIVE_REFERENCE}:ETHEREUM_FORK_RPC`;
const archive = await readArchiveValues(sourceReference, 'ETHEREUM_FORK_RPC', [
  'ETHEREUM_FORK_RPC',
  'ETHEREUM_ARCHIVE_RPC',
  'ETHEREUM_FORK_BLOCK',
  'ETHEREUM_SEADROP_NFT',
  'ETHEREUM_SEADROP_FEE_RECIPIENT',
  'ETHEREUM_SEADROP_MINT_VALUE_WEI',
]);
const forkRpc = archive.values.get(archive.reference.key)
  ?? archive.values.get('ETHEREUM_FORK_RPC')
  ?? archive.values.get('ETHEREUM_ARCHIVE_RPC');
if (!forkRpc) throw new Error('Ethereum archive reference value is missing');
const forkBlock = process.env.ETHEREUM_FORK_BLOCK ?? archive.values.get('ETHEREUM_FORK_BLOCK');
if (!forkBlock || !/^\d+$/.test(forkBlock)) throw new Error('ETHEREUM_FORK_BLOCK is required');
const fixture = new Map();
for (const name of ['ETHEREUM_SEADROP_NFT', 'ETHEREUM_SEADROP_FEE_RECIPIENT', 'ETHEREUM_SEADROP_MINT_VALUE_WEI']) {
  const value = process.env[name] ?? archive.values.get(name);
  if (!value) throw new Error(`${name} fixture reference is required`);
  fixture.set(name, value);
}
if (!/^0x[0-9a-fA-F]{40}$/.test(fixture.get('ETHEREUM_SEADROP_NFT'))
  || !/^0x[0-9a-fA-F]{40}$/.test(fixture.get('ETHEREUM_SEADROP_FEE_RECIPIENT'))
  || !/^\d+$/.test(fixture.get('ETHEREUM_SEADROP_MINT_VALUE_WEI'))) {
  throw new Error('Ethereum fixture metadata is invalid');
}

const anvil = spawn(process.env.ANVIL_BIN ?? 'anvil', ['--fork-url', forkRpc, '--fork-block-number', forkBlock, '--chain-id', '1', '--host', '127.0.0.1', '--port', '8546', '--silent', '--mnemonic-random'], { cwd: root, stdio: 'ignore', windowsHide: true });
try {
  await waitForRpc('http://127.0.0.1:8546');
  const vitest = resolve(root, 'packages/engine/node_modules/vitest/vitest.mjs');
  if (!existsSync(vitest)) throw new Error('Engine Vitest binary is unavailable');
  const environment = {
    MINT_BOT_FORK_REPLAY: 'true',
    ANVIL_ETHEREUM_RPC_URL: 'http://127.0.0.1:8546',
    ETHEREUM_SEADROP_NFT: fixture.get('ETHEREUM_SEADROP_NFT'),
    ETHEREUM_SEADROP_FEE_RECIPIENT: fixture.get('ETHEREUM_SEADROP_FEE_RECIPIENT'),
    ETHEREUM_SEADROP_MINT_VALUE_WEI: fixture.get('ETHEREUM_SEADROP_MINT_VALUE_WEI'),
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
