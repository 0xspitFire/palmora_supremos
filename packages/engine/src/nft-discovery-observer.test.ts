import { describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, getContractAddress, keccak256, stringToHex } from 'viem';
import { NFTDiscoveryObserver, assertVerifiedNFTObservation, type NFTDiscoveryReader, type NFTMonitorCandidate, type NFTObservedLog } from './nft-discovery-observer.js';
const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const topic = (address: string) => `0x${address.slice(2).padStart(64, '0')}`;
const wallet = addr(1), contract = addr(2), txHash = hash(3), blockHash = hash(4);
const now = () => new Date('2026-11-13T12:00:00Z');
const timestamp = BigInt(now().getTime() / 1000 - 5);
function fixture(logs?: NFTObservedLog[]) {
  const minted: NFTObservedLog = { address: contract, topics: [keccak256(stringToHex('Transfer(address,address,uint256)')), hash(0), topic(wallet), hash(7)], data: '0x', logIndex: 0, transactionHash: txHash, blockNumber: 98n, blockHash };
  const tx = { hash: txHash, from: wallet, to: contract, nonce: 0, blockNumber: 98n, blockHash };
  const receipt = { transactionHash: txHash, from: wallet, to: contract, contractAddress: null, status: 'success' as const, blockNumber: 98n, blockHash, logs: logs ?? [minted] };
  const make = (): NFTDiscoveryReader => ({ chainId: vi.fn(async () => 1), head: vi.fn(async () => 100n), block: vi.fn(async (number, full) => ({ number, hash: blockHash, timestamp, ...(full ? { transactions: [] } : {}) })), logs: vi.fn(async input => (logs ?? [minted]).filter(log => log.topics[0] === input.topics[0])), transaction: vi.fn(async () => tx), receipt: vi.fn(async () => receipt), code: vi.fn(async () => '0x6000'), supportsInterface: vi.fn(async (_address, id) => id === '0x01ffc9a7' || id === '0x80ac58cd') });
  const left = make(), right = make();
  const observer = new NFTDiscoveryObserver({ chainId: 1, readers: [{ endpoint: 'https://a.example', client: left }, { endpoint: 'https://b.example', client: right }], now });
  const candidate: NFTMonitorCandidate = { version: 1, kind: 'mint', chainId: 1, transactionHash: txHash, blockNumber: '98', blockHash, logIndex: 0, contract, wallet, standard: 'erc721' };
  return { observer, left, right, candidate, minted, receipt, tx };
}
describe('generic NFT observer', () => {
  it('verifies two-reader successful self mint, brands facts, and leaves strategy unknown', async () => {
    const f = fixture(); f.observer.beginTick(); const result = await f.observer.verify(f.candidate, [wallet]);
    expect(result.status).toBe('verified'); if (result.status !== 'verified') return;
    expect(result.observation).toMatchObject({ quantity: '1', stage: 'unknown', priceWei: null, strategy: 'unsupported', blockTimestamp: new Date(Number(timestamp) * 1000).toISOString() });
    expect(() => assertVerifiedNFTObservation(result.observation)).not.toThrow();
    expect(() => assertVerifiedNFTObservation({ ...result.observation })).toThrow('VERIFIED_OBSERVATION_REQUIRED');
    expect(f.observer.callsUsed).toBe(22);
  });
  it.each(['sender', 'revert', 'interface', 'reorg'] as const)('rejects %s evidence', async variant => {
    const f = fixture(); if (variant === 'sender') f.tx.from = addr(9); if (variant === 'revert') (f.receipt as { status: string }).status = 'reverted';
    if (variant === 'interface') f.right.supportsInterface = vi.fn(async () => true);
    if (variant === 'reorg') f.right.block = vi.fn(async number => ({ number, hash: hash(999), timestamp }));
    f.observer.beginTick(); expect((await f.observer.verify(f.candidate, [wallet])).status).not.toBe('verified');
  });
  it('excludes ERC20 Transfer and nonzero-from transfers', async () => {
    const f = fixture(); const erc20 = { ...f.minted, topics: f.minted.topics.slice(0, 3), data: hash(100) };
    const transfer = { ...f.minted, topics: [f.minted.topics[0]!, topic(addr(10)), topic(wallet), hash(7)] };
    const g = fixture([erc20, transfer]); g.observer.beginTick(); expect((await g.observer.scan({ fromBlock: '98', watched: [wallet], maxCandidates: 10 })).candidates).toEqual([]);
  });
  it('bounds 137-wallet scan calls and distinguishes 256 log blocks from two sampled deployment blocks', async () => {
    const f = fixture([]); f.observer.beginTick(); const scan = await f.observer.scan({ fromBlock: '0', watched: Array.from({ length: 137 }, (_, i) => addr(i + 1)), maxCandidates: 32 });
    expect(scan.toBlock).toBe('98'); expect(scan.callsUsed).toBe(30); expect(scan.deploymentBlocksOmitted).toBe('97');
    expect(scan.partialReasons).toContain('DEPLOYMENT_BLOCK_SAMPLING'); expect(scan.factoryCoverage).toBe('not-observed');
    expect(f.left.logs).toHaveBeenCalledTimes(9);
  });
  it('resumes capped candidates at exact log offset without dropping range tail', async () => {
    const f = fixture(); const rows = [f.minted, { ...f.minted, logIndex: 1, transactionHash: hash(8) }];
    const g = fixture(rows); g.observer.beginTick(); const first = await g.observer.scan({ fromBlock: '98', watched: [wallet], maxCandidates: 1 });
    expect(first.continuation?.offset).toBe(1); g.observer.beginTick();
    const second = await g.observer.scan({ watched: [wallet], maxCandidates: 2, continuation: first.continuation });
    expect(second.candidates.map(c => c.logIndex)).toEqual([1]); expect(second.continuation).toBeUndefined();
  });
  it('restarts retained range offsets on a two-reader range-anchor reorg', async () => {
    const f = fixture(); const rows = [f.minted, { ...f.minted, logIndex: 1 }]; const g = fixture(rows);
    g.observer.beginTick(); const first = await g.observer.scan({ fromBlock: '98', watched: [wallet], maxCandidates: 1 });
    expect(first.continuation?.offset).toBe(1); expect(first.continuation?.rangeEndHash).toBe(blockHash);
    for (const reader of [g.left, g.right]) reader.block = vi.fn(async (number, full) => ({ number, hash: hash(111), timestamp, ...(full ? { transactions: [] } : {}) }));
    g.observer.beginTick(); const second = await g.observer.scan({ watched: [wallet], maxCandidates: 1, continuation: first.continuation });
    expect(second.candidates[0]?.logIndex).toBe(0); expect(second.continuation?.rangeEndHash).toBe(hash(111));
  });
  it('rejects contradictory bytecode evidence and malformed resume offsets', async () => {
    const f = fixture(); f.right.code = vi.fn(async () => '0x6001'); f.observer.beginTick();
    expect((await f.observer.verify(f.candidate, [wallet])).status).not.toBe('verified');
    f.observer.beginTick(); await expect(f.observer.scan({ watched: [wallet], maxCandidates: 1, continuation: { fromBlock: '98', toBlock: '98', watchlistDigest: keccak256(stringToHex(wallet)), phase: 'logs', queryIndex: 0, offset: 2000, deploymentBlockIndex: 0, rangeEndHash: blockHash } })).rejects.toThrow('CONTINUATION_INVALID');
  });
  it('halves an oversized provider log range without advancing coverage', async () => {
    const f = fixture([]); f.left.logs = vi.fn(async () => { throw new Error('NFT_MONITOR_RANGE_LIMIT'); }); f.observer.beginTick();
    const result = await f.observer.scan({ fromBlock: '0', watched: [wallet], maxCandidates: 10 });
    expect(result.toBlock).toBe('49'); expect(result.continuation?.fromBlock).toBe('0'); expect(result.continuation?.queryIndex).toBe(0);
  });
  it('accepts canonical ERC1155 batches and rejects padded ABI garbage', async () => {
    const f = fixture(); const data = encodeAbiParameters([{ type: 'uint256[]' }, { type: 'uint256[]' }], [[1n, 2n], [3n, 4n]]);
    const log = { ...f.minted, topics: [keccak256(stringToHex('TransferBatch(address,address,address,uint256[],uint256[])')), topic(wallet), hash(0), topic(wallet)], data };
    const g = fixture([log]); g.left.supportsInterface = g.right.supportsInterface = vi.fn(async (_address, id) => id === '0x01ffc9a7' || id === '0xd9b67a26');
    g.observer.beginTick(); const result = await g.observer.verify({ ...g.candidate, standard: 'erc1155' }, [wallet]);
    expect(result.status).toBe('verified'); if (result.status === 'verified') expect(result.observation.quantity).toBe('7');
    const bad = fixture([{ ...log, data: `${data}${'0'.repeat(64)}` }]); bad.observer.beginTick(); expect((await bad.observer.scan({ fromBlock: '98', watched: [wallet], maxCandidates: 10 })).candidates).toEqual([]);
  });
  it('verifies top-level CREATE address and NFT interfaces', async () => {
    const f = fixture(); f.tx.to = null as unknown as string; f.receipt.to = null as unknown as string;
    f.receipt.contractAddress = getContractAddress({ from: wallet as `0x${string}`, nonce: 0n }) as unknown as null;
    f.observer.beginTick(); const result = await f.observer.verify({ ...f.candidate, kind: 'deployment' }, [wallet]); expect(result.status).toBe('verified');
    if (result.status === 'verified') expect(result.observation).toMatchObject({ kind: 'deployment', quantity: '0', factoryCoverage: 'not-observed' });
  });
  it('fails closed for same endpoint hosts and hard call budgets', async () => {
    const f = fixture(); expect(() => new NFTDiscoveryObserver({ chainId: 1, readers: [{ endpoint: 'https://a.example/1', client: f.left }, { endpoint: 'https://a.example/2', client: f.right }] })).toThrow();
    f.observer.beginTick(); await f.observer.verify(f.candidate, [wallet]); await f.observer.verify(f.candidate, [wallet]);
    expect(await f.observer.verify(f.candidate, [wallet])).toMatchObject({ status: 'unavailable', code: 'NFT_MONITOR_CALL_BUDGET_EXHAUSTED' }); expect(f.observer.callsUsed).toBe(44);
  });
});
