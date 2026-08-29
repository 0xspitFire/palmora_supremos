import { describe, expect, it } from 'vitest';
import { promptHiddenPassphrase } from './secure-prompt.js';

describe('secure passphrase boundary', () => {
  it('rejects non-interactive input instead of reading environment or arguments', async () => {
    if (process.stdin.isTTY && process.stdout.isTTY) return;
    await expect(promptHiddenPassphrase()).rejects.toThrow('SECURE_INTERACTIVE_INPUT_REQUIRED');
  });
});
