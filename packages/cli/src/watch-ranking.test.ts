import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase, openDatabaseReadOnly } from '@mint-bot/database';
import { rankWatchedWallets, readRankingInputs, renderWatchRanking, type RankingEvent, type WatchedWallet } from './watch-ranking.js';

const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const C = '0x3333333333333333333333333333333333333333';
const D = '0x4444444444444444444444444444444444444444';
const NFT1 = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const NFT2 = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const NFT3 = '0xcccccccccccccccccccccccccccccccccccccccc';
const WATCHED: WatchedWallet[] = [{ address: A, label: 'alpha.eth' }, { address: B, label: null }, { address: C, label: null }, { address: D, label: null }];

const event = (type: string, at: string, contract: string, extra: Record<string, unknown> = {}): RankingEvent => ({ type, at, data: { contract, score: 50, priceWei: '0', watchedMinters: [], watchedReceivers: [], ...extra } });

describe('rankWatchedWallets', () => {
  it('ranks by alert collections, then minted, then average best score, then recency, and lists inactive wallets separately', () => {
    const events = [
      event('opportunity_scored', '2026-10-10T10:00:00Z', NFT1, { watchedMinters: [A, B] }),
      event('opportunity_notified', '2026-10-10T11:00:00Z', NFT1, { score: 80, watchedMinters: [A, B] }),
      event('opportunity_scored', '2026-10-11T10:00:00Z', NFT2, { score: 40, watchedMinters: [A], priceWei: '1000000000000000' }),
      event('opportunity_scored', '2026-10-12T10:00:00Z', NFT3, { score: 70, watchedMinters: [B], watchedReceivers: [C] }),
    ];
    const result = rankWatchedWallets({ events, watched: WATCHED });
    // A and B tie on alerts (1) and minted collections (2); B's average best score (75) beats A's (60).
    expect(result.ranked.map((row) => row.address)).toEqual([B, A, C]);
    expect(result.ranked[0]).toMatchObject({ rank: 1, collectionsMinted: 2, alertCollections: 1, averageBestScore: 75 });
    expect(result.ranked[1]).toMatchObject({ rank: 2, label: 'alpha.eth', collectionsMinted: 2, collectionsReceived: 0, alertCollections: 1, averageBestScore: 60, freeShare: 0.5, lastActiveAt: '2026-10-11T10:00:00Z' });
    expect(result.ranked[2]).toMatchObject({ rank: 3, collectionsMinted: 0, collectionsReceived: 1, alertCollections: 0 });
    expect(result.silent.map((wallet) => wallet.address)).toEqual([D]);
    expect(result.meta).toMatchObject({ watchedWallets: 4, opportunitiesSeen: 3, eventsRead: 4, dataFrom: '2026-10-10T10:00:00Z', dataTo: '2026-10-12T10:00:00Z', days: 2 });
  });

  it('counts a collection once however many events it produced, and unites the wallets seen across them', () => {
    const events = [
      event('opportunity_scored', '2026-10-10T10:00:00Z', NFT1, { watchedMinters: [A], score: 30 }),
      event('opportunity_scored', '2026-10-10T10:05:00Z', NFT1, { watchedMinters: [A, B], score: 55 }),
      event('opportunity_scored', '2026-10-10T10:10:00Z', NFT1, { watchedMinters: [A, B], score: 45 }),
    ];
    const result = rankWatchedWallets({ events, watched: WATCHED });
    expect(result.ranked).toHaveLength(2);
    expect(result.ranked[0]).toMatchObject({ address: A, collectionsMinted: 1, averageBestScore: 55 });
    expect(result.ranked[1]).toMatchObject({ address: B, collectionsMinted: 1, averageBestScore: 55 });
  });

  it('matches wallets regardless of letter case, ignores wallets that are not watched, and lists a duplicate watched wallet once', () => {
    const upper = `0x${'ABCDEF'.repeat(6)}0123`.slice(0, 42);
    const events = [event('opportunity_scored', '2026-10-10T10:00:00Z', NFT1, { watchedMinters: [A.toUpperCase().replace('0X', '0x'), D.toUpperCase().replace('0X', '0x'), upper] })];
    const result = rankWatchedWallets({ events, watched: [WATCHED[0]!, WATCHED[0]!, { address: D, label: null }] });
    expect(result.ranked.map((row) => row.address)).toEqual([A, D]);
    expect(result.meta.watchedWallets).toBe(2);
  });

  it('ignores damaged events and other event types, and handles no data at all', () => {
    const events: RankingEvent[] = [
      { type: 'calendar_entry', at: '2026-10-10T10:00:00Z', data: { contract: NFT1, watchedMinters: [A] } },
      { type: 'opportunity_scored', at: 'not a time', data: { contract: NFT1, watchedMinters: [A] } },
      { type: 'opportunity_scored', at: '2026-10-10T10:00:00Z', data: { contract: 'nope', watchedMinters: [A] } },
      { type: 'opportunity_scored', at: '2026-10-10T10:00:00Z', data: { contract: NFT1, watchedMinters: 'oops', watchedReceivers: [5, null, 'x'], score: Number.NaN } },
    ];
    const result = rankWatchedWallets({ events, watched: WATCHED });
    expect(result.ranked).toEqual([]);
    expect(result.silent).toHaveLength(4);
    expect(rankWatchedWallets({ events: [], watched: [] })).toMatchObject({ ranked: [], silent: [], meta: { eventsRead: 0, days: 0, dataFrom: null } });
  });

  it('is deterministic when everything ties', () => {
    const events = [event('opportunity_scored', '2026-10-10T10:00:00Z', NFT1, { watchedMinters: [C, B, A] })];
    const first = rankWatchedWallets({ events, watched: [WATCHED[2]!, WATCHED[1]!, WATCHED[0]!] });
    const second = rankWatchedWallets({ events, watched: WATCHED });
    expect(first.ranked.map((row) => row.address)).toEqual([A, B, C]);
    expect(second.ranked.map((row) => row.address)).toEqual([A, B, C]);
  });

  it('does not let received-only NFTs lift a wallet: only minted collections count toward alerts, score and free share', () => {
    const events = [
      event('opportunity_notified', '2026-10-10T10:00:00Z', NFT1, { score: 90, watchedMinters: [A], watchedReceivers: [B] }),
      event('opportunity_notified', '2026-10-10T10:00:00Z', NFT2, { score: 95, watchedReceivers: [B] }),
      event('opportunity_scored', '2026-10-11T10:00:00Z', NFT3, { score: 10, watchedMinters: [B] }),
    ];
    const result = rankWatchedWallets({ events, watched: WATCHED });
    // B received two high-scoring alert collections and minted one weak one; A minted one alert collection. A ranks first.
    expect(result.ranked.map((row) => row.address)).toEqual([A, B]);
    expect(result.ranked[1]).toMatchObject({ collectionsMinted: 1, collectionsReceived: 2, alertCollections: 0, averageBestScore: 10 });
  });

  it('does not count a blocked collection as having triggered an alert', () => {
    const events = [
      event('opportunity_notified', '2026-10-10T10:00:00Z', NFT1, { watchedMinters: [A], blocked: true }),
      event('opportunity_notified', '2026-10-10T10:00:00Z', NFT2, { watchedMinters: [A], blocked: false }),
    ];
    expect(rankWatchedWallets({ events, watched: WATCHED }).ranked[0]).toMatchObject({ collectionsMinted: 2, alertCollections: 1 });
  });

  it('keeps events from other chains out of the ranking', () => {
    const events = [
      event('opportunity_scored', '2026-10-10T10:00:00Z', NFT1, { watchedMinters: [A], chainId: 4663 }),
      event('opportunity_scored', '2026-10-10T10:00:00Z', NFT2, { watchedMinters: [A], chainId: 1 }),
      event('opportunity_scored', '2026-10-10T10:00:00Z', NFT3, { watchedMinters: [A] }),
    ];
    const result = rankWatchedWallets({ events, watched: WATCHED });
    expect(result.ranked[0]).toMatchObject({ collectionsMinted: 2 });
    expect(result.meta.eventsRead).toBe(2);
  });

  it('reads prices written as plain digits, with an n suffix, or as numbers', () => {
    const events = [
      event('opportunity_scored', '2026-10-10T10:00:00Z', NFT1, { watchedMinters: [A], priceWei: '0n' }),
      event('opportunity_scored', '2026-10-10T10:00:00Z', NFT2, { watchedMinters: [A], priceWei: 0 }),
      event('opportunity_scored', '2026-10-10T10:00:00Z', NFT3, { watchedMinters: [A], priceWei: 'free' }),
    ];
    expect(rankWatchedWallets({ events, watched: WATCHED }).ranked[0]?.freeShare).toBe(1);
  });
});

describe('renderWatchRanking', () => {
  it('says what it is based on, what it does not measure, and shows short addresses and labels', () => {
    const events = [event('opportunity_notified', '2026-10-10T10:00:00Z', NFT1, { watchedMinters: [A, B] }), event('opportunity_scored', '2026-10-12T10:00:00Z', NFT2, { watchedMinters: [B], score: 20 })];
    const text = renderWatchRanking(rankWatchedWallets({ events, watched: WATCHED }), 1);
    expect(text).toContain('WATCHED-WALLET RANKING');
    expect(text).toContain('Not measured yet: profit, win rate and floor performance');
    expect(text).toContain('2 of your 4 watched wallets were active; 2 were not seen');
    // B minted two collections against A's one (both triggered one alert), so B is first.
    expect(text).toContain('1. 0x2222…2222');
    expect(text).toContain('... and 1 more active wallet(s)');
    expect(text).not.toContain(A);
    expect(renderWatchRanking(rankWatchedWallets({ events, watched: WATCHED }), 2)).toContain('2. alpha.eth (0x1111…1111)');
    expect(renderWatchRanking(rankWatchedWallets({ events: [], watched: WATCHED }))).toContain('No watched wallet has been seen minting or receiving anything yet.');
  });
});

describe('reading the trial database (read-only)', () => {
  it('reads the events and watched wallets, skips damaged rows, and cannot write', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mint-ranking-'));
    try {
      const file = join(directory, 'state.sqlite');
      const writable = openDatabase(file);
      const add = (id: string, state: string, at: string, snapshot: string | null) => writable.prepare("INSERT INTO audit_event (id, entity_type, entity_id, new_state, actor, reason, policy_snapshot_json, occurred_at) VALUES (?, 'state_transition', 'global', ?, 'test', 'backend event', ?, ?)").run(id, state, snapshot, at);
      add('e1', 'opportunity_scored', '2026-10-10T10:00:00.000Z', JSON.stringify({ kind: 'event', eventType: 'opportunity_scored', eventData: { contract: NFT1, score: 61, priceWei: '0', watchedMinters: [A], watchedReceivers: [] } }));
      add('e2', 'opportunity_scored', '2026-10-10T10:01:00.000Z', 'not json');
      add('e3', 'opportunity_scored', '2026-10-10T10:02:00.000Z', null);
      add('e4', 'calendar_entry', '2026-10-10T10:03:00.000Z', JSON.stringify({ kind: 'event', eventType: 'calendar_entry', eventData: { contract: NFT2 } }));
      writable.prepare("INSERT INTO observed_address (id, chain_id, address, label, enabled, created_at, updated_at) VALUES ('o1', 1, ?, 'alpha.eth', 1, '2026-10-10T00:00:00.000Z', '2026-10-10T00:00:00.000Z')").run(A);
      writable.prepare("INSERT INTO observed_address (id, chain_id, address, label, enabled, created_at, updated_at) VALUES ('o2', 1, ?, NULL, 0, '2026-10-10T00:00:00.000Z', '2026-10-10T00:00:00.000Z')").run(B);
      writable.close();

      const readOnly = openDatabaseReadOnly(file);
      try {
        const inputs = readRankingInputs(readOnly);
        expect(inputs.events).toHaveLength(1);
        expect(inputs.watched).toEqual([{ address: A, label: 'alpha.eth' }]);
        expect(rankWatchedWallets(inputs).ranked[0]).toMatchObject({ address: A, collectionsMinted: 1, averageBestScore: 61 });
        expect(() => readOnly.prepare("DELETE FROM audit_event WHERE id = 'e1'").run()).toThrow();
        expect(() => readOnly.prepare("INSERT INTO observed_address (id, chain_id, address, created_at, updated_at) VALUES ('o3', 1, ?, 'x', 'x')").run(C)).toThrow();
      } finally { readOnly.close(); }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('reads beside a live writer on a WAL database, sees new rows, and leaves no extra files behind', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mint-ranking-'));
    const { readdir } = await import('node:fs/promises');
    try {
      const file = join(directory, 'state.sqlite');
      const writer = openDatabase(file); // stays open, like the running service
      const add = (id: string, at: string, contract: string) => writer.prepare("INSERT INTO audit_event (id, entity_type, entity_id, new_state, actor, reason, policy_snapshot_json, occurred_at) VALUES (?, 'state_transition', 'global', 'opportunity_scored', 'test', 'backend event', ?, ?)").run(id, JSON.stringify({ kind: 'event', eventType: 'opportunity_scored', eventData: { contract, score: 50, priceWei: '0', watchedMinters: [A], watchedReceivers: [] } }), at);
      writer.prepare("INSERT INTO observed_address (id, chain_id, address, label, enabled, created_at, updated_at) VALUES ('o1', 1, ?, NULL, 1, '2026-10-10T00:00:00.000Z', '2026-10-10T00:00:00.000Z')").run(A);
      add('w1', '2026-10-10T10:00:00.000Z', NFT1);
      const before = new Set(await readdir(directory));
      const first = openDatabaseReadOnly(file);
      expect(rankWatchedWallets(readRankingInputs(first)).ranked[0]).toMatchObject({ collectionsMinted: 1 });
      add('w2', '2026-10-10T11:00:00.000Z', NFT2); // the writer keeps writing while the report is open
      first.close();
      const second = openDatabaseReadOnly(file);
      expect(rankWatchedWallets(readRankingInputs(second)).ranked[0]).toMatchObject({ collectionsMinted: 2 });
      second.close();
      expect(new Set(await readdir(directory))).toEqual(before);
      writer.close();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('refuses a database file that does not exist and creates nothing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mint-ranking-'));
    try {
      expect(() => openDatabaseReadOnly(join(directory, 'missing.sqlite'))).toThrow();
      const { readdir } = await import('node:fs/promises');
      expect(await readdir(directory)).toEqual([]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

describe('watch-ranking command wiring', () => {
  it('opens the database read-only, never builds a runtime, validates --top, and closes the file', async () => {
    const source = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
    const start = source.indexOf(".command('watch-ranking'");
    const text = source.slice(start, source.indexOf(".command('robinhood-enable <action>'", start));
    expect(start).toBeGreaterThan(0);
    expect(text).toContain('openDatabaseReadOnly(');
    expect(text).not.toContain('createCliRuntime(');
    expect(text).not.toContain('openDatabase(');
    expect(text).toContain('TOP_INVALID');
    expect(text).toContain('database.close()');
  });
});

