import type {
  Freshness,
  GateCheck,
  ReadModelEnvelope,
  ReadModelIssue,
  SourcedAmount,
  SourcedQuantity,
  SourcedTime,
} from './contracts.js';

const INTEGER_PATTERN = /^(0|[1-9][0-9]*)$/;
const SENSITIVE_TEXT_PATTERN = /(?:private[_ -]?key|mnemonic|seed(?:[_ -]?phrase)?|passphrase|password|api[_ -]?key|access[_ -]?token|auth(?:orization)?|secret(?:[_ -]?key)?|credential|(?:rpc|archive|sequencer|relay)[-_ ]?(?:url|endpoint))/i;
const CREDENTIAL_URL_PATTERN = /(?:https?|wss?):\/\/[^/\s:@]+:[^/\s@]+@/i;

export type SurfaceStatus = 'Available' | 'Partial' | 'Stale' | 'Unavailable' | 'Unknown';
const SAFE_ACTIONS = new Set([
  'Inspect',
  'Refresh read model',
  'Resolve eligibility',
  'Fund wallet',
  'Validate again',
  'Wait for reconciliation',
  'No safe action',
]);

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function safeText(value: string | null | undefined, fallback = 'Unknown'): string {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  if (SENSITIVE_TEXT_PATTERN.test(value) || CREDENTIAL_URL_PATTERN.test(value)) return 'Unavailable';
  return escapeHtml(value);
}

export function safeIdentifier(value: string | null | undefined): string {
  if (typeof value !== 'string' || value.length === 0) return 'Unknown';
  if (SENSITIVE_TEXT_PATTERN.test(value) || CREDENTIAL_URL_PATTERN.test(value)) return 'Unavailable';
  if (value.length <= 20) return escapeHtml(value);
  return escapeHtml(`${value.slice(0, 10)}...${value.slice(-6)}`);
}

export function safePath(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return null;
  if (SENSITIVE_TEXT_PATTERN.test(value) || CREDENTIAL_URL_PATTERN.test(value)) return null;
  return escapeHtml(value);
}

export function validIntegerString(value: string | null | undefined): value is string {
  return typeof value === 'string' && INTEGER_PATTERN.test(value);
}

export function formatInteger(value: string | null | undefined): string {
  return validIntegerString(value) ? escapeHtml(value) : 'Unknown';
}

function formatWei(value: string): string | null {
  if (typeof value !== 'string') return null;
  if (!validIntegerString(value)) return null;
  const padded = value.padStart(19, '0');
  const whole = padded.slice(0, -18);
  const fraction = padded.slice(-18).replace(/0+$/, '');
  return fraction.length === 0 ? `${whole} ETH` : `${whole}.${fraction} ETH`;
}

export function formatAmount(amount: SourcedAmount | null | undefined): string {
  if (!amount?.amount) return 'Unknown';
  const item = amount.amount;
  if (item.asset !== 'ETH' || item.unit !== 'wei' || item.decimals !== 18) return 'Unknown';
  const formatted = formatWei(item.value);
  return formatted === null ? 'Unknown' : escapeHtml(formatted);
}

export function formatQuantity(quantity: SourcedQuantity | null | undefined): string {
  if (!quantity || quantity.unit !== 'gas' || !validIntegerString(quantity.value)) return 'Unknown';
  return `${formatInteger(quantity.value)} gas`;
}

export function formatTime(value: string | null | undefined): string {
  if (typeof value !== 'string' || value.length === 0) return 'Unknown';
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return 'Unknown';
  return escapeHtml(value);
}

export function surfaceStatus<T>(envelope: ReadModelEnvelope<T>): SurfaceStatus {
  if (envelope.data === null || envelope.availability === 'unavailable') return 'Unavailable';
  if (envelope.availability === 'partial' || envelope.snapshot.consistency === 'partial') return 'Partial';
  if (envelope.availability === 'stale' || envelope.freshness.status === 'stale') return 'Stale';
  if (envelope.availability !== 'available' || envelope.freshness.status === 'unknown') return 'Unknown';
  return 'Available';
}

export function stateClass(value: string): string {
  if (typeof value !== 'string') return 'unknown';
  if (SENSITIVE_TEXT_PATTERN.test(value) || CREDENTIAL_URL_PATTERN.test(value)) return 'unknown';
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown';
}

export function renderBadge(value: string, label = value): string {
  const className = stateClass(value);
  return `<span class="status-badge status-${className}" aria-label="${safeText(label)}"><span class="status-dot" aria-hidden="true"></span>${safeText(label)}</span>`;
}

export function renderFreshness(freshness: Freshness | null | undefined): string {
  if (!freshness) return '<span class="freshness freshness-unknown">Freshness: Unknown</span>';
  const status = freshness.status === 'fresh' || freshness.status === 'stale' ? freshness.status : 'unknown';
  const statusLabel = status === 'fresh' ? 'Fresh' : status === 'stale' ? 'Stale' : 'Unknown';
  const age = validIntegerString(freshness.ageSeconds) ? `${formatInteger(freshness.ageSeconds)}s old` : 'age unknown';
  const observed = freshness.observedAt ? `; observed ${formatTime(freshness.observedAt)}` : '';
  const expires = freshness.expiresAt ? `; expires ${formatTime(freshness.expiresAt)}` : '';
  return `<span class="freshness freshness-${status}" aria-label="${statusLabel} data, ${age}">${statusLabel}; ${age}${observed}${expires}</span>`;
}

export function renderAmount(amount: SourcedAmount | null | undefined, label: string): string {
  const kind = amount?.kind ?? 'unknown';
  const value = formatAmount(amount);
  const kindLabel = kind === 'reserved' ? 'Reserved; not settled' : kind === 'actual' ? 'Actual Backend observation; finality shown separately' : kind === 'estimated' ? 'Estimate; not settled' : 'Unknown amount kind';
  return `<div class="metric"><span class="metric-label">${safeText(label)}</span><strong>${value}</strong><span class="metric-meta">${safeText(kindLabel)}; ${renderFreshness(amount?.freshness)}</span></div>`;
}

export function renderTime(time: SourcedTime | null | undefined, label: string): string {
  const value = formatTime(time?.value);
  return `<div class="metric"><span class="metric-label">${safeText(label)}</span><strong>${value}</strong><span class="metric-meta">${renderFreshness(time?.freshness)}</span></div>`;
}

export function renderIssue(issue: ReadModelIssue): string {
  const severity = issue.severity;
  const action = safeActionLabel(issue.safeAction);
  const retry = issue.retryable ? 'Backend marked this read operation as retryable.' : 'No safe retry is supplied.';
  return `<li class="issue issue-${stateClass(severity)}"><div>${renderBadge(severity, severity)} <strong>${safeText(issue.code)}</strong></div><p>${safeText(issue.message)}</p><p class="issue-next">${action}; ${retry}</p></li>`;
}

export function safeActionLabel(action: string | null | undefined): string {
  return typeof action === 'string' && SAFE_ACTIONS.has(action) ? action : 'No safe action';
}

export function renderIssues(issues: readonly ReadModelIssue[], headingId = 'issues-heading'): string {
  if (issues.length === 0) return '';
  return `<section class="issues" aria-labelledby="${safeText(headingId)}"><h3 id="${safeText(headingId)}">What needs attention</h3><ul>${issues.map(renderIssue).join('')}</ul></section>`;
}

export function renderCheck(check: GateCheck): string {
  const outcome = check.outcome === 'pass' || check.outcome === 'fail' || check.outcome === 'stale' ? check.outcome : 'unknown';
  const required = check.required ? 'Required' : 'Informational';
  return `<li class="check check-${outcome}"><div>${renderBadge(outcome, outcome)} <strong>${safeText(check.code)}</strong> <span class="check-required">${required}</span></div><p>${safeText(check.message)}</p><span class="metric-meta">${renderFreshness(check.freshness)}</span></li>`;
}

export function renderGate(gate: { decision: string; checks: readonly GateCheck[]; blockers: readonly ReadModelIssue[]; nextAction: string }, heading = 'Safety gate', idSuffix = ''): string {
  const decision = gate.decision === 'permitted' || gate.decision === 'blocked' ? gate.decision : 'unknown';
  const label = decision === 'permitted' ? 'Recorded checks pass' : decision === 'blocked' ? 'Blocked' : 'Unknown';
  const headingId = `gate-heading${stateClass(idSuffix) === 'unknown' ? '' : `-${stateClass(idSuffix)}`}`;
  return `<section class="gate" aria-labelledby="${headingId}"><div class="section-heading"><h3 id="${headingId}">${safeText(heading)}</h3>${renderBadge(decision, label)}</div><ul class="check-list">${gate.checks.length > 0 ? gate.checks.map(renderCheck).join('') : '<li class="empty-state">No checks were supplied.</li>'}</ul>${renderIssues(gate.blockers, `${headingId}-issues`)}<p class="next-action">Next safe action: ${safeActionLabel(gate.nextAction)}</p></section>`;
}

export function renderEnvelopeNotice<T>(envelope: ReadModelEnvelope<T>, subject: string): string {
  const status = surfaceStatus(envelope);
  if (status === 'Available') return '';
  const next = status === 'Stale' ? 'Wait for a fresh Backend projection.' : status === 'Partial' ? 'Inspect the available records and treat omitted areas as unknown.' : status === 'Unavailable' ? 'Backend read data is unavailable; no readiness or spend claim is made.' : 'Inspect the Backend projection before relying on this information.';
  return `<div class="surface-notice surface-notice-${stateClass(status)}" role="status">${renderBadge(status, status)} <strong>${safeText(subject)}</strong> - ${safeText(next)} ${renderFreshness(envelope.freshness)}</div>`;
}

export function renderProvenance(provenance: ReadonlyArray<{ recordId: string; observedAt: string; kind: string; sourceBlockNumber?: string; modelVersion?: string; policyVersion?: string }>): string {
  if (provenance.length === 0) return '<span class="metric-meta">Source: Unknown</span>';
  return `<details class="provenance"><summary>Evidence details</summary><ul>${provenance.map((item) => `<li>${safeText(item.kind)}; record ${safeIdentifier(item.recordId)}; observed ${formatTime(item.observedAt)}${item.sourceBlockNumber ? `; block ${safeIdentifier(item.sourceBlockNumber)}` : ''}${item.modelVersion ? `; model ${safeText(item.modelVersion)}` : ''}${item.policyVersion ? `; policy ${safeText(item.policyVersion)}` : ''}</li>`).join('')}</ul></details>`;
}

export function renderUnavailableSurface(title: string): string {
  return `<section class="surface surface-unavailable" aria-labelledby="unavailable-${stateClass(title)}"><h2 id="unavailable-${stateClass(title)}">${safeText(title)}</h2><div class="surface-notice surface-notice-unavailable" role="status">${renderBadge('Unavailable', 'Unavailable')} <strong>${safeText(title)}</strong> - Backend read data is not connected, so no client-side substitute is shown.</div></section>`;
}
