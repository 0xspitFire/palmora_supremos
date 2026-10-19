import { describe, expect, it } from 'vitest';
import { normalizeWalletCommandArgs } from './wallet-command-routing.js';

describe('wallet command routing', () => {
  it('gives every documented wallet subcommand a distinct yargs command', () => {
    expect(normalizeWalletCommandArgs(['wallet', 'generate', '--count', '6'])).toEqual(['wallet-generate', '--count', '6']);
    expect(normalizeWalletCommandArgs(['wallet', 'list'])).toEqual(['wallet-list']);
    expect(normalizeWalletCommandArgs(['wallet', 'import', '--files', 'one.env'])).toEqual(['wallet-import', '--files', 'one.env']);
    expect(normalizeWalletCommandArgs(['wallet', 'import-turnkey', '--files', 'one.env'])).toEqual(['wallet-import-turnkey', '--files', 'one.env']);
  });

  it('does not rewrite unrelated commands or incomplete wallet input', () => {
    expect(normalizeWalletCommandArgs(['summary'])).toEqual(['summary']);
    expect(normalizeWalletCommandArgs(['wallet'])).toEqual(['wallet']);
  });
});
