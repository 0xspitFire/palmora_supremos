import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isServiceEntrypoint } from './orchestrator-service.js';

describe('service entrypoint detection (host unit starts the service through the "current" link)', () => {
  const root = mkdtempSync(join(tmpdir(), 'mintbot-entry-'));
  const release = join(root, 'releases', 'abc');
  mkdirSync(join(release, 'packages', 'cli', 'dist'), { recursive: true });
  writeFileSync(join(release, 'packages', 'cli', 'dist', 'orchestrator-service.js'), '');
  symlinkSync(release, join(root, 'current'));
  const viaLink = join(root, 'current', 'packages', 'cli', 'dist', 'orchestrator-service.js');

  it('matches when started through a link while the working folder is the real release folder', () => {
    expect(isServiceEntrypoint(viaLink, release)).toBe(true);
  });

  it('matches the plain path', () => {
    expect(isServiceEntrypoint(join(release, 'packages', 'cli', 'dist', 'orchestrator-service.js'), release)).toBe(true);
  });

  it('does not match another program or a missing argument (importing the module must not start the service)', () => {
    expect(isServiceEntrypoint(join(release, 'packages', 'cli', 'dist', 'index.js'), release)).toBe(false);
    expect(isServiceEntrypoint(undefined, release)).toBe(false);
    expect(isServiceEntrypoint('/usr/bin/vitest', release)).toBe(false);
  });
});
