import { describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, zeroAddress, type Address, type Hex, type PublicClient } from 'viem';
import { ALLOWLIST_MINT_ABI, SIGNED_MINT_ABI, SEADROP_EVENTS_ABI, SEADROP_V1_ADDRESS } from '@mint-bot/engine';
import { DurableStore, buildAnalyticsReport, ingestExternalAnalytics, readExternalAnalyticsActivities } from '@mint-bot/backend';
import { createExternalAnalyticsChainPort, EXTERNAL_PUBLIC_MINT_ABI, EXTERNAL_SEAPORT_ABI, EXTERNAL_TRANSFER_ABI } from './external-analytics-chain.js';
import { createOpenSeaExternalAnalyticsCandidates, parseOpenSeaExternalAnalyticsPage, type ExternalAnalyticsFetch } from './external-analytics-opensea.js';

const buyer = `0x${'1'.repeat(40)}` as Address; const seller = `0x${'2'.repeat(40)}` as Address;
const nft = `0x${'3'.repeat(40)}` as Address; const seaport = `0x${'4'.repeat(40)}` as Address;
const feeRecipient = `0x${'5'.repeat(40)}` as Address; const weth = `0x${'6'.repeat(40)}` as Address;
const hash = `0x${'a'.repeat(64)}` as const; const blockHash = `0x${'b'.repeat(64)}` as const;
const now = new Date('2026-11-13T12:00:00Z'); const timestamp = BigInt(now.getTime() / 1000 - 60);
const spent = [{ name: 'itemType', type: 'uint8' }, { name: 'token', type: 'address' }, { name: 'identifier', type: 'uint256' }, { name: 'amount', type: 'uint256' }] as const;
function chainFixture(currency: 'ETH' | 'WETH' | 'other' = 'ETH') {
  const wrapped = currency !== 'ETH'; const token = currency === 'other' ? feeRecipient : wrapped ? weth : zeroAddress;
  const metadata = { blockNumber: 10n, blockHash, transactionHash: hash, removed: false };
  const nftLog = { ...metadata, address: nft, logIndex: 1, data: '0x', topics: encodeEventTopics({ abi: EXTERNAL_TRANSFER_ABI, eventName: 'Transfer', args: { from: seller, to: buyer, tokenId: 7n } }) };
  const orderLog = { ...metadata, address: seaport, logIndex: 2, topics: encodeEventTopics({ abi: EXTERNAL_SEAPORT_ABI, eventName: 'OrderFulfilled', args: { offerer: seller, zone: zeroAddress } }), data: encodeAbiParameters([{ type: 'bytes32' }, { type: 'address' }, { type: 'tuple[]', components: spent }, { type: 'tuple[]', components: [...spent, { name: 'recipient', type: 'address' }] }], [hash, buyer, [{ itemType: 2, token: nft, identifier: 7n, amount: 1n }], [{ itemType: wrapped ? 1 : 0, token, identifier: 0n, amount: 950n, recipient: seller }, { itemType: wrapped ? 1 : 0, token, identifier: 0n, amount: 50n, recipient: feeRecipient }]]) };
  const payment = (to: Address, amount: bigint, logIndex: number) => ({ ...metadata, address: token, logIndex, topics: nftLog.topics.slice(0, 1).concat([`0x${'0'.repeat(24)}${buyer.slice(2)}`, `0x${'0'.repeat(24)}${to.slice(2)}`]) as `0x${string}`[], data: encodeAbiParameters([{ type: 'uint256' }], [amount]) });
  const raw = { transactionHash: hash, from: buyer, to: seaport, status: 'success', blockNumber: 10n, blockHash, transactionIndex: 0, gasUsed: 5n, effectiveGasPrice: 2n, logs: [nftLog, orderLog, ...(wrapped ? [payment(seller, 950n, 3), payment(feeRecipient, 50n, 4)] : [])] };
  const value = wrapped ? 0n : 1000n;
  const client = () => ({ getChainId: vi.fn(async () => 1), getTransaction: vi.fn(async () => ({ hash, from: buyer, to: seaport, blockNumber: 10n, blockHash, value, input: '0x' as Hex })), getTransactionReceipt: vi.fn(async () => structuredClone(raw)), getBlock: vi.fn(async (input: { blockTag?: string }) => ({ number: input.blockTag === 'finalized' ? 12n : 10n, hash: blockHash, timestamp })) });
  const first = client(); const second = client();
  const readers = [{ identity: 'first.example', client: first as unknown as PublicClient }, { identity: 'second.example', client: second as unknown as PublicClient }];
  return { raw, first, second, readers };
}
function mintFixture(method: 'public' | 'allowlist' | 'signed' = 'public') {
  const f = chainFixture(); const metadata = { blockNumber: 10n, blockHash, transactionHash: hash, removed: false };
  const params = { mintPrice: 5n, maxTotalMintableByWallet: 10n, startTime: timestamp - 1n, endTime: timestamp + 3600n, dropStageIndex: 1n, maxTokenSupplyForStage: 1000n, feeBps: 250n, restrictFeeRecipients: true };
  const data = method === 'public' ? encodeFunctionData({ abi: EXTERNAL_PUBLIC_MINT_ABI, functionName: 'mintPublic', args: [nft, feeRecipient, zeroAddress, 3n] }) : method === 'allowlist' ? encodeFunctionData({ abi: ALLOWLIST_MINT_ABI, functionName: 'mintAllowList', args: [nft, feeRecipient, zeroAddress, 3n, params, []] }) : encodeFunctionData({ abi: SIGNED_MINT_ABI, functionName: 'mintSigned', args: [nft, feeRecipient, zeroAddress, 3n, params, 42n, `0x${'1'.repeat(130)}`] });
  f.raw.to = SEADROP_V1_ADDRESS;
  f.raw.logs = [7n, 8n, 9n].map((tokenId, index) => ({ ...metadata, address: nft, logIndex: index + 1, data: '0x', topics: encodeEventTopics({ abi: EXTERNAL_TRANSFER_ABI, eventName: 'Transfer', args: { from: zeroAddress, to: buyer, tokenId } }) }));
  f.raw.logs.push({ ...metadata, address: SEADROP_V1_ADDRESS, logIndex: 4, topics: encodeEventTopics({ abi: SEADROP_EVENTS_ABI, eventName: 'SeaDropMint', args: { nftContract: nft, minter: buyer, feeRecipient } }), data: encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [buyer, 3n, 5n, 250n, method === 'public' ? 0n : 1n]) });
  const transaction = { hash, from: buyer, to: SEADROP_V1_ADDRESS, blockNumber: 10n, blockHash, value: 15n, input: data };
  f.first.getTransaction.mockResolvedValue(transaction); f.second.getTransaction.mockResolvedValue(transaction);
  return { ...f, transaction };
}
function candidates(fetcher: ExternalAnalyticsFetch) { return createOpenSeaExternalAnalyticsCandidates({ apiKey: ['synthetic', 'analytics'].join('-'), fetcher, sleep: async () => undefined, now: () => now }); }
const response = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
const events = { asset_events: [{ chain: 'ethereum', event_type: 'sale', transaction: hash, event_timestamp: Number(timestamp), payment: { quantity: '999999999999999999999999' } }], next: null };

describe('official external account candidate discovery', () => {
  it('uses fixed-origin GET with bounded scope and opaque encoded cursor; ignores alleged API economics', async () => {
    const fetcher = vi.fn(async () => response(events)); const port = candidates(fetcher);
    expect(await port.page({ chainId: 1, wallet: buyer, after: 0, before: Number(now.getTime() / 1000), cursor: 'https://other.invalid/?key=x' })).toMatchObject({ candidates: [{ transactionHash: hash }], coverage: 'partial' });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, { method: string; redirect: string }];
    expect(new URL(url).origin).toBe('https://api.opensea.io'); expect(new URL(url).pathname).toBe(`/api/v2/events/accounts/${buyer}`);
    expect(new URL(url).searchParams.get('next')).toBe('https://other.invalid/?key=x'); expect(init).toMatchObject({ method: 'GET', redirect: 'error' });
  });
  it('reports malformed/cross-chain/out-of-window candidate rows as unknown coverage', () => {
    const result = parseOpenSeaExternalAnalyticsPage({ asset_events: [...events.asset_events, { ...events.asset_events[0], chain: 'base' }, { ...events.asset_events[0], transaction: 'bad' }] }, { chainId: 1, after: 0, before: now.getTime() / 1000 });
    expect(result).toMatchObject({ candidates: [{ transactionHash: hash }], coverage: 'unknown', code: 'EXTERNAL_OPENSEA_RECORDS_OMITTED' });
    expect(() => parseOpenSeaExternalAnalyticsPage({ asset_events: [], next: '\nunsafe' }, { chainId: 1, after: 0, before: 1 })).toThrow();
  });
  it('rate limits globally without a hidden fallback provider', async () => {
    const fetcher = vi.fn(async () => ({ ok: false, status: 429, headers: { get: () => '60' }, text: async () => '' })); const port = candidates(fetcher);
    const input = { chainId: 1 as const, wallet: buyer, after: 0, before: 1 };
    await expect(port.page(input)).rejects.toThrow('EXTERNAL_OPENSEA_RATE_LIMITED'); await expect(port.page(input)).rejects.toThrow('EXTERNAL_OPENSEA_RATE_LIMITED'); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('enforces a body limit, timeout and sanitized errors', async () => {
    const huge = candidates(async () => ({ ok: true, status: 200, headers: { get: () => '2000000' }, text: async () => '' }));
    await expect(huge.page({ chainId: 1, wallet: buyer, after: 0, before: 1 })).rejects.toThrow('EXTERNAL_OPENSEA_RESPONSE_TOO_LARGE');
    const stalled = createOpenSeaExternalAnalyticsCandidates({ apiKey: ['synthetic'].join(''), timeoutMs: 5, fetcher: async () => new Promise(() => undefined) });
    await expect(stalled.page({ chainId: 1, wallet: buyer, after: 0, before: 1 })).rejects.toThrow('EXTERNAL_OPENSEA_UNAVAILABLE');
    const failing = candidates(async () => { throw new Error('https://credential.invalid/secret'); });
    await expect(failing.page({ chainId: 1, wallet: buyer, after: 0, before: 1 })).rejects.toThrow('EXTERNAL_OPENSEA_UNAVAILABLE');
  });
});

describe('independent chain evidence and actual ingestion composition', () => {
  it.each(['ETH', 'WETH'] as const)('derives %s economics from actual Seaport/transfer logs through discovery, durable ingestion and FIFO', async currency => {
    const fixture = chainFixture(currency); const store = new DurableStore(); await store.open();
    const chainPort = createExternalAnalyticsChainPort({ chainId: 1, readers: fixture.readers, seaportAddresses: [seaport], wethAddress: weth });
    await ingestExternalAnalytics({ store, wallets: async () => [{ chainId: 1, address: buyer }], candidatePort: candidates(async () => response(events)), chainPort: async () => chainPort, now: () => now });
    const read = readExternalAnalyticsActivities(store.eventSnapshot());
    expect(read.activities).toMatchObject([{ kind: 'acquisition', costWei: '1000', gasWei: '10', tokenId: '7' }]);
    expect(buildAnalyticsReport({ activities: read.activities, now }).holdings[0]!.basisWei).toBe('1010');
    expect(JSON.stringify(read)).not.toContain('999999999999999999999999');
    expect(fixture.first.getChainId).toHaveBeenCalledTimes(2); expect(fixture.second.getTransactionReceipt).toHaveBeenCalledTimes(1);
  });
  it.each(['wrong-chain', 'receipt-drift', 'log-drift', 'unfinalized', 'reorg-during-finality'] as const)('fails closed for %s', async mode => {
    const f = chainFixture();
    if (mode === 'wrong-chain') f.second.getChainId.mockResolvedValue(8453);
    if (mode === 'receipt-drift') f.second.getTransactionReceipt.mockResolvedValue({ ...f.raw, gasUsed: 6n });
    if (mode === 'log-drift') f.raw.logs[0]!.transactionHash = `0x${'c'.repeat(64)}` as typeof hash;
    if (mode === 'unfinalized') { f.first.getBlock.mockResolvedValue({ number: 9n, hash: blockHash, timestamp }); f.second.getBlock.mockResolvedValue({ number: 9n, hash: blockHash, timestamp }); }
    const port = createExternalAnalyticsChainPort({ chainId: 1, readers: f.readers, seaportAddresses: [seaport], ...(mode === 'reorg-during-finality' ? { finality: async () => { f.first.getBlock.mockResolvedValue({ number: 10n, hash: `0x${'c'.repeat(64)}` as typeof blockHash, timestamp }); return true; } } : {}) });
    await expect(port.observe(hash)).rejects.toThrow(/^EXTERNAL_ANALYTICS_/);
  });
  it('requires authoritative L2 finality and leaves missing full L2 fees unknown', async () => {
    const f = chainFixture(); f.first.getChainId.mockResolvedValue(8453); f.second.getChainId.mockResolvedValue(8453);
    const options = { chainId: 8453 as const, readers: f.readers, seaportAddresses: [seaport] };
    await expect(createExternalAnalyticsChainPort(options).observe(hash)).rejects.toThrow('EXTERNAL_ANALYTICS_FINALITY_UNPROVEN');
    expect(await createExternalAnalyticsChainPort({ ...options, finality: async () => true }).observe(hash)).toMatchObject({ chainId: 8453, transactionFeeWei: null });
    await expect(createExternalAnalyticsChainPort({ ...options, finality: async () => true, totalFeeWei: () => 5n }).observe(hash)).rejects.toThrow('EXTERNAL_ANALYTICS_FEES_INVALID');
  });
  it('ingests an actual ERC1155 single transfer with its exact quantity and unknown acquisition consideration', async () => {
    const f = chainFixture(); const original = f.raw.logs[0]!;
    f.raw.logs = [{ ...original, topics: encodeEventTopics({ abi: EXTERNAL_TRANSFER_ABI, eventName: 'TransferSingle', args: { operator: buyer, from: seller, to: buyer } }), data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [7n, 3n]) }];
    const port = createExternalAnalyticsChainPort({ chainId: 1, readers: f.readers, seaportAddresses: [seaport] }); const store = new DurableStore(); await store.open();
    await ingestExternalAnalytics({ store, wallets: async () => [{ chainId: 1, address: buyer }], candidatePort: candidates(async () => response(events)), chainPort: async () => port, now: () => now });
    const read = readExternalAnalyticsActivities(store.eventSnapshot()); expect(read.activities).toMatchObject([{ quantity: '3', tokenId: '7', kind: 'acquisition', costWei: null }]); expect(read.coverage.issues).toContain('EXTERNAL_ACQUISITION_BASIS_UNKNOWN');
  });
  it.each(['unknown-currency', 'bundle', 'missing-weth-payment', 'unknown-protocol', 'aggregator'] as const)('leaves %s settlement explicitly unsupported', async mode => {
    const f = chainFixture(mode === 'unknown-currency' ? 'other' : mode === 'missing-weth-payment' ? 'WETH' : 'ETH');
    if (mode === 'bundle') f.raw.logs.push({ ...f.raw.logs[0]!, logIndex: 5 });
    if (mode === 'missing-weth-payment') f.raw.logs.pop();
    if (mode === 'aggregator') { f.raw.to = buyer; f.first.getTransaction.mockResolvedValue({ hash, from: buyer, to: buyer, blockNumber: 10n, blockHash, value: 1000n, input: '0x' }); f.second.getTransaction.mockResolvedValue({ hash, from: buyer, to: buyer, blockNumber: 10n, blockHash, value: 1000n, input: '0x' }); }
    const proof = await createExternalAnalyticsChainPort({ chainId: 1, readers: f.readers, seaportAddresses: mode === 'unknown-protocol' ? [] : [seaport], wethAddress: weth }).observe(hash);
    expect(proof.settlements).toHaveLength(0); expect(proof.issues).toContain('EXTERNAL_SEAPORT_ECONOMICS_UNSUPPORTED');
  });
  it('rejects a single reader identity or duplicate client', () => {
    const f = chainFixture();
    expect(() => createExternalAnalyticsChainPort({ chainId: 1, readers: [f.readers[0]!, f.readers[0]!], seaportAddresses: [] })).toThrow('EXTERNAL_ANALYTICS_INDEPENDENT_READERS_REQUIRED');
  });
  it('exposes no sending or signing method on the chain adapter', () => {
    const f = chainFixture(); expect(Object.keys(createExternalAnalyticsChainPort({ chainId: 1, readers: f.readers, seaportAddresses: [] }))).toEqual(['observe']);
  });
  it.each(['public', 'allowlist', 'signed'] as const)('accounts for verified historical direct %s SeaDrop mints, splitting value and gas without retaining authorization data', async method => {
    const f = mintFixture(method); const store = new DurableStore(); await store.open(); const port = createExternalAnalyticsChainPort({ chainId: 1, readers: f.readers, seaportAddresses: [] });
    await ingestExternalAnalytics({ store, wallets: async () => [{ chainId: 1, address: buyer }], candidatePort: candidates(async () => response(events)), chainPort: async () => port, now: () => now });
    const read = readExternalAnalyticsActivities(store.eventSnapshot());
    expect(read.activities.map(row => row.kind === 'acquisition' ? row.costWei : null)).toEqual(['5', '5', '5']);
    expect(read.activities.map(row => row.gasWei)).toEqual(['3', '3', '4']);
    expect(buildAnalyticsReport({ activities: read.activities, now }).holdings.map(row => row.basisWei)).toEqual(['8', '8', '9']);
    expect(JSON.stringify(store.eventSnapshot())).not.toContain(f.transaction.input); expect(read.coverage.completeTransactions).toBe(1);
  });
  it('rejects differing RPC transaction input before assigning mint cost', async () => {
    const f = mintFixture(); f.second.getTransaction.mockResolvedValue({ ...f.transaction, input: '0x12345678' });
    await expect(createExternalAnalyticsChainPort({ chainId: 1, readers: f.readers, seaportAddresses: [] }).observe(hash)).rejects.toThrow('EXTERNAL_ANALYTICS_RPC_DISAGREEMENT');
  });
  it.each(['wrong-value', 'missing-mint-event', 'wrong-quantity', 'unknown-selector', 'other-target', 'duplicate-token', 'sponsored', 'payer-mismatch'] as const)('leaves historical mint basis unknown for %s', async mode => {
    const f = mintFixture();
    const transaction = { ...f.transaction, ...(mode === 'wrong-value' ? { value: 16n } : {}), ...(mode === 'unknown-selector' ? { input: '0x12345678' as Hex } : {}), ...(mode === 'other-target' ? { to: seaport } : {}), ...(mode === 'sponsored' ? { input: encodeFunctionData({ abi: EXTERNAL_PUBLIC_MINT_ABI, functionName: 'mintPublic', args: [nft, feeRecipient, seller, 3n] }) } : {}) };
    f.first.getTransaction.mockResolvedValue(transaction); f.second.getTransaction.mockResolvedValue(transaction);
    if (mode === 'missing-mint-event') f.raw.logs.pop();
    if (mode === 'wrong-quantity') f.raw.logs.shift();
    if (mode === 'other-target') f.raw.to = seaport;
    if (mode === 'duplicate-token') f.raw.logs[1]!.topics = [...f.raw.logs[0]!.topics];
    if (mode === 'payer-mismatch') f.raw.logs.at(-1)!.data = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [seller, 3n, 5n, 250n, 0n]);
    const proof = await createExternalAnalyticsChainPort({ chainId: 1, readers: f.readers, seaportAddresses: [] }).observe(hash); expect(proof.mintCost).toBeUndefined();
  });
});

// Wire-shaped synthetic records derived from the official SDK BaseEvent and three
// concrete event variants (src/api/types.ts lines469–650); the SDK camelizes,
// whereas our direct GET adapter receives event_type/event_timestamp unchanged.
it('reads the primary documented OpenSea sale/transfer/mint account variants as discovery candidates',()=>{
 const base={chain:'ethereum',event_timestamp:1700000000,quantity:1,nft:{identifier:'7',collection:'synthetic',contract:nft,token_standard:'erc721',chain:'ethereum'}};
 const asset_events=[{...base,event_type:'sale',transaction:hash,order_hash:hash,protocol_address:seaport,payment:{quantity:'1000',decimals:18,symbol:'ETH',token_address:zeroAddress},closing_date:1700000000,seller,buyer},{...base,event_type:'transfer',transaction:`0x${'c'.repeat(64)}`,from_address:seller,to_address:buyer},{...base,event_type:'mint',transaction:`0x${'d'.repeat(64)}`,to_address:buyer}];
 expect(parseOpenSeaExternalAnalyticsPage({asset_events,next:null},{chainId:1,after:1699999999,before:1700000001})).toMatchObject({candidates:[{transactionHash:hash},{transactionHash:`0x${'c'.repeat(64)}`},{transactionHash:`0x${'d'.repeat(64)}`}],coverage:'partial'});
});
