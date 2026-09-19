import type {
  AlertReadModel,
  AlertsReadModel,
  AttentionItem,
  CalendarEntry,
  CalendarReadModel,
  Finality,
  HomeReadModel,
  OpportunityReadModel,
  ReadinessReadModel,
  ReadinessRow,
  ReadModelEnvelope,
  RunReadModel,
  SystemHealth,
  TimelineEvent,
  TransactionAttempt,
  TransactionReceipt,
  WalletExecutionResult,
} from './contracts.js';
import {
  escapeHtml,
  formatInteger,
  formatQuantity,
  formatTime,
  renderAmount,
  renderBadge,
  renderEnvelopeNotice,
  renderFreshness,
  renderGate,
  renderIssues,
  renderProvenance,
  safeIdentifier,
  safeActionLabel,
  safeText,
  stateClass,
  validIntegerString,
} from './format.js';

function surface<T>(
  id: string,
  title: string,
  description: string,
  envelope: ReadModelEnvelope<T>,
  content: (data: T) => string,
): string {
  const headingId = `${stateClass(id)}-heading`;
  const notice = renderEnvelopeNotice(envelope, title);
  const body = envelope.data === null
    ? `<div class="empty-state">No ${safeText(title.toLowerCase())} projection is available.</div>`
    : content(envelope.data);
  return `<section id="${stateClass(id)}" class="surface" aria-labelledby="${headingId}"><header class="surface-header"><p class="eyebrow">Read-only projection</p><h2 id="${headingId}">${safeText(title)}</h2><p>${safeText(description)}</p><p class="metric-meta">As of ${formatTime(envelope.generatedAt)}; snapshot ${safeIdentifier(envelope.snapshot.id)}.</p></header>${notice}${body}${renderIssues(envelope.issues, `${stateClass(id)}-issues`)}</section>`;
}

function emptyState(message: string): string {
  return `<div class="empty-state">${safeText(message)}</div>`;
}

function inspectLink(id: string, label = 'Inspect'): string {
  return `<a class="inspect-link" href="#${stateClass(id)}">${safeText(label)}</a>`;
}

function safeAction(action: string): string {
  return `<span class="next-action-label">${safeText(safeActionLabel(action))}</span>`;
}

function renderCounts(summary: {
  total: string;
  ready: string;
  blocked: string;
  unknown: string;
  stale: string;
  ineligible: string;
  executing: string;
}, idPrefix: string): string {
  const values: Array<[string, string, string]> = [
    ['total', 'Total wallets', summary.total],
    ['ready', 'Ready', summary.ready],
    ['blocked', 'Blocked', summary.blocked],
    ['unknown', 'Unknown', summary.unknown],
    ['stale', 'Stale', summary.stale],
    ['ineligible', 'Ineligible', summary.ineligible],
    ['executing', 'In progress', summary.executing],
  ];
  return `<div class="readiness-counts" aria-label="Readiness counts">${values.map(([key, label, value]) => `<div class="metric-card" id="${stateClass(idPrefix)}-${key}"><span class="metric-label">${safeText(label)}</span><strong>${formatInteger(value)}</strong></div>`).join('')}</div>`;
}

function renderAttention(item: AttentionItem, index: number): string {
  const id = `attention-${index}-${item.code}`;
  const action = item.safeAction === 'Inspect' ? inspectLink(id) : safeAction(item.safeAction);
  return `<article id="${stateClass(id)}" class="attention-card"><div class="section-heading"><h3>${safeText(item.code)}</h3>${renderBadge(item.severity, item.severity)}</div><p>${safeText(item.message)}</p><p class="next-action">${item.retryable ? 'Backend marked this read as retryable.' : 'No safe retry is supplied.'}</p><div class="card-footer">${action}</div>${renderProvenance(item.provenance ? [item.provenance] : [])}</article>`;
}

function renderOpportunity(opportunity: OpportunityReadModel, idPrefix = ''): string {
  const title = opportunity.project.name ?? 'Opportunity';
  const id = `${idPrefix}opportunity-${opportunity.id}`;
  const scoreValue = opportunity.score.value !== null && Number.isFinite(opportunity.score.value) && opportunity.score.value >= 0 && opportunity.score.value <= 100
    ? escapeHtml(String(opportunity.score.value))
    : 'Unknown';
  const confidence = opportunity.score.confidence;
  const sample = validIntegerString(confidence.sampleSize) ? formatInteger(confidence.sampleSize) : 'Unknown';
  const denominator = confidence.denominator === null ? 'Unknown' : validIntegerString(confidence.denominator) ? formatInteger(confidence.denominator) : 'Unknown';
  return `<article id="${stateClass(id)}" class="card opportunity-card"><div class="section-heading"><h3>${safeText(title)}</h3>${renderBadge(opportunity.disposition, safeText(opportunity.disposition))}</div><p>${safeText(opportunity.chain.name)}; contract ${safeIdentifier(opportunity.project.contract)}</p><div class="metric-grid"><div class="metric"><span class="metric-label">Desirability score</span><strong>${scoreValue}</strong><span class="metric-meta">Score is not permission; ${renderFreshness(opportunity.score.freshness)}</span></div>${renderAmount(opportunity.price, 'Mint price')}</div><div class="card"><h4>Score evidence</h4><p>Confidence: ${safeText(confidence.label)}; sample ${sample}; denominator ${denominator}; model ${safeText(opportunity.score.modelVersion)}</p>${opportunity.score.factors.length > 0 ? `<ul class="evidence-list">${opportunity.score.factors.map((factor) => `<li><strong>${safeText(factor.code)}</strong>: ${Number.isFinite(factor.contribution) ? escapeHtml(String(factor.contribution)) : 'Unknown'}<p>${safeText(factor.explanation)}</p>${renderFreshness(factor.freshness)}</li>`).join('')}</ul>` : emptyState('No score factors were supplied.')}</div><div class="card"><h4>Evidence</h4>${renderEvidenceRows(opportunity.evidence)}</div>${renderRiskFlags(opportunity)}${renderGate(opportunity.gate, 'Safety gate', stateClass(id))}<div class="card-footer">${inspectLink(id)}<span class="next-action">Primary action: Inspect; no spending action is available in this view.</span></div>${renderProvenance(opportunity.provenance)}</article>`;
}

function renderRiskFlags(opportunity: OpportunityReadModel): string {
  if (opportunity.risks.length === 0) return `<section class="card"><h4>Risks</h4>${emptyState('No risk flags were supplied.')}</section>`;
  return `<section class="card"><h4>Risks</h4><ul class="risk-list">${opportunity.risks.map((risk) => `<li>${renderBadge(risk.severity, risk.severity)} <strong>${safeText(risk.code)}</strong><p>${safeText(risk.message)}</p>${renderFreshness(risk.freshness)}</li>`).join('')}</ul></section>`;
}

function renderEvidenceRows(rows: OpportunityReadModel['evidence']): string {
  if (rows.length === 0) return emptyState('No evidence rows were supplied.');
  return `<ul class="evidence-list">${rows.map((row) => `<li><strong>${safeText(row.label)}</strong><p>${safeText(row.summary)}</p>${renderFreshness(row.freshness)}${renderProvenance(row.provenance)}</li>`).join('')}</ul>`;
}

function renderCalendarEntry(entry: CalendarEntry, idPrefix = ''): string {
  const title = entry.project.name ?? 'Upcoming mint';
  const id = `${idPrefix}calendar-${entry.id}`;
  const eligibility = entry.eligibility;
  const opening = { value: entry.openingAt, freshness: entry.freshness, provenance: entry.provenance };
  const closing = { value: entry.closingAt, freshness: entry.freshness, provenance: entry.provenance };
  return `<article id="${stateClass(id)}" class="calendar-card"><div class="section-heading"><h3>${safeText(title)}</h3>${renderBadge(entry.verification.decision, entry.verification.decision === 'permitted' ? 'Recorded checks pass' : entry.verification.decision === 'blocked' ? 'Blocked' : 'Unknown')}</div><p>${safeText(entry.chain.name)}; source authority ${safeText(entry.sourceAuthority.replaceAll('_', ' '))}; method ${safeText(entry.method)}</p><div class="metric-grid">${renderSourcedTime(opening, 'Opens')}${renderSourcedTime(closing, 'Closes')}${renderAmount(entry.price, 'Mint price')}${renderQuantity(entry.expectedGas, 'Expected gas')}</div><div class="metric-grid">${renderQuantity(entry.supply, 'Supply')}${renderQuantity(entry.perWalletLimit, 'Per-wallet limit')}<div class="metric"><span class="metric-label">Access</span><strong>${safeText(entry.publicStatus)}</strong></div></div><div class="card"><h4>Wallet summary</h4><p>Total ${formatInteger(eligibility.total)}; ineligible ${formatInteger(eligibility.ineligible)}; unknown ${formatInteger(eligibility.unknown)}; ready ${formatInteger(eligibility.ready)}; stale ${formatInteger(eligibility.stale)}.</p><p class="next-action">A source time is not an on-chain guarantee. Stale entries cannot claim readiness.</p></div>${renderGate(entry.verification, 'Calendar verification', `${stateClass(id)}-verification`)}<div class="card-footer">${inspectLink(id)}<span class="next-action">Primary action: Inspect.</span></div>${renderFreshness(entry.freshness)}${renderProvenance(entry.provenance)}</article>`;
}

function renderAlert(alert: AlertReadModel, idPrefix = ''): string {
  const id = `${idPrefix}alert-${alert.id}`;
  return `<article id="${stateClass(id)}" class="alert-card"><div class="section-heading"><h3>${safeText(alert.type)}</h3>${renderBadge(alert.state, safeText(alert.state))}</div><p>${safeText(alert.text)}</p><p class="metric-meta">Created ${formatTime(alert.createdAt)}; delivered ${formatTime(alert.deliveredAt)}; attempts ${formatInteger(alert.attempts)}.</p><p class="metric-meta">Source event ${safeIdentifier(alert.sourceEventId)}; run ${safeIdentifier(alert.runId)}.</p><p class="next-action">Alert delivery is not proof that a mint settled.</p>${renderFreshness(alert.freshness)}${renderProvenance(alert.provenance)}</article>`;
}

function renderSourcedTime(time: { value: string | null; freshness: CalendarEntry['freshness']; provenance: CalendarEntry['provenance'] }, label: string): string {
  return `<div class="metric"><span class="metric-label">${safeText(label)}</span><strong>${formatTime(time.value)}</strong><span class="metric-meta">${renderFreshness(time.freshness)}</span></div>`;
}

function renderQuantity(quantity: { value: string | null; freshness: CalendarEntry['freshness'] }, label: string): string {
  return `<div class="metric"><span class="metric-label">${safeText(label)}</span><strong>${formatInteger(quantity.value)}</strong><span class="metric-meta">${renderFreshness(quantity.freshness)}</span></div>`;
}

function renderHealthModel(health: SystemHealth, idPrefix: string): string {
  const state = health.state === 'Ready' || health.state === 'Not ready' || health.state === 'Killed' ? health.state : 'Unknown';
  const killSwitch = health.killSwitch === 'clear' || health.killSwitch === 'engaged' ? health.killSwitch : 'unknown';
  const dependencies: Array<[string, string]> = [
    ['Engine', health.dependencies.engine],
    ['Chain', health.dependencies.chain],
    ['Backup', health.dependencies.backup],
    ['Notifications', health.dependencies.notifications],
    ['Reconciliation', health.dependencies.reconciliation],
  ];
  return `<section id="${stateClass(idPrefix)}" class="card health-card" aria-labelledby="${stateClass(idPrefix)}-heading"><div class="section-heading"><h3 id="${stateClass(idPrefix)}-heading">Operational status</h3>${renderBadge(state, state)}</div><p>Backend reports whether read data can be relied on. This view never exposes protected configuration values.</p><div class="metric-grid"><div class="metric"><span class="metric-label">Kill switch</span><strong>${safeText(killSwitch)}</strong></div><div class="metric"><span class="metric-label">Checked at</span><strong>${formatTime(health.checkedAt)}</strong></div></div><div class="surface-grid">${dependencies.map(([label, value]) => `<div class="metric-card"><span class="metric-label">${safeText(label)}</span>${renderBadge(value, safeText(value))}</div>`).join('')}</div>${health.blockers.length > 0 ? renderIssues(health.blockers, `${stateClass(idPrefix)}-blockers`) : emptyState('No operational blockers were supplied.')}${renderFreshness(health.freshness)}</section>`;
}

function renderReadinessRow(row: ReadinessRow): string {
  const decision = row.decision === 'ready' ? 'Ready' : row.decision === 'blocked' ? 'Blocked' : row.decision === 'stale' ? 'Stale' : 'Unknown';
  const state = row.state === 'Ready' || row.state === 'Executing' || row.state === 'Minted' || row.state === 'Failed' || row.state === 'Skipped' || row.state === 'Eligible' || row.state === 'Funded' || row.state === 'Unfunded' ? row.state : 'Unknown';
  const blockerText = row.blockers.length > 0 ? row.blockers.map((issue) => safeText(issue.message)).join('; ') : 'None supplied';
  const failedSimulation = row.checks.some((check) => check.code === 'simulated' && check.outcome === 'fail');
  const note = failedSimulation ? 'Simulation failed; this wallet is blocked. Inspect the reason or use a future Backend validation flow.' : decision === 'Ready' ? 'Recorded checks pass; this is not a guaranteed mint.' : 'Resolve the recorded blocker before relying on readiness.';
  return `<tr tabindex="0"><td data-label="Wallet"><strong>${safeText(row.wallet.label ?? 'Wallet')}</strong><br><code>${safeIdentifier(row.wallet.address)}</code></td><td data-label="Decision">${renderBadge(decision, decision)}<br>${renderBadge(state, state)}</td><td data-label="Checks"><ul class="check-list">${row.checks.length > 0 ? row.checks.map((check) => `<li>${renderBadge(check.outcome, check.outcome)} ${safeText(check.code)}</li>`).join('') : '<li>Unknown</li>'}</ul></td><td data-label="Cost"><div class="metric-grid">${renderAmount(row.cost.mintValue, 'Mint')}${renderAmount(row.cost.executionGas, 'Execution gas')}${renderAmount(row.cost.dataPostingGas, 'Data posting gas')}${renderAmount(row.cost.priorityFeeComponent, 'Priority fee')}${renderAmount(row.cost.estimatedTotal, 'Estimated total')}${renderAmount(row.cost.balance, 'Balance')}</div></td><td data-label="Blocker"><p>${safeText(blockerText)}</p><p class="next-action">${safeText(note)}</p><p>Next safe action: ${safeAction(row.nextAction)}</p>${renderFreshness(row.freshness)}</td></tr>`;
}

function finalityStage(finality: Finality): Finality['stage'] {
  switch (finality.stage) {
    case 'unknown':
    case 'confirmed':
    case 'soft':
    case 'posted':
    case 'ethereum_final':
      return finality.stage;
    default:
      return 'unknown';
  }
}

function finalityLabel(stage: Finality['stage']): string {
  switch (stage) {
    case 'confirmed': return 'Confirmed';
    case 'soft': return 'Included';
    case 'posted': return 'Posted to Ethereum';
    case 'ethereum_final': return 'Ethereum final';
    default: return 'Unknown';
  }
}

export function renderFinality(finality: Finality | null | undefined): string {
  if (!finality) return renderBadge('unknown', 'Unknown');
  const stage = finalityStage(finality);
  const label = finalityLabel(stage);
  // Stage, requiredStage, and settlementReached are Backend facts. This guard
  // only prevents a malformed snapshot from rendering a premature success.
  const settlementAllowed = stage === 'ethereum_final' || (stage === 'confirmed' && finality.requiredStage === 'confirmed');
  const settled = settlementAllowed && finality.settlementReached === true;
  const waiting = stage === 'soft' || stage === 'posted';
  const explanation = waiting ? 'Waiting for Ethereum finality.' : settled ? 'Required settlement stage reached.' : 'Not settled; keep this record under Backend reconciliation.';
  return `<div class="finality"><div>${renderBadge(stage, label)}</div><p>${safeText(explanation)}</p>${finality.downgradeReason ? `<p class="next-action">Downgraded: ${safeText(finality.downgradeReason)}</p>` : ''}${renderFreshness(finality.freshness)}</div>`;
}

function renderWalletResult(result: WalletExecutionResult): string {
  const state = result.state || 'Unknown';
  const retry = result.retry.allowed ? 'Backend marked a specific retry policy.' : 'No safe retry is supplied.';
  return `<tr tabindex="0"><td data-label="Wallet"><code>${safeIdentifier(result.address)}</code></td><td data-label="State">${renderBadge(state, safeText(state))}</td><td data-label="Finality">${renderFinality(result.finality)}</td><td data-label="Reason">${result.reason ? `${safeText(result.reason.label)} - ${safeText(result.reason.message)}` : 'None supplied'}</td><td data-label="Retry">${safeText(retry)}<br>Next safe action: ${safeAction(result.retry.safeAction)}</td></tr>`;
}

function renderAttempt(attempt: TransactionAttempt): string {
  const state = attempt.state || 'Unknown';
  return `<li class="card"><div class="section-heading"><h4>Attempt ${formatInteger(attempt.attemptNumber)}</h4>${renderBadge(state, safeText(state))}</div><p>Wallet ${safeIdentifier(attempt.walletId)}; hash ${safeIdentifier(attempt.hash)}; nonce ${safeIdentifier(attempt.nonce)}.</p>${renderFinality(attempt.finality)}<p>Replacement of ${safeIdentifier(attempt.replacementOfId)}; next safe action ${safeAction(attempt.retry.safeAction)}.</p>${attempt.reason ? renderIssues([attempt.reason], `attempt-${stateClass(attempt.id)}-issues`) : ''}${renderProvenance(attempt.provenance)}</li>`;
}

function renderReceipt(receipt: TransactionReceipt): string {
  const status = receipt.status === 'pending' || receipt.status === 'confirmed' || receipt.status === 'reverted' || receipt.status === 'reorged' || receipt.status === 'dropped' ? receipt.status : 'unknown';
  return `<li class="card"><div class="section-heading"><h4>Receipt ${safeIdentifier(receipt.id)}</h4>${renderBadge(status, status === 'reorged' ? 'Reorged' : safeText(status))}</div><p>Hash ${safeIdentifier(receipt.hash)}; block ${safeIdentifier(receipt.blockNumber)}; block hash ${safeIdentifier(receipt.blockHash)}.</p><div class="metric-grid">${renderAmount(receipt.effectiveGasPrice, 'Effective gas price')}${renderAmount(receipt.actualSpend, 'Actual spend')}<div class="metric"><span class="metric-label">Gas used</span><strong>${formatQuantity(receipt.gasUsed)}</strong></div></div>${renderFinality(receipt.finality)}${renderProvenance(receipt.provenance)}</li>`;
}

function renderReconciliation(state: RunReadModel): string {
  if (state.reconciliations.length === 0) return emptyState('No reconciliation observations were supplied.');
  return `<ul class="timeline">${state.reconciliations.map((item) => `<li><span>${renderBadge(item.state, item.state)}<br>${formatTime(item.observedAt)}</span><span>${safeText(item.reason)}<br>Next safe action: ${safeAction(item.retry.safeAction)}${renderProvenance(item.provenance)}</span></li>`).join('')}</ul>`;
}

function renderTimeline(events: TimelineEvent[]): string {
  if (events.length === 0) return emptyState('No timeline events were supplied.');
  return `<ol class="timeline">${events.map((event) => `<li><span>${formatTime(event.occurredAt)}<br>${renderBadge(event.state ?? 'unknown', safeText(event.state ?? 'Unknown'))}</span><span><strong>${safeText(event.type)}</strong><br>${safeText(event.message)}</span></li>`).join('')}</ol>`;
}

export function renderHome(envelope: ReadModelEnvelope<HomeReadModel>): string {
  return surface('home', 'Intelligence home', 'A consumer-friendly view of attention, opportunities, readiness, reminders, and operational status. Every value comes from the Backend projection.', envelope, (data) => `<section class="card"><h3>What needs my attention?</h3>${data.attention.length > 0 ? `<div class="attention-list">${data.attention.map(renderAttention).join('')}</div>` : emptyState('No attention items were recorded.')}</section><section class="card"><div class="section-heading"><h3>Which wallets are ready?</h3>${renderFreshness(data.readinessSummary.freshness)}</div>${renderCounts(data.readinessSummary, 'home-readiness')}</section><section class="card"><div class="section-heading"><h3>Opportunities worth checking</h3><span class="metric-meta">Score and safety gate are separate.</span></div>${data.opportunities.length > 0 ? `<div class="surface-grid">${data.opportunities.map((item) => renderOpportunity(item, 'home-')).join('')}</div>` : emptyState('No opportunity records were supplied.')}</section><section class="card"><h3>Upcoming mints</h3>${data.calendarHighlights.length > 0 ? `<div class="surface-grid">${data.calendarHighlights.map((item) => renderCalendarEntry(item, 'home-')).join('')}</div>` : emptyState('No verified calendar records were supplied.')}</section><section class="card"><h3>Reminders and alerts</h3>${data.alerts.length > 0 ? `<div class="surface-grid">${data.alerts.map((item) => renderAlert(item, 'home-')).join('')}</div>` : emptyState('No persisted reminders were supplied.')}</section>${renderHealthModel(data.system, 'home-health')}`);
}

export function renderReadiness(envelope: ReadModelEnvelope<ReadinessReadModel>): string {
  return surface('readiness', 'Wallet readiness', 'Readiness is tied to one campaign and one wallet. Unknown, stale, and blocked checks are never presented as ready. Totals are not inferred in the browser.', envelope, (data) => `<section class="card"><p>${data.length === 1 ? 'One wallet row' : `${data.length} wallet rows`} were returned by the Backend projection. Home readiness counts remain the authoritative summary.</p></section><section class="table-wrap"><table class="responsive-table readiness-table"><caption>Wallet-by-campaign readiness matrix</caption><thead><tr><th scope="col">Wallet</th><th scope="col">Decision</th><th scope="col">Checks</th><th scope="col">Cost and balance</th><th scope="col">Blocker and next step</th></tr></thead><tbody>${data.length > 0 ? data.map(renderReadinessRow).join('') : '<tr><td colspan="5">No wallet readiness rows were supplied.</td></tr>'}</tbody></table></section>`);
}

export function renderCalendar(envelope: ReadModelEnvelope<CalendarReadModel>): string {
  return surface('calendar', 'Mint calendar', 'Upcoming records include source authority, verification time, and server-provided freshness. A calendar time is not a guarantee.', envelope, (data) => data.length > 0 ? `<div class="surface-grid">${data.map((entry) => renderCalendarEntry(entry)).join('')}</div>` : emptyState('No calendar records were supplied.'));
}

export function renderAlerts(envelope: ReadModelEnvelope<AlertsReadModel>): string {
  return surface('alerts', 'Reminders and alerts', 'Persisted Backend notifications help with attention and timing. Delivery never proves that a transaction settled.', envelope, (data) => data.length > 0 ? `<div class="surface-grid">${data.map((alert) => renderAlert(alert)).join('')}</div>` : emptyState('No alert records were supplied.'));
}

export function renderHealth(envelope: ReadModelEnvelope<SystemHealth>): string {
  return surface('health', 'Operational status', 'A redacted health projection explains whether read data is available without exposing protected configuration.', envelope, (data) => renderHealthModel(data, 'health-detail'));
}

export function renderRun(envelope: ReadModelEnvelope<RunReadModel>): string {
  return surface('run', 'Run status', 'Run records preserve dry-run, partial, unknown, reorg, and staged finality outcomes. This view is read-only.', envelope, (data) => {
    const outcome = data.run.outcome === 'dry_run_completed' ? 'Dry run completed' : data.run.outcome === 'not_started' ? 'Not started' : data.run.outcome === 'partial' ? 'Partial' : data.run.outcome === 'settled' ? 'Settled' : 'Unknown';
    const mode = data.run.mode === 'dry-run' ? 'Dry run' : data.run.mode === 'live' ? 'Live' : 'Unknown';
    return `<section class="card"><div class="section-heading"><h3>Run ${safeIdentifier(data.run.id)}</h3>${renderBadge(outcome, outcome)}</div><p>Mode: ${renderBadge(mode, mode)}; campaign ${safeIdentifier(data.run.campaignId)}; state ${renderBadge(data.run.state, data.run.state)}.</p><p>${mode === 'Dry run' ? 'No transaction is claimed from this preparation record.' : 'Live records remain subject to Backend reconciliation and finality.'}</p></section><section class="card"><h3>Wallet outcomes</h3>${data.walletResults.length > 0 ? `<div class="table-wrap"><table class="responsive-table"><caption>Per-wallet results</caption><thead><tr><th scope="col">Wallet</th><th scope="col">State</th><th scope="col">Finality</th><th scope="col">Reason</th><th scope="col">Retry policy</th></tr></thead><tbody>${data.walletResults.map(renderWalletResult).join('')}</tbody></table></div>` : emptyState('No wallet outcomes were supplied.')}</section><section class="card"><h3>Attempts</h3>${data.attempts.length > 0 ? `<ul class="attention-list">${data.attempts.map(renderAttempt).join('')}</ul>` : emptyState('No transaction attempt records were supplied.')}</section><section class="card"><h3>Receipts and finality</h3>${data.receipts.length > 0 ? `<ul class="attention-list">${data.receipts.map(renderReceipt).join('')}</ul>` : emptyState('No receipt records were supplied.')}</section><section class="card"><h3>Reconciliation</h3>${renderReconciliation(data)}</section><section class="timeline-section"><h3>Timeline</h3>${renderTimeline(data.events)}</section>`;
  });
}
