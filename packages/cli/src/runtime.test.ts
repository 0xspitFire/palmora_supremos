import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createCliRuntime } from './runtime.js';
import type { EngineAdapter } from '@mint-bot/backend';

describe('CLI runtime custody boundaries', () => {
  it('does not read Turnkey files when dry-run explicitly disables custody loading', async () => {
    const root = await mkdtemp(join('/tmp', 'mintbot-runtime-'));
    const priorCustody = process.env.MINT_BOT_CUSTODY;
    const priorSecretRoot = process.env.MINT_BOT_SECRET_ROOT;
    process.env.MINT_BOT_CUSTODY = 'turnkey';
    process.env.MINT_BOT_SECRET_ROOT = join(root, 'missing-turnkey-root');
    try {
      const runtime = await createCliRuntime(root, {} as EngineAdapter, join(root, 'state.sqlite'), {}, { allowTurnkey: false, startCoordinator: false });
      expect(runtime.store.snapshot().runtime.startupState).toBe('Cold');
      (runtime.store as { close?: () => void }).close?.();
    } finally {
      if (priorCustody === undefined) delete process.env.MINT_BOT_CUSTODY; else process.env.MINT_BOT_CUSTODY = priorCustody;
      if (priorSecretRoot === undefined) delete process.env.MINT_BOT_SECRET_ROOT; else process.env.MINT_BOT_SECRET_ROOT = priorSecretRoot;
      await rm(root, { recursive: true, force: true });
    }
  });
});
