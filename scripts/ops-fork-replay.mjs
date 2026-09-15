import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { APPROVED_ARCHIVE_REFERENCE, readArchiveValue } from './archive-reference.mjs';
import { runStrictVitest } from './strict-vitest.mjs';

const root = resolve(process.cwd());
const sourceReference = process.env.ROBINHOOD_FORK_SOURCE ?? `${APPROVED_ARCHIVE_REFERENCE}:ROBINHOOD_ARCHIVE_RPC`;
// Read the archive source internally by approved reference name. Never print it.
const archiveUrl = await readArchiveValue(sourceReference, 'ROBINHOOD_ARCHIVE_RPC');
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
  const result = await runStrictVitest({
    root,
    vitest,
    config: resolve(root, 'vitest.fork.config.ts'),
    files: [resolve(root, 'packages/engine/src/robinhood.fork.test.ts')],
    environment: { MINT_BOT_FORK_REPLAY: 'true', ANVIL_RPC_URL: `http://${host}:${port}` },
  });
  if (result !== 0) process.exitCode = result;
} finally {
  anvil.kill('SIGTERM');
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
