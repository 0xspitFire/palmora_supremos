import { describe, expect, it } from 'vitest';
import type { Address, Hash } from 'viem';
import { assertBaseProviderAgreement, type BaseAgreementClient } from './base-provider-agreement.js';

const WALLET = '0x1111111111111111111111111111111111111111' as Address;
const HASH = `0x${'1'.repeat(64)}` as Hash;

function client(overrides: Partial<{ chainId: number; number: bigint; hash: Hash; nonce: number }> = {}): BaseAgreementClient {
  return {
    getChainId: async () => overrides.chainId ?? 8453,
    getBlock: async () => ({ number: overrides.number ?? 100n, hash: overrides.hash ?? HASH }),
    getTransactionCount: async () => overrides.nonce ?? 7,
  };
}

describe('Base provider pre-sign agreement (D-057)', () => {
  it('allows signing only when chain, finalized state and pending nonce agree', async () => {
    await expect(assertBaseProviderAgreement(client(), client(), [WALLET])).resolves.toBeUndefined();
  });

  it('fails closed on chain, finalized height, finalized hash or pending nonce disagreement', async () => {
    await expect(assertBaseProviderAgreement(client(), client({ chainId: 1 }), [WALLET])).rejects.toThrow('BASE_PROVIDER_CHAIN_DISAGREEMENT');
    await expect(assertBaseProviderAgreement(client(), client({ number: 99n }), [WALLET])).rejects.toThrow('BASE_PROVIDER_FINALIZED_STATE_DISAGREEMENT');
    await expect(assertBaseProviderAgreement(client(), client({ hash: `0x${'2'.repeat(64)}` as Hash }), [WALLET])).rejects.toThrow('BASE_PROVIDER_FINALIZED_STATE_DISAGREEMENT');
    await expect(assertBaseProviderAgreement(client(), client({ nonce: 8 }), [WALLET])).rejects.toThrow('BASE_PROVIDER_PENDING_NONCE_DISAGREEMENT');
  });
});
