import { describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, type Address, type PublicClient } from 'viem';
import { buildSeaDropPublicMintCalldata, SEADROP_EVENTS_ABI, SEADROP_V1_ADDRESS } from '@mint-bot/engine';
import { readReplicationSource } from './replication-source.js';

const nft = '0x1111111111111111111111111111111111111111' as Address;
const whale = '0x2222222222222222222222222222222222222222' as Address;
const own = '0x3333333333333333333333333333333333333333' as Address;
const hash = `0x${'a'.repeat(64)}` as const;
const blockHash = `0x${'b'.repeat(64)}` as const;
const now = new Date('2026-11-04T12:00:00Z');
function fixture() {
  const tx = { hash, from: whale, to: SEADROP_V1_ADDRESS, value: 0n, input: buildSeaDropPublicMintCalldata(nft, own, 1), blockNumber: 100n, blockHash };
  const receipt = { transactionHash: hash, status: 'success', from: whale, to: SEADROP_V1_ADDRESS, blockNumber: 100n, blockHash, logs: [{ address: SEADROP_V1_ADDRESS, topics: encodeEventTopics({ abi: SEADROP_EVENTS_ABI, eventName: 'SeaDropMint', args: { nftContract: nft, minter: whale, feeRecipient: own } }), data: encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [whale, 1n, 0n, 0n, 0n]) }] };
  const client = { getTransaction: vi.fn(async () => tx), getTransactionReceipt: vi.fn(async () => receipt), getBlockNumber: vi.fn(async () => 102n), getChainId: vi.fn(async () => 1), getBlock: vi.fn(async () => ({ hash: blockHash, timestamp: BigInt(now.getTime() / 1000 - 24) })), readContract: vi.fn(async (args: { functionName: string }) => {
    if (args.functionName === 'getPublicDrop') return { mintPrice: 0n, startTime: 1, endTime: 2_000_000_000, maxTotalMintableByWallet: 4, feeBps: 0, restrictFeeRecipients: true };
    if (args.functionName === 'getAllowedFeeRecipients') return [own];
    return 100n;
  }) };
  const run = (watchedWallets = [whale]) => readReplicationSource({ client: client as unknown as PublicClient, chainId: 1, contract: nft, hash, watchedWallets, targetWallets: [own], now });
  return { tx, receipt, client, run };
}
describe('watched self-mint transaction authority', () => {
  it('requires matching successful transaction, receipt, canonical block, event and watched sender', async () => {
    const s = fixture();
    await expect(s.run()).resolves.toMatchObject({ plan: { verdict: 'replicable' }, observed: { from: whale, hash } });
    await expect(s.run([own])).rejects.toThrow('WATCHED_MINT_NOT_VERIFIED');
  });
  it('rejects reverts, a swapped chain, a reorg and a stale source', async () => {
    const reverted = fixture(); reverted.receipt.status = 'reverted'; await expect(reverted.run()).rejects.toThrow();
    const chain = fixture(); chain.client.getChainId.mockResolvedValue(8453); await expect(chain.run()).rejects.toThrow();
    const reorg = fixture(); reorg.client.getBlock.mockResolvedValue({ hash: `0x${'c'.repeat(64)}`, timestamp: BigInt(now.getTime() / 1000 - 24) }); await expect(reorg.run()).rejects.toThrow('WATCHED_MINT_STALE_OR_REORGED');
    const stale = fixture(); stale.client.getBlock.mockResolvedValue({ hash: blockHash, timestamp: BigInt(now.getTime() / 1000 - 901) }); await expect(stale.run()).rejects.toThrow('WATCHED_MINT_STALE_OR_REORGED');
  });
  it('does not treat an unsolicited transfer or mint to a watched recipient as consolidation', async () => {
    const s = fixture();
    s.receipt.logs[0]!.data = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [own, 1n, 0n, 0n, 0n]);
    await expect(s.run()).rejects.toThrow('WATCHED_MINT_NOT_VERIFIED');
  });
});
