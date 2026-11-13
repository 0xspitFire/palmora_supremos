import { describe, expect, it } from 'vitest';
import type { NativeFundingRecord } from '@mint-bot/database';
import type { PublicClient } from 'viem';
import { nativeFundingReceiptObservations, nativeFundingCanonicalBlocks } from './native-funding-receipts.js';
const hash = `0x${'1'.repeat(64)}`, blockHash = `0x${'2'.repeat(64)}`, hub = `0x${'3'.repeat(40)}`, recipient = `0x${'4'.repeat(40)}`;
const now = new Date('2026-11-13T12:00:00Z');
const record = { transactionHash: hash, request: { chainId: 1, recipient }, preparation: { hub, nonce: 3, valueWei: 100n }, receipt: { blockNumber: 98n, blockHash } } as unknown as NativeFundingRecord;
function reader(change: string = ''): PublicClient {
 return { getChainId: async () => 1,
  getTransactionReceipt: async () => ({ transactionHash: hash, from: hub, to: recipient, blockNumber: 98n, blockHash, gasUsed: 21000n, effectiveGasPrice: 2n, status: 'success' }),
  getTransaction: async () => ({ hash, from: change === 'from' ? recipient : hub, to: change === 'to' ? hub : recipient, nonce: 3, value: 100n, input: '0x', blockHash, blockNumber: change === 'block' ? 97n : 98n }),
  getBlock: async (input: { blockNumber?: bigint; blockTag?: string }) => ({ number: input.blockTag === 'finalized' ? change === 'pending' ? 97n : 100n : 98n, hash: change === 'reorg' ? `0x${'5'.repeat(64)}` : blockHash }),
 } as unknown as PublicClient;
}
describe('portable funding receipt/finality observer', () => {
 it('returns two typed actual-fee observations only after finality and current hash binding', async () => { const rows = await nativeFundingReceiptObservations(record, [{ endpoint: 'https://one.example', client: reader() }, { endpoint: 'https://two.example', client: reader() }], now); expect(rows).toHaveLength(2); expect(rows[0]).toMatchObject({ valueWei: 100n, gasUsed: 21000n, effectiveGasPrice: 2n, finalityStage: 'ethereum_final', data: '0x' }); });
 it.each(['from', 'to', 'block', 'reorg', 'pending'])('retains unknown on %s evidence instead of inventing settlement', async variant => { expect(await nativeFundingReceiptObservations(record, [{ endpoint: 'https://one.example', client: reader() }, { endpoint: 'https://two.example', client: reader(variant) }], now)).toEqual([]); });
 it('requires distinct configured clients/HTTPS hosts and exposes canonical hash facts for reorg proof', async () => { const same = reader(); expect(await nativeFundingReceiptObservations(record, [{ endpoint: 'https://one.example', client: same }, { endpoint: 'https://two.example', client: same }], now)).toEqual([]); const rows = await nativeFundingCanonicalBlocks(record, [{ endpoint: 'https://one.example', client: reader('reorg') }, { endpoint: 'https://two.example', client: reader('reorg') }], now); expect(rows).toHaveLength(2); expect(rows[0]?.blockHash).toBe(`0x${'5'.repeat(64)}`); });
});
