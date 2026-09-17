import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { afterEach, describe, expect, it } from 'vitest';
import { importAndEncryptWallets, LocalEncryptedSigner } from './signer.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('encrypted wallet import', () => {
  it('imports existing keys without exposing them in the public wallet file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mint-bot-signer-'));
    temporaryDirectories.push(directory);
    const records = Array.from({ length: 3 }, () => {
      const privateKey = `0x${randomBytes(32).toString('hex')}` as Hex;
      return { privateKey, address: privateKeyToAccount(privateKey).address };
    });
    const passphrase = 'test-only-import-passphrase';
    const output = join(directory, 'wallets.json');

    const imported = await importAndEncryptWallets(records, passphrase, output);
    const publicFile = JSON.parse(await readFile(output, 'utf8')) as { ciphertext: string; wallets: Array<{ index: number; address: string }> };
    const signer = await LocalEncryptedSigner.fromFile(output, passphrase);
    const listed = await signer.listWallets();

    expect(imported).toHaveLength(3);
    expect(publicFile.wallets).toEqual(records.map((record, index) => ({ index, address: record.address })));
    expect(publicFile.ciphertext).not.toContain(records[0]!.privateKey.slice(2));
    expect(listed).toEqual(imported);
    expect((await stat(output)).mode & 0o777).toBe(0o600);
    signer.zeroize();
    records.splice(0, records.length);
  });
});
