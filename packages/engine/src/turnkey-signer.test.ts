import { randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { TurnkeySigner } from './turnkey-signer.js';

describe('TurnkeySigner', () => {
  it('validates the Turnkey-signed transaction boundary', async () => {
    const privateKey = `0x${randomBytes(32).toString('hex')}` as Hex;
    const account = privateKeyToAccount(privateKey);
    const intent = {
      chainId: 1 as const,
      from: account.address,
      to: '0x0000000000000000000000000000000000000001' as Address,
      value: 0n,
      data: '0x' as Hex,
      nonce: 4,
      gasLimit: 21_000n,
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 100_000_000n,
    };
    const signedTransaction = await account.signTransaction({ type: 'eip1559', ...intent, gas: intent.gasLimit });
    let observedSignWith = '';
    let observedType = '';
    const signer = new TurnkeySigner({
      organizationId: 'org-test',
      wallets: [{ index: 0, address: account.address, signWith: 'turnkey-account-test' }],
      client: {
        signTransaction: async (input) => {
          observedSignWith = input.signWith;
          observedType = input.type;
          return { signedTransaction: signedTransaction.slice(2) };
        },
        getWhoami: async () => ({ organizationId: 'org-test' }),
      },
    });

    await expect(signer.signTransaction(0, intent)).resolves.toBe(signedTransaction);
    expect(observedSignWith).toBe('turnkey-account-test');
    expect(observedType).toBe('TRANSACTION_TYPE_ETHEREUM');
    await expect(signer.probe()).resolves.toMatchObject({ provider: 'turnkey', walletCount: 1 });
    signer.zeroize();
    await expect(signer.listWallets()).rejects.toThrow('TURNKEY_SIGNER_ZEROIZED');
  });

  it('rejects an intent from a different wallet', async () => {
    const privateKey = `0x${randomBytes(32).toString('hex')}` as Hex;
    const account = privateKeyToAccount(privateKey);
    const signer = new TurnkeySigner({
      organizationId: 'org-test',
      wallets: [{ index: 0, address: account.address, signWith: account.address }],
      client: {
        signTransaction: async () => ({ signedTransaction: '0x02' }),
        getWhoami: async () => ({ organizationId: 'org-test' }),
      },
    });
    const intent = {
      chainId: 1 as const,
      from: '0x0000000000000000000000000000000000000001' as Address,
      to: '0x0000000000000000000000000000000000000002' as Address,
      value: 0n,
      data: '0x' as Hex,
      nonce: 0,
      gasLimit: 21_000n,
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
    };
    await expect(signer.signTransaction(0, intent)).rejects.toThrow('TURNKEY_SIGNER_WALLET_MISMATCH');
    signer.zeroize();
  });
});
