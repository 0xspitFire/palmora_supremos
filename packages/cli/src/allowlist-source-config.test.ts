import { describe, expect, it, vi } from 'vitest';
import type { Address, PublicClient } from 'viem';
import { getStrategy, OPENSEA_FEE_COLLECTOR } from '@mint-bot/engine';
import { EngineIntelligencePort } from './intelligence-adapter.js';
import { installAllowlistSources } from './allowlist-source-config.js';
const state = vi.hoisted(() => ({ secondRoot: false, chain: 1, fee: '0x4444444444444444444444444444444444444444', apiCalls: 0, feeMismatch: false, providerError: '' }));
vi.mock('viem', async (load) => ({ ...await load<typeof import('viem')>(), createPublicClient: (input: { transport: { url?: string } }) => ({
  getBlockNumber: async () => 100n,
  getChainId: async () => state.chain,
  getBlock: async () => ({ hash: `0x${'a'.repeat(64)}`, timestamp: BigInt(Math.floor(Date.now() / 1000)) }),
  readContract: async (args: { functionName: string }) => args.functionName === 'getAllowListMerkleRoot' ? `0x${(state.secondRoot && input.transport.url?.endsWith('two') ? 'b' : 'a').repeat(64)}` : [state.fee],
}), http: (url: string) => ({ url }) }));
vi.mock('@mint-bot/engine', async (load) => ({ ...await load<typeof import('@mint-bot/engine')>(), resolveChainConfigFromSecrets: async () => ({ rpcEndpoints: ['https://rpc.invalid/one', 'https://rpc.invalid/two'] }) }));
vi.mock('./opensea-drops.js', () => ({ createOpenSeaDrops: () => ({ ownWalletProofs: async (input: { readAuthority(fee: Address): Promise<unknown> }) => { state.apiCalls += 1; if (state.providerError) throw new Error(state.providerError); await input.readAuthority((state.feeMismatch ? '0x5555555555555555555555555555555555555555' : state.fee) as Address); throw new Error('PROVIDER_CALLED_AFTER_VERIFICATION'); } }) }));
const nft = '0x2222222222222222222222222222222222222222' as Address;
const wallet = '0x1111111111111111111111111111111111111111' as Address;
const read = () => getStrategy('seadrop-v1-allowlist').readDrop({} as PublicClient, nft, 1);

describe('dynamic source runtime composition', () => {
  it('installs the official adapter without a per-contract manifest and checks both RPC authorities', async () => {
    state.secondRoot = false; state.chain = 1; state.feeMismatch = false;
    await installAllowlistSources({ secretRoot: '/not-read', wallets: async () => [wallet], credential: async (name) => name === 'OPENSEA_API' ? 'test' : undefined });
    await expect(read()).rejects.toThrow('PROVIDER_CALLED_AFTER_VERIFICATION');
    state.secondRoot = true;
    await expect(read()).rejects.toThrow('ALLOWLIST_RPC_DISAGREEMENT');
    state.secondRoot = false; state.chain = 8453;
    await expect(read()).rejects.toThrow('ALLOWLIST_CHAIN_STALE');
    state.chain = 1; state.feeMismatch = true;
    await expect(read()).rejects.toThrow('ALLOWLIST_FEE_RECIPIENT_NOT_APPROVED');
    state.feeMismatch = false;
  });
  it('falls back only for explicit absent/public platform stages, never for unknown proof or API failure', async () => {
    await installAllowlistSources({ secretRoot: '/not-read', wallets: async () => [wallet], credential: async () => 'test' });
    for (const error of ['OPENSEA_PUBLIC_STAGE_RESPONSE', 'OPENSEA_DROP_NOT_FOUND', 'OPENSEA_DROP_TYPE_UNSUPPORTED', 'OPENSEA_DROP_NOT_MINTING', 'OPENSEA_MINT_FUNDING_REQUIRED']) {
      state.providerError = error;
      await expect(read()).rejects.toThrow('ALLOWLIST_FIRST_PARTY_SOURCE_REQUIRED');
    }
    for (const error of ['OPENSEA_DROPS_ACCESS_DENIED', 'OPENSEA_DROPS_UNAVAILABLE', 'OPENSEA_PROOF_AUTHORITY_MISMATCH']) {
      state.providerError = error;
      await expect(read()).rejects.toThrow(error);
    }
    state.providerError = '';
  });
  it('keeps upcoming public preparation available before opening or wallet funding', async () => {
    await installAllowlistSources({ secretRoot: '/not-read', wallets: async () => [wallet], credential: async () => 'test' });
    const opening = Math.floor(Date.now() / 1000) + 3600;
    const client = { readContract: async (args: { functionName: string }) => args.functionName === 'getPublicDrop' ? { mintPrice: 0n, startTime: opening, endTime: opening + 3600, maxTotalMintableByWallet: 4, restrictFeeRecipients: false, feeBps: 0 } : 100n };
    for (const error of ['OPENSEA_DROP_NOT_MINTING', 'OPENSEA_MINT_FUNDING_REQUIRED']) {
      state.providerError = error;
      const port = new EngineIntelligencePort(client as unknown as PublicClient);
      expect(await port.readDrop(nft)).toEqual(expect.objectContaining({ startTime: opening, priceWei: 0n, strategyName: 'seadrop-v1-public' }));
    }
    state.providerError = 'OPENSEA_DROPS_UNAVAILABLE';
    expect(await new EngineIntelligencePort(client as unknown as PublicClient).readDrop(nft)).toBeNull();
    state.providerError = '';
  });
  it('does not install network work without a key or manifest', async () => {
    const before = state.apiCalls;
    await installAllowlistSources({ secretRoot: '/not-read', wallets: async () => [wallet], credential: async () => undefined });
    expect(state.apiCalls).toBe(before);
    expect(OPENSEA_FEE_COLLECTOR).toMatch(/^0x/);
  });
});
