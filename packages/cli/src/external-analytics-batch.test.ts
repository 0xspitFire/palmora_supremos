import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, type Hex, type PublicClient } from 'viem';
import { createExternalAnalyticsChainPort, EXTERNAL_TRANSFER_ABI, parseExternalNftTransfers, type ExternalChainLog } from './external-analytics-chain.js';
const from = `0x${'1'.repeat(40)}` as Hex, to = `0x${'2'.repeat(40)}` as Hex, nft = `0x${'3'.repeat(40)}`;
function batch(ids: bigint[] = [7n, 8n], values: bigint[] = [2n, 3n]): ExternalChainLog {
  return { address: nft, topics: encodeEventTopics({ abi: EXTERNAL_TRANSFER_ABI, eventName: 'TransferBatch', args: { operator: from, from, to } }) as Hex[], data: encodeAbiParameters([{ type: 'uint256[]' }, { type: 'uint256[]' }], [ids, values]), logIndex: 2, blockHash: `0x${'4'.repeat(64)}`, transactionHash: `0x${'5'.repeat(64)}`, blockNumber: 98n, removed: false };
}
describe('canonical bounded ERC1155 batch log decoding', () => {
  it('splits one batch log by stable array position and retains exact quantities', () => {
    expect(parseExternalNftTransfers([batch()])).toEqual({ transfers: [{ collection: nft, from, to, tokenId: '7', quantity: '2', logIndex: 2, subIndex: 0, batch: true }, { collection: nft, from, to, tokenId: '8', quantity: '3', logIndex: 2, subIndex: 1, batch: true }], issues: [] });
  });
  it('keeps repeated token IDs as distinct log items instead of overwriting amounts', () => {
    const result = parseExternalNftTransfers([batch([7n, 7n], [2n, 3n])]); expect(result.transfers.map(row => [row.subIndex, row.tokenId, row.quantity])).toEqual([[0, '7', '2'], [1, '7', '3']]);
  });
  it('accepts exactly1000 items and rejects oversized aggregate expansion', () => {
    const ids = Array.from({ length: 1000 }, (_, index) => BigInt(index));
    expect(parseExternalNftTransfers([batch(ids, ids.map(() => 1n))]).transfers).toHaveLength(1000);
    expect(() => parseExternalNftTransfers([batch(ids, ids.map(() => 1n)), { ...batch(), logIndex: 3 }])).toThrow('EXTERNAL_NFT_LOG_INVALID');
  });
  it.each(['empty', 'unequal', 'zero', 'oversized', 'padding', 'offsets', 'topics', 'address-padding', 'removed', 'same-party'] as const)('rejects malformed batch %s', variant => {
    let log = batch();
    if (variant === 'empty') log = batch([], []); if (variant === 'unequal') log = batch([1n], [1n, 2n]); if (variant === 'zero') log = batch([1n], [0n]); if (variant === 'oversized') log = batch(Array.from({ length: 1001 }, (_, i) => BigInt(i)), Array(1001).fill(1n));
    if (variant === 'padding') log.data += '0'.repeat(64); if (variant === 'offsets') log.data = `0x${'0'.repeat(63)}0${log.data.slice(66)}`; if (variant === 'topics') log.topics = [...log.topics, log.blockHash]; if (variant === 'address-padding') log.topics = [log.topics[0]!, log.topics[1]!, `0x${'f'.repeat(24)}${from.slice(2)}`, log.topics[3]!]; if (variant === 'removed') log.removed = true; if (variant === 'same-party') log.topics = encodeEventTopics({ abi: EXTERNAL_TRANSFER_ABI, eventName: 'TransferBatch', args: { operator: from, from, to: from } }) as Hex[];
    expect(() => parseExternalNftTransfers([log])).toThrow('EXTERNAL_NFT_LOG_INVALID');
  });
  it('continues excluding ERC20 Transfer while preserving ERC721 and ERC1155 single shapes', () => {
    const base = batch(); const erc721 = { ...base, topics: encodeEventTopics({ abi: EXTERNAL_TRANSFER_ABI, eventName: 'Transfer', args: { from, to, tokenId: 7n } }) as Hex[], data: '0x' };
    const single = { ...base, topics: encodeEventTopics({ abi: EXTERNAL_TRANSFER_ABI, eventName: 'TransferSingle', args: { operator: from, from, to } }) as Hex[], data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [7n, 4n]) };
    const erc20 = { ...erc721, topics: erc721.topics.slice(0, 3), data: encodeAbiParameters([{ type: 'uint256' }], [10n]) };
    expect(parseExternalNftTransfers([erc20, erc721, single]).transfers).toMatchObject([{ quantity: '1', logIndex: 2 }, { quantity: '4', logIndex: 2 }]);
    expect(parseExternalNftTransfers([single]).transfers[0]).not.toHaveProperty('batch');
  });
});

describe('two-reader finalized batch evidence adapter', () => {
  it('normalizes batch items only after independent receipt/hash/finality agreement', async () => {
    const log = batch();
    const client = (changed = false): PublicClient => ({ getChainId: async () => 1,
      getTransaction: async () => ({ hash: log.transactionHash, from, to: nft, value: 0n, input: '0x12345678', blockNumber: 98n, blockHash: log.blockHash }),
      getTransactionReceipt: async () => ({ transactionHash: log.transactionHash, from, to: nft, status: 'success', blockNumber: 98n, blockHash: log.blockHash, transactionIndex: 0, gasUsed: 21000n, effectiveGasPrice: 3n, logs: [changed ? batch([7n, 8n], [2n, 4n]) : log] }),
      getBlock: async () => ({ number: 100n, hash: log.blockHash, timestamp: 1794571195n }),
    } as unknown as PublicClient);
    const port = createExternalAnalyticsChainPort({ chainId: 1, readers: [{ identity: 'one.example', client: client() }, { identity: 'two.example', client: client() }], seaportAddresses: [] });
    const evidence = await port.observe(log.transactionHash); expect(evidence.transfers.map(row => [row.logIndex, row.subIndex, row.quantity])).toEqual([[2, 0, '2'], [2, 1, '3']]); expect(evidence.transactionFeeWei).toBe('63000'); expect(evidence.settlements).toEqual([]); expect(evidence.mintCost).toBeUndefined();
    const disagreed = createExternalAnalyticsChainPort({ chainId: 1, readers: [{ identity: 'one.example', client: client() }, { identity: 'two.example', client: client(true) }], seaportAddresses: [] });
    await expect(disagreed.observe(log.transactionHash)).rejects.toThrow('RPC_DISAGREEMENT');
  });
});
