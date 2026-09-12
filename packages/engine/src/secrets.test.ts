import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { readSecret, readSecretList, resolveChainEndpoints, hasSecret } from './secrets.js';
import { resolveChainConfigFromSecrets } from './chains.js';

const FIXTURE_MAINNET = [
  'ETHEREUM_RPC_URL=https://eth-mainnet.example/primary',
  'ETHEREUM_RPC_FBACK=https://eth-mainnet.example/fallback',
  'BASE_SEQUENCER_URL=https://sequencer.example/base',
  'ROBINHOOD_RPC_URL=https://robinhood-mainnet.example/primary',
  'FLASHBOTS_KEY_PATH=/secrets/flashbots-signer.key',
  '',
].join('\n');

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mint-bot-secrets-'));
  await writeFile(join(dir, 'MINT_BOT_SECRETS.env'), FIXTURE_MAINNET, 'utf8');
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('secret reference resolver', () => {
  it('resolves a value by approved key name without exposing it', async () => {
    const value = await readSecret('ETHEREUM_RPC_URL', 'mainnet', dir);
    expect(value).toMatch(/^https:\/\/eth-mainnet\.example\/primary$/);
  });

  it('collects all configured RPC endpoints for a chain', async () => {
    const endpoints = await resolveChainEndpoints(
      ['ETHEREUM_RPC_URL', 'ETHEREUM_RPC_FBACK'],
      'mainnet',
      dir,
    );
    expect(endpoints).toEqual([
      'https://eth-mainnet.example/primary',
      'https://eth-mainnet.example/fallback',
    ]);
  });

  it('deduplicates endpoint lists', async () => {
    const endpoints = await resolveChainEndpoints(
      ['ETHEREUM_RPC_URL', 'ETHEREUM_RPC_URL'],
      'mainnet',
      dir,
    );
    expect(endpoints).toEqual(['https://eth-mainnet.example/primary']);
  });

  it('reports missing references without revealing values', async () => {
    expect(await hasSecret('BASE_RPC_URL', 'mainnet', dir)).toBe(false);
    await expect(readSecret('BASE_RPC_URL', 'mainnet', dir)).rejects.toThrow(
      'Missing configured secret reference: BASE_RPC_URL',
    );
  });

  it('parses comma-separated endpoint lists', async () => {
    const list = await readSecretList('ETHEREUM_RPC_FBACK', 'mainnet', dir);
    expect(list).toEqual(['https://eth-mainnet.example/fallback']);
  });
});

describe('secret-backed chain config resolution', () => {
  it('populates Ethereum endpoints from the secret store', async () => {
    const config = await resolveChainConfigFromSecrets(1, 'mainnet', dir);
    expect(config.chainId).toBe(1);
    expect(config.rpcEndpoints).toContain('https://eth-mainnet.example/primary');
    expect(config.executionEnabled).toBe(true);
  });

  it('resolves the Base sequencer reference when configured', async () => {
    const config = await resolveChainConfigFromSecrets(8453, 'mainnet', dir);
    expect(config.sequencerUrl).toBe('https://sequencer.example/base');
  });

  it('keeps Robinhood execution blocked regardless of endpoint availability', async () => {
    const config = await resolveChainConfigFromSecrets(4663, 'mainnet', dir);
    expect(config.rpcEndpoints).toContain('https://robinhood-mainnet.example/primary');
    expect(config.executionEnabled).toBe(false);
  });
});