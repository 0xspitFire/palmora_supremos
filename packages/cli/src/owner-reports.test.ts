import { describe, expect, it } from 'vitest';
import type { BackendState } from '@mint-bot/backend';
import { dailyCaps, describeActivity, describeHistory, describeLimits } from './owner-reports.js';

/** T-066: /limits, /history and /activity describe what the database holds; they never write. */
const NOW = new Date('2026-10-24T12:00:00.000Z');
const ALLOWANCE = 200_000_000_000_000n;
const campaign = (id: string, chainId: 1 | 8453 | 4663, mintPriceWei = 0n, quantity = 1) => ({ id, chainId, contract: '0xa686fde3299d5451af22382240e0dff62f7b94db', quantity, mintPriceWei, dryRun: false }) as never;
const reservation = (overrides: Record<string, unknown>) => ({ id: 'r', runId: 'run1', campaignId: 'c1', chainId: 4663, wallet: '0x1', amountWei: ALLOWANCE, status: 'reserved', createdAt: '2026-10-24T11:00:00.000Z', updatedAt: '2026-10-24T11:00:00.000Z', accountingDate: '2026-10-24', ...overrides }) as never;

describe('limits', () => {
  it('shows each chain\'s rolling-day use against its cap, counting pending and settled of the last 24 hours only', () => {
    const state = { killed: false, campaigns: [campaign('c1', 4663), campaign('c2', 1, 100n)], reservations: [
      reservation({}), reservation({ id: 'r2', status: 'settled', updatedAt: '2026-10-24T10:00:00.000Z' }), reservation({ id: 'r3', status: 'settled', updatedAt: '2026-10-22T10:00:00.000Z' }), reservation({ id: 'r4', status: 'released' }),
      reservation({ id: 'r5', campaignId: 'c2', chainId: 1, amountWei: 370_000_000_000_000n }),
    ] } as Pick<BackendState, 'reservations' | 'campaigns' | 'killed'>;
    const text = describeLimits(state, NOW, false);
    expect(text).toContain('Robinhood: free 0.0004 of 0.002 ETH (0.0016 left)');
    expect(text).toContain('Ethereum: free 0 of 0.0024 ETH (0.0024 left), paid 0.00037 of 0.0082 ETH (0.00783 left)');
    expect(text).toContain('Kill switch: off');
    expect(text).toContain('Reservations still open: 2.');
  });

  it('says the kill switch is on when the file or the stored flag says so, and uses the Robinhood and Base caps', () => {
    expect(describeLimits({ killed: false, campaigns: [], reservations: [] }, NOW, true)).toContain('Kill switch: ON');
    expect(describeLimits({ killed: true, campaigns: [], reservations: [] }, NOW, false)).toContain('Kill switch: ON');
    expect(dailyCaps(4663).free).toBe(2_000_000_000_000_000n);
    expect(dailyCaps(8453).free).toBe(1_200_000_000_000_000n);
    expect(dailyCaps(1).free).toBe(2_400_000_000_000_000n);
  });
});

describe('history', () => {
  it('says so when nothing was minted live', () => {
    expect(describeHistory({ runs: [], campaigns: [], receipts: [], reservations: [] })).toBe('No live mints yet.');
    expect(describeHistory({ runs: [{ id: 'r', campaignId: 'c1', mode: 'dry-run', state: 'Completed', createdAt: '2026-10-24T10:00:00.000Z' } as never], campaigns: [campaign('c1', 1)], receipts: [], reservations: [] })).toBe('No live mints yet.');
  });

  it('totals live runs per chain and lists the newest first', () => {
    const state = {
      campaigns: [campaign('c1', 4663, 0n, 2), campaign('c2', 1)],
      runs: [{ id: 'run_old', campaignId: 'c2', mode: 'live', state: 'Completed', createdAt: '2026-10-19T10:00:00.000Z' }, { id: 'run_new', campaignId: 'c1', mode: 'live', state: 'Completed', createdAt: '2026-10-24T10:00:00.000Z' }, { id: 'dry', campaignId: 'c1', mode: 'dry-run', state: 'Completed', createdAt: '2026-10-24T11:00:00.000Z' }] as never,
      receipts: [{ id: 'x1', runId: 'run_new', state: 'Confirmed', actualSpendWei: 2_000_000_000_000n }, { id: 'x2', runId: 'run_new', state: 'Failed' }, { id: 'x3', runId: 'run_old', state: 'Confirmed', actualSpendWei: 1_000_000_000_000n }] as never,
      reservations: [{ runId: 'run_new' }, { runId: 'run_new' }, { runId: 'run_old' }] as never,
    };
    const text = describeHistory(state);
    expect(text).toContain('Robinhood: 1 run(s), 1 wallet mint(s), 2 NFT(s)');
    expect(text).toContain('Ethereum: 1 run(s), 1 wallet mint(s), 1 NFT(s)');
    expect(text.indexOf('run_new')).toBeLessThan(text.indexOf('run_old'));
    expect(text).toContain('1 of 2 wallet(s) minted');
    expect(text).not.toContain('dry');
  });
});

describe('activity', () => {
  const event = (id: string, at: string, data: Record<string, unknown>, type = 'opportunity_notified') => ({ id, type, at, data }) as never;
  it('lists the newest mint per contract with the labels of the tracked wallets, and skips events with no tracked minter', () => {
    const events = [
      event('1', '2026-10-24T09:00:00.000Z', { contract: '0xaaaa00000000000000000000000000000000aaaa', collectionName: 'Old', watchedMinters: ['0x1111111111111111111111111111111111111111'] }),
      event('2', '2026-10-24T11:00:00.000Z', { contract: '0xaaaa00000000000000000000000000000000aaaa', collectionName: 'Old', watchedMinters: ['0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222'], score: 71 }),
      event('3', '2026-10-24T10:00:00.000Z', { contract: '0xbbbb00000000000000000000000000000000bbbb', watchedMinters: [] }),
      event('4', '2026-10-24T08:00:00.000Z', { contract: '0xcccc00000000000000000000000000000000cccc', watchedMinters: ['0x1111111111111111111111111111111111111111'] }, 'calendar_entry'),
    ];
    const text = describeActivity(events, new Map([['0x1111111111111111111111111111111111111111', 'whale one']]));
    expect(text).toContain('whale one, 0x2222…2222');
    expect(text).toContain('score 71');
    expect(text.match(/0xaaaa0000/g)?.length).toBeGreaterThan(0);
    expect(text).not.toContain('0xbbbb');
    expect(text).not.toContain('0xcccc');
    expect(text.indexOf('11:00')).toBeGreaterThan(-1);
    expect(text).not.toContain('09:00');
  });

  it('says so when nothing was recorded', () => {
    expect(describeActivity([], new Map())).toContain('No mints by tracked wallets');
  });
});
