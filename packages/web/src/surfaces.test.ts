import { describe, expect, it } from 'vitest';
import type {
  AlertReadModel,
  AlertsReadModel,
  CalendarEntry,
  CalendarReadModel,
  Finality,
  Freshness,
  GateSummary,
  HomeReadModel,
  OpportunityReadModel,
  Provenance,
  ReadinessReadModel,
  ReadinessRow,
  ReadModelEnvelope,
  RetryPolicy,
  SourcedAmount,
  SourcedTime,
  SystemHealth,
} from './contracts.js';
import { renderAlerts, renderCalendar, renderFinality, renderHealth, renderHome, renderReadiness, renderRun } from './surfaces.js';
import { renderApp } from './main.js';
import { WEB_STYLES } from './styles.js';
import { formatAmount, safeActionLabel, safeText, stateClass } from './format.js';

const baseFreshness: Freshness = {
  status: 'fresh',
  observedAt: '2026-09-17T22:00:00.000Z',
  expiresAt: '2026-09-17T22:15:00.000Z',
  ageSeconds: '5',
  policyVersion: 'fixture-v1',
};

const OBSERVED_AT = '2026-09-17T22:00:00.000Z';
const EXPIRES_AT = '2026-09-17T22:15:00.000Z';

const staleFreshness: Freshness = {
  ...baseFreshness,
  status: 'stale',
  expiresAt: '2026-09-17T21:00:00.000Z',
  ageSeconds: '3600',
};

const unknownFreshness: Freshness = {
  status: 'unknown',
  observedAt: null,
  expiresAt: null,
  ageSeconds: null,
  policyVersion: null,
};

const source: Provenance = { kind: 'backend_store', recordId: 'record-1', observedAt: OBSERVED_AT };
const provenance = [source];

function amount(value: string | null, kind: SourcedAmount['kind'] = 'estimated', freshness = baseFreshness): SourcedAmount {
  return {
    amount: value === null ? null : { value, asset: 'ETH', unit: 'wei', decimals: 18 },
    kind,
    freshness,
    provenance,
  };
}

function sourcedTime(value: string | null, freshness = baseFreshness): SourcedTime {
  return { value, freshness, provenance };
}

function gate(decision: GateSummary['decision'] = 'blocked'): GateSummary {
  return {
    decision,
    checks: [{ code: 'simulated', outcome: decision === 'permitted' ? 'pass' : 'fail', required: true, message: 'Backend check result', evaluatedAt: OBSERVED_AT, validUntil: EXPIRES_AT, freshness: baseFreshness, provenance: source }],
    blockers: decision === 'blocked' ? [{ code: 'SIMULATION_FAILED', severity: 'blocking', message: 'Simulation needs review', retryable: false, safeAction: 'Inspect', provenance: source }] : [],
    nextAction: decision === 'blocked' ? 'Inspect' : 'No safe action',
  };
}

function envelope<T>(data: T | null, availability: ReadModelEnvelope<T>['availability'] = 'available', freshness = baseFreshness): ReadModelEnvelope<T> {
  return {
    contract: 'mintbot.read-model',
    version: '1',
    requestId: 'request-1',
    generatedAt: OBSERVED_AT,
    snapshot: { id: 'snapshot-1', capturedAt: OBSERVED_AT, consistency: availability === 'partial' ? 'partial' : 'snapshot' },
    availability,
    freshness,
    data,
    issues: [],
  };
}

const retry: RetryPolicy = {
  allowed: false,
  kind: 'none',
  reasonCode: 'NO_RETRY',
  message: 'No safe retry',
  requiresFreshData: true,
  safeAction: 'No safe action',
};

function readinessRow(overrides: Partial<ReadinessRow> = {}): ReadinessRow {
  return {
    campaignId: 'campaign-1',
    wallet: { id: 'wallet-1', address: '0x1234567890abcdef1234567890abcdef12345678', label: 'Primary' },
    state: 'Unknown',
    decision: 'unknown',
    checks: [{ code: 'eligible', outcome: 'unknown', required: true, message: 'Eligibility authority has not answered', evaluatedAt: null, validUntil: null, freshness: unknownFreshness, provenance: source }],
    blockers: [{ code: 'ELIGIBILITY_UNKNOWN', severity: 'warning', message: 'Eligibility is not known yet', retryable: true, safeAction: 'Resolve eligibility', provenance: source }],
    cost: { mintValue: amount(null, 'unknown'), executionGas: amount('1000000000000000'), dataPostingGas: null, priorityFeeComponent: null, estimatedTotal: amount(null, 'unknown'), balance: null },
    nextAction: 'Resolve eligibility',
    freshness: unknownFreshness,
    provenance,
    ...overrides,
  };
}

function summary(overrides: Partial<HomeReadModel['readinessSummary']> = {}): HomeReadModel['readinessSummary'] {
  return { total: '1', ready: '0', blocked: '0', unknown: '1', stale: '0', ineligible: '0', executing: '0', freshness: baseFreshness, ...overrides };
}

function system(overrides: Partial<SystemHealth> = {}): SystemHealth {
  return {
    state: 'Not ready',
    killSwitch: 'clear',
    dependencies: { engine: 'ready', chain: 'not_ready', backup: 'unknown', notifications: 'ready', reconciliation: 'required' },
    blockers: [{ code: 'CHAIN_NOT_READY', severity: 'blocking', message: 'Chain verification is pending', retryable: false, safeAction: 'No safe action' }],
    checkedAt: OBSERVED_AT,
    freshness: baseFreshness,
    ...overrides,
  };
}

function opportunity(overrides: Partial<OpportunityReadModel> = {}): OpportunityReadModel {
  return {
    id: 'opportunity-1',
    project: { name: 'Example Drop', contract: '0xcontract' },
    chain: { id: '1', name: 'Ethereum', verification: gate('blocked') },
    disposition: 'scored',
    openingAt: '2026-09-18T00:00:00.000Z',
    price: amount('100000000000000000'),
    score: { value: 88, modelVersion: 'rules-v1', confidence: { sampleSize: '4', denominator: null, label: 'unknown' }, factors: [{ code: 'RECENCY', contribution: 20, explanation: 'Recent evidence', provenance, freshness: baseFreshness }], freshness: baseFreshness, provenance },
    risks: [{ code: 'UNVERIFIED_CHAIN', severity: 'blocking', message: 'Chain verification is incomplete', freshness: baseFreshness, provenance: source }],
    evidence: [{ id: 'evidence-1', label: 'Source observation', summary: 'Backend supplied evidence', provenance, freshness: baseFreshness }],
    gate: gate('blocked'),
    readiness: summary(),
    nextAction: 'Inspect',
    freshness: baseFreshness,
    provenance,
    ...overrides,
  };
}

function home(overrides: Partial<HomeReadModel> = {}): HomeReadModel {
  return {
    attention: [{ id: 'attention-1', severity: 'warning', subjectId: 'opportunity-1', state: 'Unknown', reason: 'Review the supplied evidence', freshness: baseFreshness, provenance, nextAction: 'Inspect' }],
    readinessSummary: summary(),
    opportunities: [opportunity()],
    calendarHighlights: [],
    alerts: [],
    system: system(),
    ...overrides,
  };
}

function calendarEntry(overrides: Partial<CalendarEntry> = {}): CalendarEntry {
  return {
    id: 'calendar-1',
    project: { name: 'Example Drop', collection: 'Example Collection', contract: '0xcontract' },
    chain: { id: '1', name: 'Ethereum' },
    opening: sourcedTime('2026-09-18T00:00:00.000Z'),
    closing: sourcedTime('2026-09-18T01:00:00.000Z'),
    phase: 'Public',
    price: amount('0'),
    supply: '1000',
    perWalletLimit: '2',
    method: 'SeaDrop',
    access: 'public',
    expectedGas: amount('1000000000000000'),
    sourceAuthority: 'external_source',
    verificationStatus: 'verified',
    lastVerifiedAt: OBSERVED_AT,
    expiresAt: EXPIRES_AT,
    eligibility: { eligible: '1', ineligible: '0', unknown: '0', ready: '0', stale: '0' },
    nextAction: 'Inspect',
    freshness: baseFreshness,
    provenance,
    ...overrides,
  };
}

function alert(overrides: Partial<AlertReadModel> = {}): AlertReadModel {
  return { id: 'alert-1', type: 'Opening soon', severity: 'info', subjectId: 'calendar-1', message: 'The opening time is approaching.', state: 'delivered', createdAt: OBSERVED_AT, deliveredAt: OBSERVED_AT, canonicalPath: '/calendar/calendar-1', nextAction: 'Inspect', freshness: baseFreshness, provenance, ...overrides };
}

describe('Phase 2 read-only surfaces', () => {
  it('keeps score, evidence, and the safety gate separate with Inspect as the only opportunity action', () => {
    const html = renderHome(envelope(home()));

    expect(html).toContain('Desirability score');
    expect(html).toContain('Score is not permission');
    expect(html).toContain('Safety gate');
    expect(html).toContain('Blocked');
    expect(html).toContain('Primary action: Inspect');
    expect(html).not.toContain('>Execute<');
    expect(html).not.toContain('>Promote proposal<');
  });

  it('renders unknown eligibility as Unknown and never substitutes Ineligible or a force action', () => {
    const model: ReadinessReadModel = { campaign: null, summary: summary(), rows: [readinessRow()] };
    const html = renderReadiness(envelope(model));
    const row = html.match(/<tr tabindex="0">([\s\S]*?)<\/tr>/)?.[1] ?? '';

    expect(html).toContain('Unknown');
    expect(html).toContain('Eligibility is not known yet');
    expect(row).not.toContain('Ineligible');
    expect(html).not.toContain('Force');
    expect(html).not.toContain('<button');
  });

  it('marks stale calendar evidence and keeps source authority visible', () => {
    const model: CalendarReadModel = { entries: [calendarEntry({ freshness: staleFreshness, opening: sourcedTime('2026-09-18T00:00:00.000Z', staleFreshness), sourceAuthority: 'operator_record', verificationStatus: 'stale' })] };
    const html = renderCalendar(envelope(model, 'stale', staleFreshness));

    expect(html).toContain('Stale');
    expect(html).toContain('operator record');
    expect(html).toContain('A source time is not an on-chain guarantee');
    expect(html).not.toContain('Ready for');
  });

  it('keeps unaffected records visible while identifying a partial projection', () => {
    const model: CalendarReadModel = { entries: [calendarEntry()] };
    const html = renderCalendar(envelope(model, 'partial'));

    expect(html).toContain('Partial');
    expect(html).toContain('Example Drop');
    expect(html).toContain('omitted areas as unknown');
  });

  it('renders missing amounts as Unknown rather than zero', () => {
    const model: ReadinessReadModel = { campaign: null, summary: summary(), rows: [readinessRow({ cost: { mintValue: amount(null, 'unknown'), executionGas: amount(null, 'unknown'), dataPostingGas: null, priorityFeeComponent: null, estimatedTotal: amount(null, 'unknown'), balance: null } })] };
    const html = renderReadiness(envelope(model));

    expect(html).toContain('Unknown');
    expect(html).not.toContain('0 ETH');
  });

  it('keeps delivered reminder state distinct from execution settlement', () => {
    const model: AlertsReadModel = { alerts: [alert()] };
    const html = renderAlerts(envelope(model));

    expect(html).toContain('delivered');
    expect(html).toContain('Alert delivery is not proof that a mint settled.');
    expect(html).toContain('href="/calendar/calendar-1"');
    expect(html).not.toContain('Minted');
  });

  it('maps staged finality to consumer labels without claiming success before Ethereum finality', () => {
    const soft = renderFinality({ stage: 'soft', requiredStage: 'ethereum_final', settlementReached: false, observedAt: OBSERVED_AT, freshness: baseFreshness, provenance });
    const posted = renderFinality({ stage: 'posted', requiredStage: 'ethereum_final', settlementReached: false, observedAt: OBSERVED_AT, freshness: baseFreshness, provenance });
    const final = renderFinality({ stage: 'ethereum_final', requiredStage: 'ethereum_final', settlementReached: true, observedAt: OBSERVED_AT, freshness: baseFreshness, provenance });

    expect(soft).toContain('Included');
    expect(soft).toContain('Waiting for Ethereum finality');
    expect(posted).toContain('Posted to Ethereum');
    expect(posted).toContain('Waiting for Ethereum finality');
    expect(final).toContain('Ethereum final');
    expect(final).toContain('Required settlement stage reached');
    expect(soft).not.toContain('Required settlement stage reached');
  });

  it('normalizes an unknown finality enum to the neutral Unknown state', () => {
    const unknown = renderFinality({ stage: 'future_stage' as unknown as Finality['stage'], requiredStage: 'ethereum_final', settlementReached: true, observedAt: OBSERVED_AT, freshness: baseFreshness, provenance });

    expect(unknown).toContain('status-unknown');
    expect(unknown).toContain('Unknown');
    expect(unknown).not.toContain('Required settlement stage reached');
  });

  it('preserves partial and unknown run states with affected-wallet and reconciliation copy', () => {
    const run = {
      run: { id: 'run-1', campaignId: 'campaign-1', mode: 'live' as const, state: 'Failed' as const, outcome: 'partial' as const, createdAt: OBSERVED_AT, updatedAt: OBSERVED_AT, retry },
      campaign: { id: 'campaign-1', state: 'Failed' as const, chainId: '1', contract: '0xcontract', quantity: '1', cost: amount('0'), gate: gate('blocked'), freshness: baseFreshness, provenance },
      walletResults: [{ walletId: 'wallet-1', address: '0x1234567890abcdef1234567890abcdef12345678', state: 'Failed', attemptIds: [], finality: null, retry, freshness: baseFreshness }],
      attempts: [],
      receipts: [],
      reconciliations: [{ id: 'reconciliation-1', state: 'unresolved' as const, observedAt: OBSERVED_AT, reason: 'Receipt is not reconciled', retry, provenance }],
      events: [],
      freshness: baseFreshness,
      provenance,
    };
    const html = renderRun(envelope(run));

    expect(html).toContain('Partial');
    expect(html).toContain('Failed');
    expect(html).toContain('unresolved');
    expect(html).toContain('No safe retry is supplied');
    expect(html).not.toContain('>Success<');
  });

  it('redacts unsafe text and ignores extra operational fields', () => {
    const unsafeAlert = alert({ message: 'private key = hidden material', canonicalPath: 'https://user:password@example.invalid/private' });
    const unsafeHealth = { ...system(), endpoint: 'https://user:password@example.invalid', signer: 'hidden material' } as unknown as SystemHealth;
    const alertHtml = renderAlerts(envelope({ alerts: [unsafeAlert] }));
    const healthHtml = renderHealth(envelope(unsafeHealth));

    expect(alertHtml).not.toContain('hidden material');
    expect(alertHtml).not.toContain('example.invalid');
    expect(healthHtml).not.toContain('example.invalid');
    expect(healthHtml).not.toContain('hidden material');
  });

  it('keeps unavailable data explicit instead of rendering an empty-success state', () => {
    const html = renderCalendar(envelope<CalendarReadModel>(null, 'unavailable', unknownFreshness));

    expect(html).toContain('Unavailable');
    expect(html).toContain('no readiness or spend claim is made');
    expect(html).not.toContain('No calendar records were supplied');
  });

  it('exposes keyboard and responsive semantics without color-only status meaning', () => {
    const html = renderReadiness(envelope({ campaign: null, summary: summary(), rows: [readinessRow()] }));

    expect(html).toContain('caption>Wallet-by-campaign readiness matrix');
    expect(html).toContain('scope="col"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('aria-label="Unknown data');
    expect(WEB_STYLES).toContain('@media (max-width: 720px)');
    expect(WEB_STYLES).toContain('prefers-reduced-motion');
    expect(WEB_STYLES).toContain('overflow-wrap: anywhere');
    expect(WEB_STYLES).toContain('focus-visible');
  });

  it('renders only read-only navigation and inspection links', () => {
    const html = renderApp({ home: envelope(home()), calendar: envelope({ entries: [calendarEntry()] }) });

    expect(html).toContain('data-read-only="true"');
    expect(html).toContain('href="#calendar"');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('onClick');
    expect(html).not.toContain('>Execute<');
  });

  it('marks the package as proposal-bound and fails closed on malformed wire primitives', () => {
    const html = renderApp({});

    expect(html).toContain('data-contract-status="proposal"');
    expect(formatAmount({ amount: { value: 1 as unknown as string, asset: 'ETH', unit: 'wei', decimals: 18 }, kind: 'estimated', freshness: baseFreshness, provenance } as unknown as SourcedAmount)).toBe('Unknown');
    expect(safeText('https://user:password@example.invalid')).toBe('Unavailable');
    expect(stateClass(null as unknown as string)).toBe('unknown');
    expect(stateClass('private key = hidden material')).toBe('unknown');
    expect(safeActionLabel('future mutation' as never)).toBe('No safe action');
  });
});
