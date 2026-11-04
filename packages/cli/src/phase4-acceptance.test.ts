import { describe, expect, it } from 'vitest';
import { CanonicalStoreBridge, campaignInputDigest, type EventRecord } from '@mint-bot/backend';
import { openDatabase } from '@mint-bot/database';
import { fixture as canonicalFixture, campaign, armed, close, ETHEREUM, NOW, WALLET_ONE, WALLET_TWO } from '../../backend/dist/canonical-fixtures.js';
import { phase4AcceptanceReport, readPhase4AcceptanceReport, type ReplicationAuditRequest, type ReplicationAuditSimulation } from './phase4-acceptance.js';

const a = `0x${'1'.repeat(40)}`;
const b = `0x${'2'.repeat(40)}`;
const nft = `0x${'3'.repeat(40)}`;
const start = Date.parse('2026-11-04T12:00:00Z');
const time = (minutes: number) => new Date(start + minutes * 60_000).toISOString();
const mint = (id: string, wallet: string, minutes = 0, chainId = 1): EventRecord => ({ id, type: 'watched_wallet_mint', at: time(minutes), data: { chainId, contract: nft, wallet, txHash: `0x${id.charCodeAt(0).toString(16).padStart(64, '0')}`, sourceBlock: '100' } });
function fixture() {
  const source = mint('source', a);
  const authority: EventRecord = { id: 'authority', type: 'replication_prepared', at: time(1), data: { campaignId: 'campaign', campaignDigest: 'digest', policyVersion: 'free-watched-v1', mintPriceWei: '0', score: 70, wallets: [b], maxFeeGwei: 0.2, scoreEventId: 'score', sourceEventId: source.id, sourceWallet: a, sourceTxHash: source.data.txHash } };
  const request: ReplicationAuditRequest = { id: 'request', campaignId: 'campaign', authorityId: authority.id, wallets: [b], simulationIds: ['simulation'], maxFeeGwei: 0.1, requestedAt: time(2) };
  const simulation: ReplicationAuditSimulation = { id: 'simulation', campaignId: 'campaign', wallet: b, success: true, inputDigest: 'digest', checkedAt: time(1), expiresAt: time(10) };
  const score: EventRecord = { id: 'score', type: 'opportunity_scored', at: time(0), data: { chainId: 1, contract: nft, score: 70, scoreVersion: 'v1-rules-p2', expiresAt: time(15) } };
  return { campaigns: [{ id: 'campaign', chainId: 1, contract: nft }], events: [source, score, authority], requests: [request], simulations: [simulation], authority, source, request, simulation, score };
}
function executionFixture() {
  const s = fixture();
  s.request.approvalId = 'approval';
  s.request.expiresAt = time(10);
  s.events.push({ id: 'approval', type: 'campaign_approved', at: time(1), data: { campaignId: 'campaign', wallets: [b], simulationIds: ['simulation'] } });
  s.events.push({ id: 'result', type: 'live_request_result', runId: 'run', at: time(4), data: { requestId: 'request', state: 'finished' } });
  return { ...s, runs: [{ id: 'run', campaignId: 'campaign', requestKey: 'live-request:request' }],
    attempts: [{ id: 'attempt', runId: 'run', executionId: 'execution', campaignId: 'campaign', wallet: b, hash: `0x${'a'.repeat(64)}`, at: time(3), reservationId: 'reservation', valueWei: '0', feeBudgetWei: '100', campaignDigest: 'digest' }],
    reservations: [{ id: 'reservation', executionId: 'execution', campaignId: 'campaign', wallet: b, amountWei: '100', createdAt: time(2) }],
  };
}

describe('Phase 4 historical observation replay and request provenance audit', () => {
  it.each(['automatic', 'attended', 'orphan'] as const)('audits real SQLite %s admission and signed attempt with correct request scope', async (mode) => {
    const f = await canonicalFixture(ETHEREUM);
    try {
      const c = await campaign(f, ETHEREUM);
      const expiry = new Date(Date.parse(NOW) + 10 * 60_000).toISOString();
      const source: EventRecord = { ...mint('source', WALLET_TWO), at: NOW, data: { ...mint('source', WALLET_TWO).data, contract: c.contract } };
      const score: EventRecord = { id: 'score', type: 'opportunity_scored', at: NOW, data: { chainId: 1, contract: c.contract, score: 70, scoreVersion: 'v1-rules-p2', expiresAt: expiry } };
      await f.store.transaction((state) => {
        state.simulations.push({ id: 'sim', campaignId: c.id, wallet: WALLET_ONE, inputDigest: campaignInputDigest(c), success: true, sourceBlock: 1n, sourceBlockHash: `0x${'b'.repeat(64)}`, checkedAt: NOW, expiresAt: expiry, worstCaseFeeWei: 34n });
        state.events.push(source, score,
          { id: 'authority', type: 'replication_prepared', at: NOW, data: { campaignId: c.id, campaignDigest: campaignInputDigest(c), mintPriceWei: '0', policyVersion: 'free-watched-v1', score: 70, maxFeeGwei: 0.2, wallets: [WALLET_ONE], scoreEventId: 'score', sourceEventId: source.id, sourceWallet: WALLET_TWO, sourceTxHash: source.data.txHash } },
          { id: 'approval', type: 'campaign_approved', at: NOW, data: { campaignId: c.id, wallets: [WALLET_ONE], simulationIds: ['sim'] } });
      });
      if (mode !== 'orphan') f.store.recordLiveRunRequest({ id: 'request', campaignId: c.id, wallets: [WALLET_ONE], simulationIds: ['sim'], approvalId: 'approval', evidenceAt: NOW, maxFeeGwei: '0.1', confirmationDigest: 'c'.repeat(64), requestedAt: NOW, expiresAt: expiry, provenance: mode === 'automatic' ? { kind: 'automation', eventId: 'authority' } : { kind: 'attended' } });
      const prepared = await armed(f, c, [WALLET_ONE], ['sim'], '', 'live-request:request');
      const admitted = await f.store.admitExecution(prepared.input);
      const execution = admitted.executions[0]!;
      await f.store.persistEngineAttempt({ id: 'attempt', executionId: execution.executionId, transactionIntentId: execution.intentId, endpoint: 'public-rpc', responseClass: 'signed', nonce: 0, txHash: `0x${'a'.repeat(64)}`, attemptedAt: NOW });
      await f.store.transaction((state) => state.events.push({ id: 'result', type: 'live_request_result', runId: prepared.run.id, at: NOW, data: { requestId: 'request', state: 'finished' } }));
      const report = readPhase4AcceptanceReport(f.db);
      if (mode === 'automatic') {
        expect(report.replicationAudit).toMatchObject({ result: 'clean', requestsChecked: 1 });
        expect(report.executionAudit).toEqual({ result: 'clean', attemptsChecked: 1, findings: [] });
      } else if (mode === 'attended') {
        expect(report.replicationAudit.result).toBe('no_samples');
        expect(report.executionAudit).toEqual({ result: 'no_samples', attemptsChecked: 0, findings: [] });
      } else {
        expect(report.executionAudit).toMatchObject({ result: 'findings', attemptsChecked: 1 });
        expect(report.executionAudit.findings[0]?.problems).toContain('EXECUTION_REQUEST_LINK_INVALID');
      }
    } finally { await close(f); }
  });
  it('reads the real canonical audit-event storage, including observations that have no domain-event projection', async () => {
    const db = openDatabase();
    const store = new CanonicalStoreBridge(db);
    await store.open();
    try {
      await store.transaction((state) => state.events.push(mint('first', a), mint('second', b, 5)));
      const report = readPhase4AcceptanceReport(db);
      expect(report.observedMintTransactions).toBe(2);
      expect(report.convergence.matches).toHaveLength(1);
      expect(report.replicationAudit.result).toBe('no_samples');
    } finally { store.close(); }
  });
  it('replays distinct-wallet convergence independent of input ordering, duplicate scans and other chains', () => {
    const first = mint('first', a);
    const second = mint('second', b, 5);
    const duplicate = { ...first, id: 'duplicate', at: time(3) };
    const otherChain = mint('other', b, 1, 8453);
    const report = phase4AcceptanceReport({ events: [second, otherChain, duplicate, first], requests: [], simulations: [] });
    expect(report.observedMintTransactions).toBe(3);
    expect(report.walletHistory).toHaveLength(3);
    expect(report.walletHistory[0]).toMatchObject({ chainId: 1, wallet: a, transactions: 1, collectionsMinted: 1 });
    expect(report.convergence.matches).toEqual([{ chainId: 1, contract: nft, at: time(5), wallets: [a, b], eventIds: ['first', 'second'] }]);
    expect(report.replicationAudit.result).toBe('no_samples');
  });
  it('does not count received-only NFTs, malformed source facts, repeated wallets or observations outside the window', () => {
    const first = mint('first', a);
    const repeated = mint('repeat', a, 2);
    const old = mint('old', b, -361);
    const gift = { ...mint('gift', b, 1), type: 'wallet_received' };
    const malformed = { ...mint('malformed', b, 3), data: { ...mint('malformed', b).data, sourceBlock: 'unknown' } };
    expect(phase4AcceptanceReport({ events: [first, repeated, old, gift, malformed], requests: [], simulations: [] }).convergence.matches).toEqual([]);
  });
  it('reports a clean bounded request with source evidence and one fresh simulation per wallet', () => {
    const s = fixture();
    expect(phase4AcceptanceReport(s).replicationAudit).toEqual({ requestsChecked: 1, findings: [], result: 'clean' });
  });
  it('audits actual transaction attempts against run/request, approval, fresh simulation and the prior reservation', () => {
    const report = phase4AcceptanceReport(executionFixture());
    expect(report.executionAudit).toEqual({ attemptsChecked: 1, findings: [], result: 'clean' });
  });
  it('permits a newer still-qualifying score at execution without requiring its old score ID', () => {
    const s = executionFixture();
    s.events.push({ ...s.score, id: 'upgrade', at: time(2.5), data: { ...s.score.data, score: 80 } });
    expect(phase4AcceptanceReport(s).executionAudit.result).toBe('clean');
  });
  it.each(['missing-request', 'missing-run', 'missing-result', 'missing-approval', 'missing-reservation', 'late-reservation', 'small-reservation', 'stale-simulation', 'stale-signal', 'expired-request', 'bad-result-run', 'post-request-downgrade', 'simulation-digest', 'intent-digest'] as const)('detects executed provenance problem: %s', (change) => {
    const s = executionFixture();
    if (change === 'missing-request') s.requests = [];
    if (change === 'missing-run') s.runs = [];
    if (change === 'missing-result') s.events = s.events.filter((event) => event.id !== 'result');
    if (change === 'missing-approval') s.events = s.events.filter((event) => event.id !== 'approval');
    if (change === 'missing-reservation') s.reservations = [];
    if (change === 'late-reservation') s.reservations[0]!.createdAt = time(4);
    if (change === 'small-reservation') s.reservations[0]!.amountWei = '99';
    if (change === 'stale-simulation') s.simulation.expiresAt = time(3);
    if (change === 'stale-signal') s.attempts[0]!.at = time(16);
    if (change === 'expired-request') s.request.expiresAt = time(3);
    if (change === 'bad-result-run') s.events.find((event) => event.id === 'result')!.runId = 'another-run';
    if (change === 'simulation-digest') s.simulation.inputDigest = 'other';
    if (change === 'intent-digest') s.attempts[0]!.campaignDigest = 'other';
    if (change === 'post-request-downgrade') s.events.push({ ...s.score, id: 'downgrade', at: time(2.5), data: { ...s.score.data, score: 69 } });
    expect(phase4AcceptanceReport(s).executionAudit.result).toBe('findings');
  });
  it.each(['paid', 'score', 'missing-source', 'stale-source', 'wallet', 'fee', 'simulation', 'missing-authority', 'missing-score', 'downgraded-score', 'wrong-chain', 'wrong-contract'] as const)('reports %s provenance drift instead of an empty success', (change) => {
    const s = fixture();
    if (change === 'paid') s.authority.data.mintPriceWei = '1';
    if (change === 'score') s.authority.data.score = 69;
    if (change === 'missing-source') s.events = [s.authority];
    if (change === 'stale-source') s.source.at = time(-30);
    if (change === 'wallet') s.request.wallets = [a];
    if (change === 'fee') s.request.maxFeeGwei = 0.3;
    if (change === 'simulation') s.simulation.expiresAt = time(2);
    if (change === 'missing-authority') s.events = [s.source];
    if (change === 'missing-score') s.events = [s.source, s.authority];
    if (change === 'downgraded-score') s.events.push({ ...s.score, id: 'downgrade', at: time(1), data: { ...s.score.data, score: 69 } });
    if (change === 'wrong-chain') s.campaigns[0]!.chainId = 8453;
    if (change === 'wrong-contract') s.campaigns[0]!.contract = a;
    const report = phase4AcceptanceReport(s);
    expect(report.replicationAudit.result).toBe('findings');
    expect(report.replicationAudit.findings[0]?.requestId).toBe('request');
  });
});
