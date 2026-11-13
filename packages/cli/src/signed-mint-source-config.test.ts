import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import { installSignedMintSources, signedMintAuthorityEndpoints } from './signed-mint-source-config.js';

const state = vi.hoisted(() => ({
  endpoints: ['https://one.invalid/a', 'https://two.invalid/b'],
  configuredChains: [] as number[],
  createdClients: [] as string[],
  sourceCalls: [] as Array<{ chainId: number; contract: string; wallets: readonly string[]; maxQuantity: number; clients: readonly unknown[] }>,
  sourceError: '',
  provider: undefined as undefined | ((chainId: 1 | 8453 | 4663, contract: Address) => Promise<unknown>),
}));
vi.mock('viem', async load => ({ ...await load<typeof import('viem')>(), http: (url: string) => ({ url }), createPublicClient: (input: { transport: { url: string } }) => { state.createdClients.push(input.transport.url); return { identity: input.transport.url }; } }));
vi.mock('@mint-bot/engine', async load => ({
  ...await load<typeof import('@mint-bot/engine')>(),
  resolveChainConfigFromSecrets: async (chainId: number) => { state.configuredChains.push(chainId); return { rpcEndpoints: state.endpoints }; },
  SeaDropV1SignedStrategy: class { public name = 'seadrop-v1-signed'; public constructor(provider: typeof state.provider) { state.provider = provider; } },
  registerStrategy: vi.fn(),
}));
vi.mock('./opensea-signed-drops.js', () => ({ createOpenSeaSignedDrops: () => ({ ownWalletAuthorizations: async (input: typeof state.sourceCalls[number]) => { state.sourceCalls.push(input); if (state.sourceError) throw new Error(state.sourceError); return ['verified-own-wallet-proofs']; } }) }));
const wallet = `0x${'1'.repeat(40)}` as Address;
const contract = `0x${'2'.repeat(40)}` as Address;
const install = (overrides: Partial<Parameters<typeof installSignedMintSources>[0]> = {}) => installSignedMintSources({ secretRoot: '/not-read', wallets: async () => [wallet], credential: async name => name === 'OPENSEA_API' ? 'synthetic-only' : undefined, maxQuantity: 10, ...overrides });

beforeEach(() => { state.endpoints = ['https://one.invalid/a', 'https://two.invalid/b']; state.configuredChains = []; state.createdClients = []; state.sourceCalls = []; state.sourceError = ''; state.provider = undefined; });
describe('signed mint source runtime composition', () => {
  it.each([1, 8453, 4663] as const)('selects only chain %s endpoints and clamps to its approved quantity bound', async chainId => {
    await install();
    await expect(state.provider!(chainId, contract)).resolves.toEqual(['verified-own-wallet-proofs']);
    expect(state.configuredChains).toEqual([chainId]); expect(state.createdClients).toEqual(state.endpoints);
    expect(state.sourceCalls[0]).toMatchObject({ chainId, contract, wallets: [wallet], maxQuantity: chainId === 8453 ? 4 : 10 });
    expect(state.sourceCalls[0]?.clients[0]).not.toBe(state.sourceCalls[0]?.clients[1]);
  });
  it('respects the lower configured bound without widening it to the family ceiling', async () => {
    await install({ maxQuantity: 2 }); await state.provider!(8453, contract); expect(state.sourceCalls[0]?.maxQuantity).toBe(2);
  });
  it('never treats paths, ports or credentials on one RPC hostname as independence', () => {
    expect(() => signedMintAuthorityEndpoints(['https://same.invalid/a', 'https://user:fake@same.invalid:8443/b'])).toThrow('SIGNED_MINT_INDEPENDENT_AUTHORITY_REQUIRED');
    expect(signedMintAuthorityEndpoints(['malformed', 'http://one.invalid', 'https://one.invalid/a', 'https://one.invalid/b', 'https://two.invalid/rpc'])).toEqual(['https://one.invalid/a', 'https://two.invalid/rpc']);
  });
  it('does not call a platform or wallet loader without independent configured RPCs', async () => {
    state.endpoints = ['https://same.invalid/a', 'https://same.invalid/b']; const wallets = vi.fn(async () => [wallet]);
    await install({ wallets }); await expect(state.provider!(1, contract)).rejects.toThrow('SIGNED_MINT_INDEPENDENT_AUTHORITY_REQUIRED');
    expect(wallets).not.toHaveBeenCalled(); expect(state.sourceCalls).toEqual([]);
  });
  it('replaces the provider with a blocked one when credentials are absent in a new runtime', async () => {
    await install(); await state.provider!(1, contract); expect(state.sourceCalls).toHaveLength(1);
    await install({ credential: async () => undefined });
    await expect(state.provider!(1, contract)).rejects.toThrow('SIGNED_MINT_FIRST_PARTY_SOURCE_REQUIRED');
    expect(state.sourceCalls).toHaveLength(1);
  });
  it.each([0, -1, 16, 1.1, NaN])('rejects invalid configured quantity %s', async maxQuantity => { await expect(install({ maxQuantity })).rejects.toThrow('SIGNED_MINT_QUANTITY_CONFIG_INVALID'); });
  it.each([[], [wallet, wallet], ['not-an-address' as Address], Array.from({ length: 11 }, (_, index) => `0x${index.toString(16).padStart(40, '0')}` as Address)].map(wallets => ({ wallets })))('rejects invalid or oversized active fleet', async ({ wallets }) => {
    await install({ wallets: async () => wallets }); await expect(state.provider!(1, contract)).rejects.toThrow('SIGNED_MINT_SOURCE_SCOPE_INVALID'); expect(state.sourceCalls).toEqual([]);
  });
  it('sanitizes raw SDK/transport errors while preserving fixed actionable source codes', async () => {
    await install(); state.sourceError = 'https://rpc.invalid/private-token?api_key=synthetic';
    await expect(state.provider!(1, contract)).rejects.toThrow(/^SIGNED_MINT_SOURCE_UNAVAILABLE$/);
    state.sourceError = 'OPENSEA_DROPS_ACCESS_DENIED'; await expect(state.provider!(1, contract)).rejects.toThrow(/^OPENSEA_DROPS_ACCESS_DENIED$/);
  });
});
