import { defineConfig } from 'vitest/config';

/**
 * Vitest config for Anvil mainnet-fork tests.
 *
 * Run with: pnpm test:fork
 *
 * These tests require a running Anvil instance forked from mainnet.
 * They are slower and hit real (forked) chain state.
 */
export default defineConfig({
  test: {
    include: ['packages/**/src/**/*.fork.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 120_000,  // Fork tests can be slow
    hookTimeout: 60_000,
  },
});
