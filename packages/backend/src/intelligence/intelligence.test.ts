import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { IntelligenceRepository, openDatabase } from '@mint-bot/database';
import { AlertManager } from '../alerts.js';
import { CanonicalStoreBridge } from '../canonical-store.js';
import { DurableStore } from '../store.js';
import type { BackendStore } from '../store.js';
import { DiscoveryService } from './discovery.js';
import type { ChainScanOutcome, DropSnapshot, IntelligenceChainPort, IntelligenceRepositoryPort, ObservedDropUpdate, ObservedMint, ObservedWatchedMint, SimulationOutcome } from './port.js';
import { ReadinessSweep } from './readiness.js';
import { Phase2ReadModelService } from '../read-model-v1.js';

const NFT = '0x3333333333333333333333333333333333333333';
const PAID_NFT = '0x6666666666666666666666666666666666666666';
const WHALE = '0x5555555555555555555555555555555555555555';
const W1 = '0x1111111111111111111111111111111111111111';
const W2 = '0x2222222222222222222222222222222222222222';
const LIMIT = 3_700_000_000_000_000n;
const LIMITS = { freeFeeAllowanceWei: 400_000_000_000_000n, paidFeeAllowanceWei: 370_000_000_000_000n, paidMaxPricePerNftWei: LIMIT, paidMaxWalletsPerMint: 2, freeMinWallets: 4 };

class FakePort implements IntelligenceChainPort {
  public readonly chainId = 1 as const;
  public head: bigint | null = 1_000n;
  public mints: ObservedMint[] = [];
  public dropUpdates: ObservedDropUpdate[] = [];
  public watchedMints: ObservedWatchedMint[] = [];
  public drops = new Map<string, DropSnapshot>();
  public balances = new Map<string, bigint>();
  public simulation: SimulationOutcome = { outcome: 'pass' };
  public failScan = false;
  public maxRange: bigint | null = null;
  public scans: Array<[bigint, bigint, readonly string[]]> = [];
  public async safeHead(): Promise<bigint | null> { return this.head; }
  public async scan(fromBlock: bigint, toBlock: bigint, watched: readonly string[]): Promise<ChainScanOutcome> {
    this.scans.push([fromBlock, toBlock, watched]);
    if (this.failScan) return { ok: false, reason: 'LOGS_UNAVAILABLE' };
    if (this.maxRange !== null && toBlock - fromBlock + 1n > this.maxRange) toBlock = fromBlock + this.maxRange - 1n;
    const inRange = <T extends { blockNumber: bigint }>(items: T[]) => items.filter((item) => item.blockNumber >= fromBlock && item.blockNumber <= toBlock);
    return { ok: true, scan: { fromBlock, toBlock, mints: inRange(this.mints), dropUpdates: inRange(this.dropUpdates), watchedMints: inRange(this.watchedMints) } };
  }
  public async readDrop(contract: string): Promise<DropSnapshot | null> { return this.drops.get(contract) ?? null; }
  public async hasCode(): Promise<boolean | null> { return true; }
  public async balance(address: string): Promise<bigint | null> { return this.balances.get(address) ?? null; }
  public async simulateMint(): Promise<SimulationOutcome> { return this.simulation; }
}

class MemoryRepo implements IntelligenceRepositoryPort {
  public watched: string[] = [];
  public cursors = new Map<string, bigint>();
  public observedAddresses(): ReadonlyArray<{ address: string }> { return this.watched.map((address) => ({ address })); }
  public cursor(chainId: number, source: string): bigint | undefined { return this.cursors.get(`${chainId}:${source}`); }
  public advanceCursor(chainId: number, source: string, lastBlock: bigint): void { this.cursors.set(`${chainId}:${source}`, lastBlock); }
}

class Clock { public constructor(public ms: number) {} public now = (): Date => new Date(this.ms); public advance(minutes: number): void { this.ms += minutes * 60_000; } }

const START = Date.parse('2026-09-29T12:00:00.000Z');
const seconds = (ms: number) => Math.floor(ms / 1000);
let logCounter = 0;
const mint = (block: bigint, minter: string, quantity = 1n, price = 0n, contract = NFT, payer = minter): ObservedMint => ({ nftContract: contract, minter, payer, quantity, unitPriceWei: price, blockNumber: block, txHash: `0x${(logCounter += 1).toString(16).padStart(64, '0')}`, logIndex: 0 });
const drop = (overrides: Partial<DropSnapshot> = {}): DropSnapshot => ({ nftContract: NFT, priceWei: 0n, startTime: seconds(START) - 60, endTime: seconds(START) + 86_400, maxPerWallet: 5, maxSupply: 1000n, totalMinted: 10n, ...overrides });
const events = (store: BackendStore, type: string) => store.snapshot().events.filter((event) => event.type === type);

function setup(store: BackendStore = new DurableStore()) {
  const clock = new Clock(START);
  const port = new FakePort();
  const repo = new MemoryRepo();
  const alerts = new AlertManager(store, undefined, undefined, { now: clock.now });
  const discovery = new DiscoveryService(store, repo, port, { now: clock.now, budgetPerNftWei: LIMIT, alerts });
  return { store, clock, port, repo, alerts, discovery };
}

describe('DiscoveryService', () => {
  it('turns watched-wallet convergence on a busy free SeaDrop mint into one scored, alerted opportunity', async () => {
    const t = setup();
    t.repo.watched = [WHALE];
    t.port.drops.set(NFT, drop());
    t.port.mints = [mint(900n, WHALE, 2n), ...Array.from({ length: 60 }, (_, index) => mint(950n, `0x${index.toString(16).padStart(40, '0')}`))];
    const result = await t.discovery.tick();
    expect(result).toMatchObject({ status: 'ok', fromBlock: '700', toBlock: '1000', mintsObserved: 62, opportunitiesWritten: 1, calendarWritten: 1 });
    const [opportunity] = [...events(t.store, 'opportunity_notified'), ...events(t.store, 'opportunity_scored')];
    expect(opportunity?.data).toMatchObject({ opportunityId: `seadrop:1:${NFT}`, contract: NFT, watchedMinters: [WHALE], mintsLastHour: 62, priceWei: '0', scoreVersion: 'v1-rules-p2' });
    expect((opportunity?.data.factors as Array<{ code: string; status: string }>).find((factor) => factor.code === 'track_record')?.status).toBe('unavailable');
    expect(events(t.store, 'calendar_entry')[0]?.data).toMatchObject({ id: `calendar:1:${NFT}`, priceWei: '0', maxPerWallet: 5, phase: 'active', sourceAuthority: 'on_chain' });
    expect(t.store.snapshot().events.filter((event) => event.type === 'alert_opportunity')).toHaveLength(1);
    expect(t.repo.cursor(1, 'seadrop-v1')).toBe(1_000n);
  });

  it('writes nothing new until something changes or the item is about to go stale', async () => {
    const t = setup();
    t.port.drops.set(NFT, drop());
    t.port.mints = [mint(900n, W1)];
    await t.discovery.tick();
    const count = () => t.store.snapshot().events.filter((event) => event.type.startsWith('opportunity_') || event.type === 'calendar_entry').length;
    const first = count();
    t.clock.advance(2);
    t.port.head = 1_010n;
    await t.discovery.tick();
    expect(count()).toBe(first);
    t.clock.advance(11);
    t.port.head = 1_020n;
    await t.discovery.tick();
    expect(count()).toBe(first + 2);
  });

  it('resumes from the persisted cursor and refuses to advance when the chain is unavailable', async () => {
    const t = setup();
    t.repo.cursors.set('1:seadrop-v1', 990n);
    await t.discovery.tick();
    expect(t.port.scans[0]?.[0]).toBe(991n);
    t.port.failScan = true;
    t.port.head = 1_100n;
    expect(await t.discovery.tick()).toMatchObject({ status: 'unavailable', reason: 'LOGS_UNAVAILABLE' });
    expect(t.repo.cursor(1, 'seadrop-v1')).toBe(1_000n);
    t.port.head = null;
    expect(await t.discovery.tick()).toMatchObject({ status: 'unavailable', reason: 'HEAD_UNAVAILABLE' });
  });

  it('puts upcoming drops on the calendar with opening-soon and over-limit price alerts', async () => {
    const t = setup();
    t.port.dropUpdates = [
      { nftContract: NFT, mintPriceWei: 0n, startTime: seconds(START) + 20 * 60, endTime: 0, maxPerWallet: 3, blockNumber: 950n },
      { nftContract: PAID_NFT, mintPriceWei: LIMIT + 1n, startTime: seconds(START) + 3 * 3600, endTime: 0, maxPerWallet: 2, blockNumber: 951n },
    ];
    const result = await t.discovery.tick();
    expect(result.calendarWritten).toBe(2);
    expect(events(t.store, 'alert_opening_soon')[0]?.data).toMatchObject({ priority: 'grouped' });
    expect(String(events(t.store, 'alert_opening_soon')[0]?.data.text)).toContain('opens in 20 minutes');
    expect(String(events(t.store, 'alert_price_above_limit')[0]?.data.text)).toContain('above your 0.0037 ETH limit');
    await t.discovery.tick();
    expect(events(t.store, 'alert_opening_soon')).toHaveLength(1);
  });

  it('blocks an over-limit paid opportunity from alerting as worth a look', async () => {
    const t = setup();
    t.repo.watched = [WHALE];
    t.port.drops.set(PAID_NFT, drop({ nftContract: PAID_NFT, priceWei: LIMIT * 2n }));
    t.port.mints = [mint(900n, WHALE, 1n, LIMIT * 2n, PAID_NFT), ...Array.from({ length: 60 }, (_, index) => mint(950n, `0x${index.toString(16).padStart(40, '0')}`, 1n, LIMIT * 2n, PAID_NFT))];
    await t.discovery.tick();
    expect(events(t.store, 'opportunity_scored')[0]?.data).toMatchObject({ blocked: true, band: 'log' });
    expect(events(t.store, 'alert_opportunity')).toHaveLength(0);
  });

  it('persists its events through the canonical SQLite store and restores convergence after a restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mint-intel-'));
    const db = openDatabase(join(directory, 'state.sqlite'));
    const store = new CanonicalStoreBridge(db);
    await store.open();
    try {
      const t = setup(store);
      t.repo.watched = [WHALE];
      t.port.drops.set(NFT, drop());
      t.port.mints = [mint(900n, WHALE)];
      await t.discovery.tick();
      expect(events(store, 'opportunity_scored').length + events(store, 'opportunity_notified').length).toBe(1);
      const restarted = new DiscoveryService(store, t.repo, t.port, { now: () => new Date(START + 14 * 60_000), budgetPerNftWei: LIMIT });
      t.port.head = 1_010n;
      await restarted.tick();
      const all = [...events(store, 'opportunity_scored'), ...events(store, 'opportunity_notified')].sort((a, b) => a.at.localeCompare(b.at));
      expect(all.at(-1)?.data.watchedMinters).toEqual([WHALE]);
      expect(new IntelligenceRepository(db).observedAddresses(1)).toEqual([]);
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('ReadinessSweep', () => {
  async function withCalendar(t: ReturnType<typeof setup>, snapshot: DropSnapshot, score?: number) {
    t.port.drops.set(snapshot.nftContract, snapshot);
    t.port.mints = [mint(900n, W1, 1n, snapshot.priceWei, snapshot.nftContract)];
    await t.discovery.tick();
    if (score !== undefined) await t.store.transaction((state) => { state.events.push({ id: `score-${snapshot.nftContract}`, type: 'opportunity_notified', at: new Date(t.clock.ms + 1).toISOString(), data: { contract: snapshot.nftContract, score, blocked: false } }); });
  }

  it('marks funded wallets ready after a passing simulation and tells the owner exactly how much ETH an underfunded wallet needs', async () => {
    const t = setup();
    await withCalendar(t, drop());
    t.port.balances.set(W1, 500_000_000_000_000n);
    t.port.balances.set(W2, 100_000_000_000_000n);
    const sweep = new ReadinessSweep(t.store, t.port, async () => [W1, W2], { now: t.clock.now, limits: LIMITS, alerts: t.alerts });
    const result = await sweep.tick();
    expect(result).toMatchObject({ drops: 1, written: 1 });
    const rows = events(t.store, 'readiness_sweep')[0]?.data.rows as Array<Record<string, unknown>>;
    expect(rows).toEqual([
      expect.objectContaining({ wallet: W1, state: 'ready', requiredWei: '400000000000000' }),
      expect.objectContaining({ wallet: W2, state: 'unfunded', topUpWei: '300000000000000' }),
    ]);
    const underfunded = String(events(t.store, 'alert_underfunded')[0]?.data.text);
    expect(underfunded).toContain(`send 0.0003 ETH to ${W2}`);
    expect(String(events(t.store, 'alert_eligible_ready')[0]?.data.text)).toContain('You asked for at least 4 wallets');
  });

  it('never simulates before the mint opens, and reports an unknown balance as unknown', async () => {
    const t = setup();
    await withCalendar(t, drop({ startTime: seconds(START) + 3600 }));
    t.port.balances.set(W1, 10n ** 18n);
    t.port.simulation = { outcome: 'fail', reason: 'should not run' };
    await new ReadinessSweep(t.store, t.port, async () => [W1, W2], { now: t.clock.now, limits: LIMITS }).tick();
    const rows = events(t.store, 'readiness_sweep')[0]?.data.rows as Array<Record<string, unknown>>;
    expect(rows.map((row) => [row.state, row.reason])).toEqual([['funded', 'CHECK_RUNS_WHEN_OPEN'], ['unknown', 'BALANCE_UNAVAILABLE']]);
  });

  it('plans paid mints by score, caps them at two wallets, and blocks prices above the limit', async () => {
    const t = setup();
    await withCalendar(t, drop({ nftContract: PAID_NFT, priceWei: 1_000_000_000_000_000n }), 75);
    for (const [index, wallet] of [W1, W2, WHALE].entries()) t.port.balances.set(wallet, 10n ** 18n - BigInt(index));
    await new ReadinessSweep(t.store, t.port, async () => [W1, W2, WHALE], { now: t.clock.now, limits: LIMITS }).tick();
    const sweep = events(t.store, 'readiness_sweep')[0]?.data;
    expect(sweep).toMatchObject({ mintClass: 'paid', quantity: 2, requiredWei: (2_000_000_000_000_000n + 370_000_000_000_000n).toString() });
    expect((sweep?.rows as Array<Record<string, unknown>>).map((row) => row.state)).toEqual(['ready', 'ready', 'skipped']);

    const expensive = setup();
    await withCalendar(expensive, drop({ nftContract: PAID_NFT, priceWei: LIMIT + 1n }), 90);
    expensive.port.balances.set(W1, 10n ** 18n);
    await new ReadinessSweep(expensive.store, expensive.port, async () => [W1], { now: expensive.clock.now, limits: LIMITS }).tick();
    expect((events(expensive.store, 'readiness_sweep')[0]?.data.rows as Array<Record<string, unknown>>)[0]).toMatchObject({ state: 'blocked', reason: 'PRICE_ABOVE_LIMIT' });

    const lowScore = setup();
    await withCalendar(lowScore, drop({ nftContract: PAID_NFT, priceWei: 1_000_000_000_000_000n }), 30);
    lowScore.port.balances.set(W1, 10n ** 18n);
    await new ReadinessSweep(lowScore.store, lowScore.port, async () => [W1], { now: lowScore.clock.now, limits: LIMITS }).tick();
    expect((events(lowScore.store, 'readiness_sweep')[0]?.data.rows as Array<Record<string, unknown>>)[0]).toMatchObject({ state: 'skipped', reason: 'SCORE_TOO_LOW' });
  });

  it('does not rewrite an unchanged sweep until it nears the five-minute freshness limit', async () => {
    const t = setup();
    await withCalendar(t, drop());
    t.port.balances.set(W1, 10n ** 18n);
    const sweep = new ReadinessSweep(t.store, t.port, async () => [W1], { now: t.clock.now, limits: LIMITS });
    await sweep.tick();
    t.clock.advance(2);
    await sweep.tick();
    expect(events(t.store, 'readiness_sweep')).toHaveLength(1);
    t.clock.advance(3);
    await sweep.tick();
    expect(events(t.store, 'readiness_sweep')).toHaveLength(2);
  });
});

describe('AlertManager digests', () => {
  it('sends each intelligence alert once, dispatches immediate ones now and bundles grouped ones into a restart-safe digest', async () => {
    const store = new DurableStore();
    const sent: Array<[string, string]> = [];
    const dispatcher = { dispatch: async (id: string, text?: string) => { sent.push([id, text ?? '']); await store.transaction((state) => { state.notificationOutbox.push({ id: `n-${id}`, sourceEventId: id, type: 'x', text: text ?? '', state: 'delivered', attempts: 1, createdAt: new Date().toISOString() }); }); } };
    const alerts = new AlertManager(store, dispatcher as never);
    expect(await alerts.intelligence({ kind: 'opening_soon', dedupe: 'a', text: 'soon', priority: 'immediate' })).toBe(true);
    expect(await alerts.intelligence({ kind: 'opening_soon', dedupe: 'a', text: 'soon', priority: 'immediate' })).toBe(false);
    await alerts.intelligence({ kind: 'underfunded', dedupe: 'b', text: 'top up W1', priority: 'grouped' });
    await alerts.intelligence({ kind: 'opportunity', dedupe: 'c', text: 'worth a look', priority: 'grouped' });
    expect(sent.map(([, text]) => text)).toEqual(['soon']);
    expect(await new AlertManager(store, dispatcher as never).flushDigest()).toBe(2);
    expect(sent.at(-1)?.[1].split('\n').sort()).toEqual(['MintBot reminders (2):', '• top up W1', '• worth a look']);
    expect(await alerts.flushDigest()).toBe(0);
  });
});

describe('read model v1 projection of Phase 2 intelligence', () => {
  it('shows score factors, calendar limits and per-wallet readiness with plain top-up guidance', async () => {
    const t = setup();
    t.repo.watched = [WHALE];
    t.port.drops.set(NFT, drop());
    t.port.mints = [mint(900n, WHALE)];
    await t.discovery.tick();
    t.port.balances.set(W1, 100_000_000_000_000n);
    await new ReadinessSweep(t.store, t.port, async () => [W1], { now: t.clock.now, limits: LIMITS }).tick();
    const models = new Phase2ReadModelService(t.clock.now);
    const state = t.store.snapshot();
    const opportunity = models.opportunities(state).data?.[0];
    expect(opportunity?.score.factors.find((factor) => factor.code === 'track_record')?.explanation).toMatch(/^Unavailable \(worth up to 25\)/);
    expect(opportunity?.score.factors.find((factor) => factor.code === 'convergence')).toMatchObject({ contribution: 8 });
    expect(opportunity?.readiness).toMatchObject({ total: '1', blocked: '1' });
    const entry = models.calendar(state).data?.find((item) => item.id === `calendar:1:${NFT}`);
    expect(entry).toMatchObject({ perWalletLimit: { value: '5' }, supply: { value: '1000' }, eligibility: { total: '1', blocked: '1' } });
    const readiness = models.readiness(state, `calendar:1:${NFT}`);
    expect(readiness.data?.[0]).toMatchObject({ state: 'Unfunded', decision: 'blocked', nextAction: 'Fund wallet' });
    expect(readiness.data?.[0]?.blockers[0]?.message).toBe('This wallet needs 0.0003 ETH more before the mint.');
    expect(models.readiness(state, 'missing').issues[0]?.code).toBe('CAMPAIGN_NOT_FOUND');
  });
});

describe('discovery hardening against hostile chain data (security review T-004)', () => {
  it('survives uint48 max timestamps: bad start times are ignored, huge end times mean open-ended, and the cursor advances', async () => {
    const t = setup();
    const max = 2 ** 48 - 1;
    t.port.dropUpdates = [
      { nftContract: NFT, mintPriceWei: 0n, startTime: seconds(START) + 600, endTime: max, maxPerWallet: 2, blockNumber: 950n },
      { nftContract: PAID_NFT, mintPriceWei: 0n, startTime: max, endTime: max, maxPerWallet: 2, blockNumber: 951n },
    ];
    t.port.drops.set(PAID_NFT, drop({ nftContract: PAID_NFT, startTime: max, endTime: max }));
    t.port.mints = [mint(952n, W1, 1n, 0n, PAID_NFT)];
    const result = await t.discovery.tick();
    expect(result.status).toBe('ok');
    expect(t.repo.cursor(1, 'seadrop-v1')).toBe(1_000n);
    const calendar = events(t.store, 'calendar_entry');
    expect(calendar.map((event) => event.data.contract)).toEqual([NFT]);
    expect(calendar[0]?.data.closingAt).toBeNull();
  });

  it('never counts the same mint log twice when a range is rescanned', async () => {
    const t = setup();
    t.port.drops.set(NFT, drop());
    t.port.mints = [mint(900n, W1, 3n)];
    expect((await t.discovery.tick()).mintsObserved).toBe(3);
    t.repo.cursors.set('1:seadrop-v1', 800n);
    expect((await t.discovery.tick()).mintsObserved).toBe(0);
  });

  it('does not treat a mint paid by someone else, or an NFT sent to a watched wallet, as convergence', async () => {
    const t = setup();
    t.repo.watched = [WHALE];
    t.port.drops.set(NFT, drop());
    t.port.mints = [mint(900n, WHALE, 1n, 0n, NFT, W1)];
    t.port.watchedMints = [{ nftContract: NFT, recipient: WHALE, blockNumber: 901n, txHash: `0x${'e'.repeat(64)}`, logIndex: 3 }];
    await t.discovery.tick();
    const opportunity = [...events(t.store, 'opportunity_scored'), ...events(t.store, 'opportunity_notified')][0];
    expect(opportunity?.data.watchedMinters).toEqual([]);
    expect(opportunity?.data.watchedReceivers).toEqual([WHALE]);
    expect((opportunity?.data.factors as Array<{ code: string; points: number }>).find((factor) => factor.code === 'convergence')?.points).toBe(0);
  });

  it('does not re-stamp freshness while the scan is behind the chain head', async () => {
    const t = setup();
    t.port.drops.set(NFT, drop());
    t.port.mints = [mint(900n, W1)];
    await t.discovery.tick();
    const count = () => t.store.snapshot().events.filter((event) => event.type.startsWith('opportunity_') || event.type === 'calendar_entry').length;
    const before = count();
    t.clock.advance(13);
    t.port.head = 100_000n;
    t.port.maxRange = 10n;
    await t.discovery.tick();
    expect(count()).toBe(before);
    expect(events(t.store, 'calendar_entry')[0]?.data.sourceBlock).toBe('1000');
  });

  it('keeps opening reminders grouped and capped at 20 per day', async () => {
    const t = setup();
    t.port.dropUpdates = Array.from({ length: 30 }, (_, index) => ({ nftContract: `0x${(index + 1).toString(16).padStart(40, '0')}`, mintPriceWei: 0n, startTime: seconds(START) + 600, endTime: 0, maxPerWallet: 1, blockNumber: 950n }));
    await t.discovery.tick();
    const opening = events(t.store, 'alert_opening_soon');
    expect(opening).toHaveLength(20);
    expect(opening.every((event) => event.data.priority === 'grouped')).toBe(true);
  });
});

describe('readiness alert bounds (security review T-004)', () => {
  it('only lets scored drops interrupt immediately, and caps sweeps and readiness alerts', async () => {
    const t = setup();
    const soon = seconds(START) + 20 * 60;
    t.port.dropUpdates = Array.from({ length: 30 }, (_, index) => ({ nftContract: `0x${(index + 1).toString(16).padStart(40, '0')}`, mintPriceWei: 0n, startTime: soon, endTime: 0, maxPerWallet: 1, blockNumber: 950n }));
    await t.discovery.tick();
    t.port.balances.set(W1, 1n);
    const result = await new ReadinessSweep(t.store, t.port, async () => [W1], { now: t.clock.now, limits: LIMITS, alerts: t.alerts }).tick();
    expect(result.drops).toBe(20);
    const underfunded = events(t.store, 'alert_underfunded');
    expect(underfunded.length).toBeLessThanOrEqual(20);
    expect(underfunded.every((event) => event.data.priority === 'grouped')).toBe(true);
  });
});
