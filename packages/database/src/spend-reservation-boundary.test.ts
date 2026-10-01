import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Boundary test (T-021, T-010 follow-up): `SpendReservations.reserveExecution` skips the fleet policy
 * (D-032/D-033). Only the canonical admission path may reserve, so no non-test source outside
 * `packages/database` may call it, and the canonical store must be the one place that wraps it.
 */
const PACKAGES = fileURLToPath(new URL('../../', import.meta.url));

function sourceFiles(directory: string, found: string[] = []): string[] {
  for (const name of readdirSync(directory)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) sourceFiles(path, found);
    else if (/\.(ts|mts|mjs|js)$/.test(name) && !/\.test\.(ts|mjs|js)$/.test(name)) found.push(path);
  }
  return found;
}

describe('reserveExecution boundary', () => {
  it('has no non-test caller outside the database package or the canonical store', () => {
    const offenders: string[] = [];
    for (const pkg of readdirSync(PACKAGES)) {
      const src = join(PACKAGES, pkg, 'src');
      try { if (!statSync(src).isDirectory()) continue; } catch { continue; }
      for (const file of sourceFiles(src)) {
        const rel = relative(PACKAGES, file).split(sep).join('/');
        if (rel.startsWith('database/')) continue;
        if (rel === 'backend/src/canonical-store.ts') continue;
        if (/\breserveExecution\s*\(/.test(readFileSync(file, 'utf8'))) offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('finds a planted caller, so the scan cannot silently pass', () => {
    const planted = 'new SpendReservations(db).reserveExecution({ id: "x" })';
    expect(/\breserveExecution\s*\(/.test(planted)).toBe(true);
    expect(sourceFiles(join(PACKAGES, 'database', 'src')).length).toBeGreaterThan(3);
  });
});
