import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/src/**/*.test.ts', '.claude/hooks/*.test.mjs'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    passWithNoTests: true,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Bound concurrent TypeScript/SQLite workers on the small development and
    // CI hosts. Individual tests still exercise real process/IPC concurrency.
    maxWorkers: 2,
  },
});
