import { describe, expect, it } from 'vitest';
import type { Address, Hash } from 'viem';
import { assertBaseProviderAgreement, type BaseAgreementClient } from './base-provider-agreement.js';

const WALLET = '0x1111111111111111111111111111111111111111' as Address;
const HASH = `0x${'1'.repeat(64)}` as Hash;

function client(overrides: Partial<{ chainId: number; number: bigint; hash: Hash; commonNumber: bigint | null; commonHash: Hash | null; nonce: number }> = {}): BaseAgreementClient {
  return {
    getChainId: async () => overrides.chainId ?? 8453,
    getBlock: async (input) => 'blockTag' in input
      ? ({ number: overrides.number ?? 100n, hash: overrides.hash ?? HASH })
      : ({ number: 'commonNumber' in overrides ? overrides.commonNumber ?? null : input.blockNumber, hash: 'commonHash' in overrides ? overrides.commonHash ?? null : HASH }),
    getTransactionCount: async () => overrides.nonce ?? 7,
  };
}

describe('Base provider pre-sign agreement (D-057)', () => {
  it('allows signing only when chain, finalized state and pending nonce agree', async () => {
    await expect(assertBaseProviderAgreement(client(), client(), [WALLET])).resolves.toBeUndefined();
  });

  it('accepts bounded finalized-head lag only when both providers agree on the lower finalized block', async () => {
    await expect(assertBaseProviderAgreement(client({ number: 100n }), client({ number: 400n }), [WALLET])).resolves.toBeUndefined();
    await expect(assertBaseProviderAgreement(client({ number: 100n }), client({ number: 294n, commonHash: `0x${'2'.repeat(64)}` as Hash }), [WALLET])).rejects.toThrow('BASE_PROVIDER_FINALIZED_STATE_DISAGREEMENT');
    await expect(assertBaseProviderAgreement(client({ number: 400n }), client({ number: 100n }), [WALLET])).resolves.toBeUndefined();
    await expect(assertBaseProviderAgreement(client({ number: 294n, commonHash: `0x${'2'.repeat(64)}` as Hash }), client({ number: 100n }), [WALLET])).rejects.toThrow('BASE_PROVIDER_FINALIZED_STATE_DISAGREEMENT');
    await expect(assertBaseProviderAgreement(client({ number: 100n }), client({ number: 401n }), [WALLET])).rejects.toThrow('BASE_PROVIDER_FINALIZED_HEAD_LAG_TOO_LARGE');
    await expect(assertBaseProviderAgreement(client({ number: 401n }), client({ number: 100n }), [WALLET])).rejects.toThrow('BASE_PROVIDER_FINALIZED_HEAD_LAG_TOO_LARGE');
    await expect(assertBaseProviderAgreement(client({ number: 100n }), client({ number: 294n, commonNumber: 99n }), [WALLET])).rejects.toThrow('BASE_PROVIDER_FINALIZED_STATE_DISAGREEMENT');
    await expect(assertBaseProviderAgreement(client({ number: 294n, commonHash: null }), client({ number: 100n }), [WALLET])).rejects.toThrow('BASE_PROVIDER_FINALIZED_STATE_DISAGREEMENT');
  });

  it('fails closed on chain, same-height finalized hash or pending nonce disagreement', async () => {
    await expect(assertBaseProviderAgreement(client(), client({ chainId: 1 }), [WALLET])).rejects.toThrow('BASE_PROVIDER_CHAIN_DISAGREEMENT');
    await expect(assertBaseProviderAgreement(client(), client({ hash: `0x${'2'.repeat(64)}` as Hash }), [WALLET])).rejects.toThrow('BASE_PROVIDER_FINALIZED_STATE_DISAGREEMENT');
    await expect(assertBaseProviderAgreement(client(), client({ nonce: 8 }), [WALLET])).rejects.toThrow('BASE_PROVIDER_PENDING_NONCE_DISAGREEMENT');
  });
});
