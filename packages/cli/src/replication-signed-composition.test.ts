import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData, zeroAddress, type Address, type Hex, type PublicClient } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { registerStrategy, SeaDropV1SignedStrategy, SEADROP_EVENTS_ABI, SEADROP_V1_ADDRESS, SIGNED_MINT_ABI, signedMintTypedData, type SignedMintAuthorityClient, type SignedWalletAuthorization } from '@mint-bot/engine';
import { createOpenSeaSignedDrops } from './opensea-signed-drops.js';
import { readReplicationSource } from './replication-source.js';

const start = new Date('2026-11-13T12:00:00Z');
const seconds = BigInt(start.getTime() / 1000);
const nft = '0x1111111111111111111111111111111111111111' as Address;
const whale = '0x2222222222222222222222222222222222222222' as Address;
const own = '0x3333333333333333333333333333333333333333' as Address;
const fee = '0x4444444444444444444444444444444444444444' as Address;
const hash = `0x${'a'.repeat(64)}` as Hex;
const blockHash = `0x${'b'.repeat(64)}` as Hex;
afterEach(() => vi.useRealTimers());

async function fixture(mode: 'fresh' | 'expired-proof' | 'future-proof' | 'source-expired' = 'fresh') {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(start);
  const issuer = privateKeyToAccount(generatePrivateKey());
  const authorization: SignedWalletAuthorization = { chainId: 1, nftContract: nft, wallet: own, feeRecipient: fee, mintParams: { mintPrice: 0n, maxTotalMintableByWallet: 10n, startTime: seconds - 60n, endTime: seconds + 3600n, dropStageIndex: 1n, maxTokenSupplyForStage: 1000n, feeBps: 0n, restrictFeeRecipients: true }, salt: 42n, signature: '0x', source: { chainId: 1, nftContract: nft, wallet: own, stageIndex: '1', sourceId: 'test', contentDigest: `sha256:${'a'.repeat(64)}` } };
  authorization.signature = await issuer.signTypedData(signedMintTypedData(authorization));
  const data = encodeFunctionData({ abi: SIGNED_MINT_ABI, functionName: 'mintSigned', args: [nft, fee, zeroAddress, 1n, authorization.mintParams, authorization.salt, authorization.signature] });
  const authorityClient = (): SignedMintAuthorityClient => ({ getBlockNumber: async () => 100n, getChainId: async () => 1, getBlock: async () => ({ hash: blockHash, timestamp: seconds }), readContract: async request => request.functionName === 'getFeeRecipientIsAllowed' ? true : request.functionName === 'getMintStats' ? [0n, 1n, 1000n] : [0n, 10n, seconds - 120n, seconds + 3600n, 1000n, 0n, 1000n], call: async () => ({ data: '0x' }) });
  const official = createOpenSeaSignedDrops({ apiKey: ['synthetic', 'composition'].join('-'), sleep: async () => undefined, fetcher: async url => {
    // Simulate actual asynchronous API latency before own-wallet verification.
    if (url.endsWith('/mint')) vi.setSystemTime(new Date(start.getTime() + 1000));
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(url.includes('/contract/') ? { collection: 'test-collection' } : { chain: 'ethereum', to: SEADROP_V1_ADDRESS, value: '0', data }) };
  } });
  registerStrategy(new SeaDropV1SignedStrategy(async () => {
    const proofs = await official.ownWalletAuthorizations({ chainId: 1, contract: nft, wallets: [own], maxQuantity: 10, clients: [authorityClient(), authorityClient()] });
    if (mode === 'expired-proof') vi.setSystemTime(new Date(start.getTime() + 62_001));
    if (mode === 'future-proof') vi.setSystemTime(start);
    if (mode === 'source-expired') vi.setSystemTime(new Date(start.getTime() + 2000));
    return proofs;
  }));
  const sourceTime = mode === 'source-expired' ? seconds - 899n : seconds - 24n;
  const client = { getTransaction: async () => ({ hash, from: whale, to: SEADROP_V1_ADDRESS, value: 0n, input: data, blockNumber: 100n, blockHash }), getTransactionReceipt: async () => ({ transactionHash: hash, status: 'success', from: whale, to: SEADROP_V1_ADDRESS, blockNumber: 100n, blockHash, logs: [{ address: SEADROP_V1_ADDRESS, topics: encodeEventTopics({ abi: SEADROP_EVENTS_ABI, eventName: 'SeaDropMint', args: { nftContract: nft, minter: whale, feeRecipient: fee } }), data: encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [whale, 1n, 0n, 0n, 0n]) }] }), getBlockNumber: async () => 102n, getChainId: async () => 1, getBlock: async () => ({ hash: blockHash, timestamp: sourceTime }) } as unknown as PublicClient;
  return () => readReplicationSource({ client, chainId: 1, contract: nft, hash, watchedWallets: [whale], targetWallets: [own] });
}

describe('signed replication source through official own-wallet acquisition', () => {
  it('qualifies newly acquired verified authorization using time after asynchronous reads', async () => {
    const run = await fixture();
    const qualified = await run();
    expect(qualified.plan.strategy).toBe('seadrop-v1-signed');
    expect(qualified.plan.verdict).toBe('replicable');
    const target = qualified.plan.targets[0]!;
    expect(target.wallet).toBe(own);
    const decoded = decodeFunctionData({ abi: SIGNED_MINT_ABI, data: target.data });
    expect(decoded.args[3]).toBe(1n);
    expect(Date.now()).toBe(start.getTime() + 1000);
  });
  it.each(['expired-proof', 'future-proof'] as const)('still rejects %s', async mode => {
    const run = await fixture(mode);
    await expect(run()).rejects.toThrow('SIGNED_MINT_OWN_WALLET_AUTHORIZATION_REQUIRED');
  });
  it('rejects a watched source that crosses its freshness limit during acquisition', async () => {
    const run = await fixture('source-expired');
    await expect(run()).rejects.toThrow('WATCHED_MINT_STALE_OR_REORGED');
  });
});
