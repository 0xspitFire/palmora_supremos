import type { AdvancedReadContext } from './advanced-intelligence.js';
import type { SourcedFact } from '@mint-bot/backend';

export interface CreationFactsReader {
  chainId(): Promise<number>;
  transaction(hash: string): Promise<{ hash: string; to: string | null; blockNumber: bigint | null; blockHash: string | null }>;
  receipt(hash: string): Promise<{ transactionHash: string; status: string; contractAddress: string | null; blockNumber: bigint; blockHash: string }>;
  block(number: bigint): Promise<{ hash: string | null; timestamp: bigint }>;
}
/** An explorer may suggest the creation hash. Two approved RPC readers authenticate
 * the actual top-level successful contract creation and its canonical block.
 * Factory/internal creation requires its own reviewed adapter, not this shortcut.
 */
export async function readVerifiedContractCreation(context: AdvancedReadContext, creationHash: string, readers: readonly CreationFactsReader[]): Promise<SourcedFact<string> | undefined> {
  if (!/^0x[0-9a-f]{64}$/i.test(creationHash) || readers.length < 2 || readers[0] === readers[1]) return undefined;
  try {
    const values = await Promise.all(readers.slice(0, 2).map(async reader => {
      context.consumeRpc(3);
      const [chain, tx, receipt] = await Promise.all([reader.chainId(), reader.transaction(creationHash), reader.receipt(creationHash)]);
      if (chain !== context.chainId || tx.hash.toLowerCase() !== creationHash.toLowerCase() || tx.to !== null || receipt.transactionHash.toLowerCase() !== creationHash.toLowerCase() || receipt.status !== 'success' || receipt.contractAddress?.toLowerCase() !== context.contract.toLowerCase() || tx.blockNumber !== receipt.blockNumber || tx.blockHash?.toLowerCase() !== receipt.blockHash.toLowerCase()) throw new Error('ADVANCED_CREATION_BINDING_INVALID');
      context.consumeRpc(); const block = await reader.block(receipt.blockNumber);
      if (!block.hash || block.hash.toLowerCase() !== receipt.blockHash.toLowerCase() || block.timestamp < 0n || block.timestamp * 1000n > BigInt(context.now.getTime())) throw new Error('ADVANCED_CREATION_BLOCK_INVALID');
      return { blockHash: block.hash.toLowerCase(), timestamp: block.timestamp.toString() };
    }));
    if (JSON.stringify(values[0]) !== JSON.stringify(values[1])) return undefined;
    return { chainId: context.chainId, contract: context.contract, value: new Date(Number(BigInt(values[0]!.timestamp)) * 1000).toISOString(), observedAt: context.now.toISOString(), expiresAt: new Date(context.now.getTime() + 24 * 3_600_000).toISOString(), sourceReference: `creation:${creationHash.toLowerCase()}` };
  } catch { return undefined; }
}
