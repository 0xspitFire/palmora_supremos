import { describe, expect, it } from 'vitest';
import { DurableStore, Phase2ReadModelService, ingestCanonicalAnalytics, type Campaign } from '@mint-bot/backend';
import { ReadModelClient } from '@mint-bot/web';
import { createDashboard } from './dashboard.js';

const AT = '2026-11-07T00:00:00.000Z';
const NFT = '0x3333333333333333333333333333333333333333';

describe('backend read-model → client → dashboard contract', () => {
  it('retains Base identity and mixed known/unknown calendar records through the real consumer', async () => {
    const store = new DurableStore();
    await store.transaction(state => {
      state.events.push(
        { id: 'known-calendar', type: 'calendar_entry', at: AT, data: { id: 'known-calendar', projectName: 'Known time Base mint', chainId: 8453, contract: NFT, openingAt: AT, expiresAt: '2026-11-08T00:00:00.000Z' } },
        { id: 'unknown-calendar', type: 'calendar_entry', at: AT, data: { id: 'unknown-calendar', projectName: 'Unknown time Base mint', chainId: 8453, contract: NFT, openingAt: null, expiresAt: '2026-11-08T00:00:00.000Z' } },
        { id: 'base-opportunity', type: 'opportunity_scored', at: AT, data: { id: 'base-opportunity', projectName: 'Base opportunity', chainId: 8453, contract: NFT, score: 75, expiresAt: '2026-11-08T00:00:00.000Z' } },
      );
    });
    const service = new Phase2ReadModelService(() => new Date(AT));
    const projected = service.calendar(store.snapshot());
    const client = new ReadModelClient({ get: async () => projected });
    const calendar = await client.getCalendar();
    expect(calendar.data).toHaveLength(2);
    expect(calendar.data?.every(entry => entry.chain.id === '8453' && entry.chain.name === 'Base')).toBe(true);
    expect(calendar.data?.find(entry => entry.id === 'unknown-calendar')?.openingAt).toBeNull();
    expect(calendar.issues.some(issue => issue.code === 'CALENDAR_TIME_UNKNOWN')).toBe(true);
    expect(calendar.issues.some(issue => issue.code === 'READ_MODEL_SCHEMA_MISMATCH')).toBe(false);

    const html = await createDashboard(store).render(new URL('http://localhost/'));
    expect(html).toContain('Known time Base mint');
    expect(html).toContain('Unknown time Base mint');
    expect(html).toContain('Base opportunity');
    expect(html).not.toContain('READ_MODEL_SCHEMA_MISMATCH');
    expect(html).not.toContain('Ethereum; contract');
  });
});


describe('canonical accounting presentation', () => {
  it('projects verified local receipt inputs through the GET client and dashboard without introducing spending authority', async () => {
    const store = new DurableStore();
    const wallet = `0x${'1'.repeat(40)}`;
    const target = `0x${'2'.repeat(40)}`;
    const hash = `0x${'a'.repeat(64)}`;
    const blockHash = `0x${'b'.repeat(64)}`;
    const current: Campaign = { id: 'analytics-campaign', chainId: 8453, contract: NFT, strategy: 'seadrop-v1-public', state: 'Completed', quantity: 1, dryRun: false, mintPriceWei: 0n, feePolicy: { kind: 'free', configuredPriorityFeeWei: 1n }, spendPolicy: { maxRunWei: 100n, dailyCapWei: 100n, gasCeilingWei: 100n }, chainVerification: { chainId: 8453, status: 'verified', seaDropCompatible: true, endpointReference: 'configured' }, createdAt: AT, updatedAt: AT };
    await store.transaction(state => {
      state.campaigns.push(current);
      state.runs.push({ id: 'analytics-run', intentId: 'analytics-intent', campaignId: current.id, mode: 'live', requestDigest: 'digest', state: 'Completed', createdAt: AT, updatedAt: AT });
      state.intents.push({ id: 'analytics-intent', runId: 'analytics-run', campaignId: current.id, campaignSnapshot: current, wallets: [wallet], policy: current.spendPolicy, feePolicy: current.feePolicy, chainVerification: current.chainVerification, simulationIds: [], evidenceAt: AT, createdAt: AT });
      state.attempts.push({ id: 'analytics-attempt', executionId: 'analytics-execution', runId: 'analytics-run', wallet, hash, state: 'Confirmed', createdAt: AT, updatedAt: AT });
      state.receipts.push({ id: 'analytics-receipt', executionId: 'analytics-execution', runId: 'analytics-run', transactionAttemptId: 'analytics-attempt', state: 'Confirmed', finalityStage: 'ethereum_final', blockNumber: 1n, blockHash, actualSpendWei: 16n, observedAt: AT });
      state.reservations.push({ id: 'analytics-reservation', runId: 'analytics-run', campaignId: current.id, chainId: 8453, wallet, amountWei: 100n, actualAmountWei: 16n, status: 'settled', accountingDate: '2026-11-07', createdAt: AT, updatedAt: AT });
    });
    const ingestion = await ingestCanonicalAnalytics({ store, now: () => new Date(AT), port: async () => ({
      expectedTarget: target, chainId: async () => 8453,
      transaction: async () => ({ hash, from: wallet, to: target, value: 0n, blockNumber: 1n, blockHash }),
      receipt: async () => ({ transactionHash: hash, from: wallet, to: target, status: 'success' as const, blockNumber: 1n, blockHash, transactionIndex: 0, logs: [{ address: NFT, topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', `0x${'0'.repeat(64)}`, `0x${'0'.repeat(24)}${wallet.slice(2)}`, `0x${'0'.repeat(62)}2a`], data: '0x', logIndex: 0, transactionHash: hash, blockNumber: 1n, blockHash }] }),
      block: async () => ({ number: 1n, hash: blockHash, timestamp: BigInt(Date.parse(AT) / 1000) }),
    }) });
    expect(ingestion.confirmed).toBe(1);
    const before = store.snapshot();
    const dashboard = createDashboard(store);
    const client = new ReadModelClient({ get: async request => dashboard.readModel.handle(request).body });
    const analytics = await client.getAnalytics();
    expect(analytics.data).toMatchObject({ mode: 'shadow-only', coverage: { canonicalExecutions: 1, confirmedActivities: 1, providerCoverageAsserted: false }, totals: { recordedCanonicalCostWei: '16', realizedPnlWei: null, realizedRoiBps: null, unrealizedPnlWei: null } });
    expect(analytics.data?.groups.some(group => group.dimension === 'wallet' && group.key.startsWith('8453:'))).toBe(true);
    const html = await dashboard.render(new URL('http://localhost/'));
    expect(html).toContain('Mint accounting and shadow evaluation');
    expect(html).toContain('0.000000000000000016 ETH');
    expect(html).toContain('External sale and transfer history is incomplete');
    expect(html).not.toContain('READ_MODEL_SCHEMA_MISMATCH');
    expect(dashboard.readModel.handle({ method: 'POST', path: '/api/v1/read-model/analytics' }).status).toBe(405);
    expect(store.snapshot()).toEqual(before);
  });
});
