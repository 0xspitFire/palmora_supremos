import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, pad, parseAbi, zeroAddress, type Address, type Hex } from 'viem';
import type { ChainFact, ChainHead, ChainLog, ChainLogFilter } from './chain-facts.js';
import { SEADROP_V1_ADDRESS } from './chains.js';
import { ERC721_TRANSFER_TOPIC, PUBLIC_DROP_UPDATED_TOPIC, SEADROP_EVENTS_ABI, SEADROP_MINT_TOPIC, SeaDropObserver, type LogSource } from './seadrop-observer.js';

const NFT = '0x3333333333333333333333333333333333333333' as Address;
const MINTER = '0x4444444444444444444444444444444444444444' as Address;
const FEE = '0x0000a26b00c1f0df003000390027140000faa719' as Address;
const WHALE = '0x5555555555555555555555555555555555555555' as Address;

function fact<T>(value: T | null): ChainFact<T> {
  return { kind: 'logs', value, availability: value === null ? 'unavailable' : 'available', freshness: { status: 'fresh', observedAt: 'x', expiresAt: null, ageMs: 0 }, provenance: [] } as unknown as ChainFact<T>;
}

function log(address: Address, topics: Hex[], data: Hex, blockNumber = 100n, logIndex = 0, removed = false): ChainLog {
  return { address, topics, data, blockNumber, blockHash: `0x${'b'.repeat(64)}`, transactionHash: `0x${'a'.repeat(64)}`, logIndex, removed };
}

function mintLog(quantity = 2n, price = 0n, blockNumber = 100n): ChainLog {
  const topics = encodeEventTopics({ abi: SEADROP_EVENTS_ABI, eventName: 'SeaDropMint', args: { nftContract: NFT, minter: MINTER, feeRecipient: FEE } }) as Hex[];
  const data = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [MINTER, quantity, price, 1000n, 0n]);
  return log(SEADROP_V1_ADDRESS, topics, data, blockNumber);
}

function dropLog(): ChainLog {
  const topics = encodeEventTopics({ abi: SEADROP_EVENTS_ABI, eventName: 'PublicDropUpdated', args: { nftContract: NFT } }) as Hex[];
  const data = encodeAbiParameters([{ type: 'tuple', components: [{ name: 'mintPrice', type: 'uint80' }, { name: 'startTime', type: 'uint48' }, { name: 'endTime', type: 'uint48' }, { name: 'maxTotalMintableByWallet', type: 'uint16' }, { name: 'feeBps', type: 'uint16' }, { name: 'restrictFeeRecipients', type: 'bool' }] }], [{ mintPrice: 3_700_000_000_000_000n, startTime: 1_800_000_000, endTime: 1_800_086_400, maxTotalMintableByWallet: 5, feeBps: 1000, restrictFeeRecipients: true }]);
  return log(SEADROP_V1_ADDRESS, topics, data, 101n, 1);
}

function transferLog(to: Address, tokenId: bigint, fourTopics = true): ChainLog {
  const topics = encodeEventTopics({ abi: parseAbi(['event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)']), eventName: 'Transfer', args: { from: zeroAddress, to, tokenId } }) as Hex[];
  return log(NFT, fourTopics ? topics : topics.slice(0, 3), fourTopics ? '0x' : encodeAbiParameters([{ type: 'uint256' }], [tokenId]), 102n, 2);
}

class FixedSource implements LogSource {
  public readonly filters: ChainLogFilter[] = [];
  public constructor(private readonly head: bigint | null, private readonly seaDropLogs: ChainLog[] | null, private readonly watchedLogs: ChainLog[] | null = []) {}
  public async readHead(): Promise<ChainFact<ChainHead>> { return fact(this.head === null ? null : { number: this.head }); }
  public async readLogs(filter: ChainLogFilter): Promise<ChainFact<readonly ChainLog[]>> {
    this.filters.push(filter);
    return fact(filter.address === undefined ? this.watchedLogs : this.seaDropLogs);
  }
}

describe('SeaDropObserver', () => {
  it('decodes public mints, drop updates and watched ERC-721 mints from encoded logs', async () => {
    const source = new FixedSource(200n, [mintLog(2n, 0n), dropLog()], [transferLog(WHALE, 7n)]);
    const outcome = await new SeaDropObserver(source).scan(100n, 150n, [WHALE]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.mints).toEqual([expect.objectContaining({ nftContract: NFT, minter: MINTER, payer: MINTER, quantity: 2n, unitMintPriceWei: 0n, blockNumber: 100n })]);
    expect(outcome.result.dropUpdates).toEqual([expect.objectContaining({ nftContract: NFT, mintPriceWei: 3_700_000_000_000_000n, startTime: 1_800_000_000, endTime: 1_800_086_400, maxTotalMintableByWallet: 5, restrictFeeRecipients: true })]);
    expect(outcome.result.watchedMints).toEqual([expect.objectContaining({ nftContract: NFT, recipient: WHALE, tokenId: 7n })]);
    expect(outcome.result.undecodable).toBe(0);
  });

  it('filters by the SeaDrop singleton and both event topics, and by mint-from-zero to watched addresses', async () => {
    const source = new FixedSource(200n, [], []);
    await new SeaDropObserver(source).scan(10n, 20n, [WHALE]);
    expect(source.filters[0]).toEqual({ address: SEADROP_V1_ADDRESS, fromBlock: 10n, toBlock: 20n, topics: [[SEADROP_MINT_TOPIC, PUBLIC_DROP_UPDATED_TOPIC]] });
    expect(source.filters[1]).toEqual({ fromBlock: 10n, toBlock: 20n, topics: [ERC721_TRANSFER_TOPIC, pad(zeroAddress), [pad(WHALE)]] });
  });

  it('skips the watched query when nothing is watched', async () => {
    const source = new FixedSource(200n, []);
    await new SeaDropObserver(source).scan(10n, 20n);
    expect(source.filters).toHaveLength(1);
  });

  it('caps the scanned range and reports the block actually reached', async () => {
    const source = new FixedSource(10_000n, []);
    const outcome = await new SeaDropObserver(source, { maxRange: 100n }).scan(1_000n, 5_000n);
    expect(outcome).toMatchObject({ ok: true, result: { fromBlock: 1_000n, toBlock: 1_099n } });
    expect(source.filters[0]).toMatchObject({ fromBlock: 1_000n, toBlock: 1_099n });
  });

  it('fails the whole scan when logs are unavailable or reorged, and on an invalid range', async () => {
    expect(await new SeaDropObserver(new FixedSource(200n, null)).scan(1n, 2n)).toEqual({ ok: false, reason: 'LOGS_UNAVAILABLE' });
    expect(await new SeaDropObserver(new FixedSource(200n, [], null)).scan(1n, 2n, [WHALE])).toEqual({ ok: false, reason: 'LOGS_UNAVAILABLE' });
    expect(await new SeaDropObserver(new FixedSource(200n, [{ ...mintLog(), removed: true }])).scan(1n, 2n)).toEqual({ ok: false, reason: 'REORGED_LOG' });
    expect(await new SeaDropObserver(new FixedSource(200n, [])).scan(5n, 4n)).toEqual({ ok: false, reason: 'INVALID_RANGE' });
  });

  it('counts but never guesses logs it cannot decode', async () => {
    const foreign = { ...mintLog(), address: NFT };
    const garbage = log(SEADROP_V1_ADDRESS, [SEADROP_MINT_TOPIC], '0x1234');
    const unpositioned = { ...mintLog(), blockNumber: null };
    const erc20Style = transferLog(WHALE, 1n, false);
    const outcome = await new SeaDropObserver(new FixedSource(200n, [foreign, garbage, unpositioned], [erc20Style])).scan(1n, 200n, [WHALE]);
    expect(outcome).toMatchObject({ ok: true, result: { mints: [], dropUpdates: [], watchedMints: [], undecodable: 3, ignored: 1 } });
  });

  it('drops logs outside the requested block range', async () => {
    const outcome = await new SeaDropObserver(new FixedSource(200n, [mintLog(2n, 0n, 500n)], [])).scan(100n, 150n);
    expect(outcome).toMatchObject({ ok: true, result: { mints: [], ignored: 1 } });
  });

  it('drops logs a node returns outside the requested filter instead of trusting them', async () => {
    const strayForWatched = { ...mintLog(), address: NFT };
    const otherRecipient = transferLog(MINTER, 9n);
    const outcome = await new SeaDropObserver(new FixedSource(200n, [log(SEADROP_V1_ADDRESS, [ERC721_TRANSFER_TOPIC], '0x')], [strayForWatched, otherRecipient, transferLog(WHALE, 3n)])).scan(1n, 200n, [WHALE]);
    expect(outcome).toMatchObject({ ok: true, result: { undecodable: 0, ignored: 3, watchedMints: [expect.objectContaining({ recipient: WHALE, tokenId: 3n })] } });
  });

  it('reports the confirmed head behind the configured depth, and null when unknown', async () => {
    expect(await new SeaDropObserver(new FixedSource(200n, []), { confirmations: 3n }).safeHead()).toBe(197n);
    expect(await new SeaDropObserver(new FixedSource(1n, []), { confirmations: 3n }).safeHead()).toBe(0n);
    expect(await new SeaDropObserver(new FixedSource(null, [])).safeHead()).toBeNull();
    expect(() => new SeaDropObserver(new FixedSource(1n, []), { maxRange: 0n })).toThrow('SEADROP_OBSERVER_OPTIONS_INVALID');
  });
});
