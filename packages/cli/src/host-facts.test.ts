import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { codeVersion } from './host-facts.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const root = async () => { const value = await mkdtemp(join(tmpdir(), 'mintbot-version-')); roots.push(value); return value; };

describe('installed release version', () => {
  it('uses the immutable release semantic version without a git checkout', async () => {
    const directory = await root();
    await writeFile(join(directory, 'RELEASE'), 'commit=0123456789abcdef0123456789abcdef01234567\nversion=0.0.1\n');
    expect(await codeVersion(directory)).toBe('0.0.1');
  });

  it('rejects a malformed release version and falls back to package metadata', async () => {
    const directory = await root();
    await writeFile(join(directory, 'RELEASE'), 'version=v0.0.1-dev\n');
    await writeFile(join(directory, 'package.json'), JSON.stringify({ version: '0.0.1' }));
    expect(await codeVersion(directory)).toBe('0.0.1');
  });
});
