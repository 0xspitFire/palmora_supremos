import { describe, expect, it, vi } from 'vitest';
import { encodeFunctionData, zeroAddress, type Address } from 'viem';
import { SIGNED_MINT_ABI, SEADROP_V1_ADDRESS, type SignedMintAuthorityClient } from '@mint-bot/engine';
import { createOpenSeaSignedDrops } from './opensea-signed-drops.js';
const state = vi.hoisted(() => ({ verify: vi.fn(async (authorization: unknown, _clients: unknown, quantity: number) => ({ ...(authorization as object), verifiedQuantity: quantity })) }));
vi.mock('@mint-bot/engine', async load => ({ ...await load<typeof import('@mint-bot/engine')>(), verifySignedWalletAuthorization: state.verify }));
const wallet = '0x1111111111111111111111111111111111111111' as Address;
const nft = '0x2222222222222222222222222222222222222222' as Address;
const fee = '0x3333333333333333333333333333333333333333' as Address;
const params = { mintPrice: 0n, maxTotalMintableByWallet: 10n, startTime: 1n, endTime: 2_000_000_000n, dropStageIndex: 1n, maxTokenSupplyForStage: 100n, feeBps: 0n, restrictFeeRecipients: true };
function setup(change: { recipient?: Address; value?: string; chain?: string; data?: string } = {}) {
  state.verify.mockClear();
  const tx = { chain: change.chain ?? 'ethereum', to: SEADROP_V1_ADDRESS, value: change.value ?? '0', data: change.data ?? encodeFunctionData({ abi: SIGNED_MINT_ABI, functionName: 'mintSigned', args: [nft, fee, change.recipient ?? zeroAddress, 1n, params, 1n, `0x${'11'.repeat(64)}1b`] }) };
  const fetcher = vi.fn(async (url: string) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(url.includes('/contract/') ? { collection: 'test-drop' } : tx) }));
  const apiKey = ['synthetic', 'marker'].join('-');
  const api = createOpenSeaSignedDrops({ apiKey, fetcher, sleep: async () => undefined });
  const run = () => api.ownWalletAuthorizations({ chainId: 1, contract: nft, wallets: [wallet], maxQuantity: 10, clients: [{} as SignedMintAuthorityClient, {} as SignedMintAuthorityClient] });
  return { run, fetcher };
}
describe('official own-wallet server signatures', () => {
  it('requests the actual fleet wallet and independently validates a canonical signed response', async () => {
    const s = setup(); await s.run();
    expect(s.fetcher).toHaveBeenCalledWith('https://api.opensea.io/api/v2/drops/test-drop/mint', expect.objectContaining({ body: JSON.stringify({ minter: wallet, quantity: 1, skip_balance_check: true }) }));
    expect(state.verify).toHaveBeenCalledWith(expect.objectContaining({ wallet, chainId: 1, nftContract: nft, source: expect.objectContaining({ wallet, sourceId: 'opensea-drops-v1' }) }), expect.any(Array), 10, expect.any(Date));
  });
  it.each([{ recipient: fee }, { value: '1' }, { chain: 'base' }, { data: '0x161ac21f' }])('refuses substituted recipient/value/chain/method before authority: %j', async change => {
    const s = setup(change); await expect(s.run()).rejects.toThrow('SIGNED_MINT_PLATFORM_BINDING_INVALID');
    expect(state.verify).not.toHaveBeenCalled();
  });
  it('accepts explicit self-minter only and still reconstructs each own authorization', async () => {
    const s = setup({ recipient: wallet }); await s.run();
    expect(state.verify).toHaveBeenCalledWith(expect.objectContaining({ wallet }), expect.any(Array), 10, expect.any(Date));
  });
  it('skips a platform funding rejection for one wallet while continuing the funded wallet', async () => {
    state.verify.mockClear();
    const apiKey = ['funding', 'test'].join('-');
    const nextWallet = fee;
    const data = encodeFunctionData({ abi: SIGNED_MINT_ABI, functionName: 'mintSigned', args: [nft, fee, zeroAddress, 1n, params, 1n, `0x${'11'.repeat(64)}1b`] });
    const fetcher = vi.fn(async (url: string, init: { body?: string }) => {
      const rejected = init.body?.includes(wallet) === true;
      return { ok: !rejected, status: rejected ? 422 : 200, headers: { get: () => null }, text: async () => JSON.stringify(url.includes('/contract/') ? { collection: 'test-drop' } : rejected ? { code: 'INSUFFICIENT_BALANCE' } : { chain: 'ethereum', to: SEADROP_V1_ADDRESS, value: '0', data }) };
    });
    const api = createOpenSeaSignedDrops({ apiKey, fetcher, sleep: async () => undefined });
    const result = await api.ownWalletAuthorizations({ chainId: 1, contract: nft, wallets: [wallet, nextWallet], maxQuantity: 10, clients: [{} as SignedMintAuthorityClient, {} as SignedMintAuthorityClient] });
    expect(result).toHaveLength(1);
    expect(state.verify).toHaveBeenCalledWith(expect.objectContaining({ wallet: nextWallet }), expect.any(Array), 10, expect.any(Date));
    expect(state.verify).toHaveBeenCalledTimes(1);
  });
});
