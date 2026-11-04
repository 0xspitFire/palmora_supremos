import { describe, expect, it } from 'vitest';
import { encodeFunctionData, zeroAddress, type Address, type Hex } from 'viem';
import { ALLOWLIST_MINT_ABI, allowlistLeaf, buildTree, buildAllowlistMint, SEADROP_V1_ADDRESS } from '@mint-bot/engine';
import { createOpenSeaDrops, type DropsFetch, type DropsResponse } from './opensea-drops.js';

const testKey = ['test'].join('');
const nft = '0x2222222222222222222222222222222222222222' as Address;
const wallet = '0x1111111111111111111111111111111111111111' as Address;
const other = '0x3333333333333333333333333333333333333333' as Address;
const fee = '0x4444444444444444444444444444444444444444' as Address;
const now = new Date('2026-11-04T12:00:00Z');
const params = { mintPrice: 0n, maxTotalMintableByWallet: 4n, startTime: 1n, endTime: 2_000_000_000n, dropStageIndex: 1n, maxTokenSupplyForStage: 100n, feeBps: 0n, restrictFeeRecipients: false };
const tree = buildTree([wallet, other].map((w) => allowlistLeaf(w, params)));
const response = (value: unknown, status = 200, headers: Record<string, string> = {}): DropsResponse => ({ ok: status === 200, status, headers: { get: (name) => headers[name] ?? null }, text: async () => JSON.stringify(value) });
const data = (w: Address) => encodeFunctionData({ abi: ALLOWLIST_MINT_ABI, functionName: 'mintAllowList', args: [nft, fee, zeroAddress, 1n, params, tree.proofFor(allowlistLeaf(w, params))!] });
const tx = (w: Address) => ({ chain: 'ethereum', to: SEADROP_V1_ADDRESS, data: data(w), value: '0' });
const authority = async () => ({ chainId: 1 as const, nftContract: nft, seaDrop: SEADROP_V1_ADDRESS, root: tree.root, blockNumber: 100n, blockHash: `0x${'a'.repeat(64)}` as Hex, observedAt: now.toISOString(), feeRecipient: fee });
const input = { chainId: 1 as const, contract: nft, wallets: [wallet, other], readAuthority: authority };
function client(transform: (w: Address) => DropsResponse = (w) => response(tx(w))) {
  const calls: Array<{ url: string; body?: string }> = [];
  const fetcher: DropsFetch = async (url, init) => {
    expect(url.startsWith('https://api.opensea.io/api/v2/')).toBe(true);
    expect(init.redirect).toBe('error');
    expect(init.headers['authorization']).toBeUndefined();
    calls.push({ url, body: init.body });
    return init.method === 'GET' ? response({ collection: 'discovered-collection' }) : transform(JSON.parse(init.body!).minter);
  };
  const api = createOpenSeaDrops({ apiKey: testKey, fetcher, now: () => now, sleep: async () => undefined });
  return { api, calls };
}
describe('dynamic official OpenSea own-wallet proofs', () => {
  it('resolves a discovered contract automatically, independently verifies each proof and reconstructs own calls', async () => {
    const { api, calls } = client();
    const proofs = await api.ownWalletProofs(input);
    expect(proofs.map((p) => p.wallet)).toEqual([wallet, other]);
    expect(buildAllowlistMint(proofs[0]!, wallet, 4, now).data).not.toBe(data(wallet));
    expect(proofs[0]!.source).toEqual(proofs[1]!.source);
    expect(calls).toHaveLength(3);
    await api.ownWalletProofs(input);
    expect(calls).toHaveLength(3); // Cached API bytes only; the authority callback runs afresh.
  });
  it('does not cache independent chain authority; rejects root changes and borrowed wallet payloads', async () => {
    const { api } = client();
    await api.ownWalletProofs(input);
    await expect(api.ownWalletProofs({ ...input, readAuthority: async () => ({ ...await authority(), root: `0x${'b'.repeat(64)}` as Hex }) })).rejects.toThrow('OPENSEA_PROOF_AUTHORITY_MISMATCH');
    await expect(client(() => response(tx(wallet))).api.ownWalletProofs(input)).rejects.toThrow('OPENSEA_PROOF_AUTHORITY_MISMATCH');
  });
  it.each(['chain', 'to', 'value', 'data'] as const)('rejects changed transaction %s', async (field) => {
    const changed = { chain: 'base', to: other, value: '1', data: `${data(wallet)}00` };
    const { api } = client((w) => response({ ...tx(w), [field]: changed[field] }));
    await expect(api.ownWalletProofs(input)).rejects.toThrow('OPENSEA_MINT_BINDING_INVALID');
  });
  it('distinguishes a genuinely ineligible wallet from authentication and service failures', async () => {
    const { api } = client((w) => w === other ? response({ code: 'MINTER_NOT_ELIGIBLE' }, 422) : response(tx(w)));
    expect(await api.ownWalletProofs(input)).toHaveLength(1);
    await expect(client(() => response({}, 401)).api.ownWalletProofs(input)).rejects.toThrow('OPENSEA_DROPS_ACCESS_DENIED');
    await expect(client(() => response({}, 503)).api.ownWalletProofs(input)).rejects.toThrow('OPENSEA_DROPS_BACKOFF');
    await expect(client(() => response({ code: 'INSUFFICIENT_BALANCE' }, 422)).api.ownWalletProofs(input)).rejects.toThrow('OPENSEA_MINT_FUNDING_REQUIRED');
  });
  it('honours backoff without retrying or leaking provider error text', async () => {
    const { api, calls } = client(() => response({ detail: 'untrusted-provider-detail' }, 429, { 'retry-after': '120' }));
    await expect(api.ownWalletProofs(input)).rejects.toThrow('OPENSEA_DROPS_BACKOFF');
    const count = calls.length;
    await expect(api.ownWalletProofs(input)).rejects.toThrow('OPENSEA_DROPS_BACKOFF');
    expect(calls).toHaveLength(count);
  });
  it('bounds the body, rejects unsafe metadata and deduplicates concurrent requests', async () => {
    const { api, calls } = client();
    await Promise.all([api.ownWalletProofs(input), api.ownWalletProofs(input)]);
    expect(calls).toHaveLength(3);
    await expect(client(() => response({}, 200, { 'content-length': '1048577' })).api.ownWalletProofs(input)).rejects.toThrow('OPENSEA_DROPS_RESPONSE_TOO_LARGE');
    const unsafe = createOpenSeaDrops({ apiKey: testKey, fetcher: async () => response({ collection: '../bad' }), sleep: async () => undefined });
    await expect(unsafe.ownWalletProofs(input)).rejects.toThrow('OPENSEA_DROP_NOT_FOUND');
  });
  it('cancels an oversized streamed body and aborts rejected HTTP responses', async () => {
    let cancelled = false;
    let signal: AbortSignal | undefined;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(1_048_577)); }, cancel() { cancelled = true; } });
    const api = createOpenSeaDrops({ apiKey: testKey, fetcher: async (_url, init) => { signal = init.signal; return { ...response({}), body: stream }; } });
    await expect(api.ownWalletProofs(input)).rejects.toThrow('OPENSEA_DROPS_RESPONSE_TOO_LARGE');
    expect(cancelled).toBe(true);
    expect(signal?.aborted).toBe(true);
    const denied = createOpenSeaDrops({ apiKey: testKey, fetcher: async (_url, init) => { signal = init.signal; return response({}, 401); } });
    await expect(denied.ownWalletProofs(input)).rejects.toThrow('OPENSEA_DROPS_ACCESS_DENIED');
    expect(signal?.aborted).toBe(true);
  });
  it('rejects gifts, unsupported calls, unknown chains and a fee not independently approved', async () => {
    const gift = encodeFunctionData({ abi: ALLOWLIST_MINT_ABI, functionName: 'mintAllowList', args: [nft, fee, other, 1n, params, []] });
    await expect(client((w) => response({ ...tx(w), data: gift })).api.ownWalletProofs(input)).rejects.toThrow('OPENSEA_MINT_BINDING_INVALID');
    await expect(client((w) => response({ ...tx(w), data: '0x161ac21f' })).api.ownWalletProofs(input)).rejects.toThrow('OPENSEA_PUBLIC_STAGE_RESPONSE');
    await expect(client((w) => response({ ...tx(w), data: '0xdeadbeef' })).api.ownWalletProofs(input)).rejects.toThrow('OPENSEA_ALLOWLIST_METHOD_REQUIRED');
    await expect(client().api.ownWalletProofs({ ...input, chainId: 999 as 1 })).rejects.toThrow('OPENSEA_DROPS_SCOPE_INVALID');
    await expect(client().api.ownWalletProofs({ ...input, readAuthority: async () => ({ ...await authority(), feeRecipient: other }) })).rejects.toThrow('OPENSEA_FEE_AUTHORITY_MISMATCH');
  });
});
