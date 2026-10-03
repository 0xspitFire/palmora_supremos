import { createHash } from 'node:crypto';
import type { BackendStore } from './store.js';
import type { MetricsRegistry } from './observability.js';
import type { NotificationDispatcher } from './notifications.js';
import type { AlertCard } from './alert-card.js';
import { plainSystemText, type SystemCard } from './system-card.js';
import { killEngagedCard, runProblemCard, spendCapCard } from './system-messages.js';

export type AlertKind = 'started' | 'kill' | 'cap' | 'blocked' | 'failed' | 'reminder';
export type AlertPriority = 'immediate' | 'grouped';
/** Phase 2 intelligence alerts (T-004, P2-06). Outbound only; never a permission or execution proof. */
export type IntelligenceAlertKind = 'opportunity' | 'opening_soon' | 'eligible_ready' | 'underfunded' | 'price_above_limit' | 'status' | 'quantity_reduced' | 'health';
export interface IntelligenceAlertInput {
  kind: IntelligenceAlertKind;
  /** Stable dedupe identity: the same identity is never alerted twice. */
  dedupe: string;
  /** Plain-language message for the owner. */
  text: string;
  /** Immediate alerts send now; grouped ones wait for the next digest. */
  priority: AlertPriority;
  /** Structured form for the Telegram sender (T-029); `text` stays as the plain fallback. */
  card?: AlertCard;
  /** Structured form of a system message (start, check-in, health); `text` stays as the plain fallback. */
  system?: SystemCard;
  at?: string;
}
export interface AlertInput { kind: AlertKind; runId?: string; reason?: string; walletCount?: number; at?: string; }
export interface AlertPolicy { retentionDays: number; immediateKinds: readonly AlertKind[]; groupedKinds: readonly AlertKind[]; }
export const DEFAULT_ALERT_POLICY: AlertPolicy = { retentionDays: 30, immediateKinds: ['kill', 'cap', 'blocked', 'failed'], groupedKinds: ['started', 'reminder'] };
export interface OperationalAlert { key: string; severity: 'warning' | 'critical'; reason: string; message: string; at: string; }

export interface OperationalSnapshot {
  processAlive: boolean;
  reconciliationAgeSeconds?: number;
  unresolvedSubmissions: number;
  endpointErrorRatio?: number;
  diskFreeBytes?: number;
  diskFreeRatio?: number;
  backupAgeSeconds?: number;
  backupFailed?: boolean;
  killSwitchEngaged: boolean;
  capHit: boolean;
  notificationConnected: boolean;
}
export interface AlertThresholds { reconciliationMaxAgeSeconds: number; endpointErrorRatio: number; diskFreeBytes: number; diskFreeRatio: number; backupMaxAgeSeconds: number; cooldownMs: number; }
export const DEFAULT_ALERT_THRESHOLDS: AlertThresholds = { reconciliationMaxAgeSeconds: 300, endpointErrorRatio: 0.25, diskFreeBytes: 512 * 1024 * 1024, diskFreeRatio: 0.1, backupMaxAgeSeconds: 36 * 60 * 60, cooldownMs: 15 * 60 * 1_000 };

export function evaluateOperationalAlerts(snapshot: OperationalSnapshot, thresholds: AlertThresholds = DEFAULT_ALERT_THRESHOLDS, now = new Date()): OperationalAlert[] {
  const alerts: OperationalAlert[] = [];
  const add = (key: string, severity: OperationalAlert['severity'], reason: string, message: string): void => { alerts.push({ key, severity, reason, message, at: now.toISOString() }); };
  if (!snapshot.processAlive) add('process_down', 'critical', 'PROCESS_DOWN', 'Orchestrator process is not alive; no new work is admitted.');
  if (snapshot.unresolvedSubmissions > 0 || (snapshot.reconciliationAgeSeconds ?? Number.POSITIVE_INFINITY) > thresholds.reconciliationMaxAgeSeconds) add('reconciliation_stale', 'critical', 'RECONCILIATION_STALE', 'Reconciliation is stale or unresolved; keep admission blocked.');
  if ((snapshot.endpointErrorRatio ?? 0) >= thresholds.endpointErrorRatio) add('endpoint_degraded', 'warning', 'ENDPOINT_ERROR_RATE_HIGH', 'RPC endpoint errors exceed the configured threshold.');
  if ((snapshot.diskFreeBytes ?? Number.POSITIVE_INFINITY) < thresholds.diskFreeBytes || (snapshot.diskFreeRatio ?? 1) < thresholds.diskFreeRatio) add('disk_pressure', 'critical', 'DISK_PRESSURE', 'Persistent state or logs are low on disk space.');
  if (snapshot.backupFailed || (snapshot.backupAgeSeconds ?? Number.POSITIVE_INFINITY) > thresholds.backupMaxAgeSeconds) add('backup_stale', 'critical', 'BACKUP_STALE_OR_FAILED', 'The latest encrypted backup is stale or failed.');
  if (snapshot.killSwitchEngaged) add('kill_switch', 'critical', 'KILL_SWITCH_ENGAGED', 'Kill switch is engaged; submitted work still requires reconciliation.');
  if (snapshot.capHit) add('spend_cap', 'critical', 'SPEND_CAP_REACHED', 'A durable spend cap blocked or stopped admission.');
  if (!snapshot.notificationConnected) add('notification_disconnect', 'warning', 'NOTIFICATION_DISCONNECTED', 'One-way notification delivery is unavailable.');
  return alerts;
}

function systemFor(input: AlertInput, at: string): SystemCard | undefined {
  try {
    if (input.kind === 'kill') return killEngagedCard({ ...(input.reason ? { reason: input.reason } : {}), ...(input.runId ? { runId: input.runId } : {}), at });
    if (input.kind === 'cap') return spendCapCard({ ...(input.reason ? { notice: input.reason } : {}), ...(input.runId ? { runId: input.runId } : {}), at });
    if (input.kind === 'blocked' || input.kind === 'failed') return runProblemCard(input.kind, { ...(input.reason ? { reason: input.reason } : {}), ...(input.runId ? { runId: input.runId } : {}), at });
  } catch { /* presentation only: the alert still goes out as plain text */ }
  return undefined;
}

function alertType(kind: AlertKind): string { return `alert_${kind}`; }
function alertText(input: AlertInput): string {
  const suffix = input.reason ? `: ${input.reason}` : '';
  if (input.kind === 'started') return `run started${input.runId ? `: ${input.runId}` : ''}${input.walletCount === undefined ? '' : ` (${input.walletCount} wallets)`}`;
  return `${input.kind}${input.runId ? `: ${input.runId}` : ''}${suffix}`;
}

/** Durable alert/reminder coordinator. It never changes execution truth. */
export class AlertManager {
  private readonly grouped = new Set<string>();
  private readonly now: () => Date;
  private readonly policy: AlertPolicy;
  public constructor(private readonly store: BackendStore, private readonly dispatcher?: NotificationDispatcher, private readonly metrics?: MetricsRegistry, options: { policy?: Partial<AlertPolicy>; now?: () => Date; retentionDays?: number } = {}) {
    this.now = options.now ?? (() => new Date());
    this.policy = { ...DEFAULT_ALERT_POLICY, ...options.policy, ...(options.retentionDays === undefined ? {} : { retentionDays: options.retentionDays }) };
    if (!Number.isSafeInteger(this.policy.retentionDays) || this.policy.retentionDays <= 0) throw new Error('ALERT_RETENTION_INVALID');
  }

  public async started(runId: string, walletCount: number): Promise<void> { await this.emit({ kind: 'started', runId, walletCount }); }
  public async kill(reason: string, runId?: string): Promise<void> { await this.emit({ kind: 'kill', runId, reason }); }
  public async cap(reason: string, runId?: string): Promise<void> { await this.emit({ kind: 'cap', runId, reason }); }
  public async blocked(reason: string, runId?: string): Promise<void> { await this.emit({ kind: 'blocked', runId, reason }); }
  public async failed(reason: string, runId?: string): Promise<void> { await this.emit({ kind: 'failed', runId, reason }); }

  /** Records an intelligence alert once per dedupe identity; immediate ones are dispatched now, grouped ones join the next digest. */
  public async intelligence(input: IntelligenceAlertInput): Promise<boolean> {
    const type = `alert_${input.kind}`;
    if (this.store.snapshot().events.some((event) => event.type === type && event.data.dedupe === input.dedupe)) return false;
    const at = input.at ?? this.now().toISOString();
    const retentionUntil = new Date(Date.parse(at) + this.policy.retentionDays * 86_400_000).toISOString();
    const eventId = `alert_${input.kind}_${shortDigest(input.dedupe)}`;
    await this.store.transaction((current) => { current.events.push({ id: eventId, type, at, data: { dedupe: input.dedupe, text: input.text, priority: input.priority, retentionUntil, ...(input.card ? { card: input.card } : {}), ...(input.system ? { system: input.system } : {}) } }); });
    this.metrics?.recordNotification('pending');
    if (input.priority === 'immediate' && this.dispatcher) await this.dispatcher.dispatch(eventId, input.text);
    return true;
  }

  /**
   * Sends one digest of grouped intelligence alerts not yet covered by a digest.
   * Restart-safe: pending alerts and undelivered digests are found from durable events and the outbox.
   */
  public async flushDigest(): Promise<number> {
    const state = this.store.snapshot();
    const digests = state.events.filter((event) => event.type === 'alert_digest');
    const covered = new Set(digests.flatMap((event) => Array.isArray(event.data.includes) ? event.data.includes.map(String) : []));
    const sent = new Set(state.notificationOutbox.map((item) => item.sourceEventId));
    if (this.dispatcher) for (const event of digests.filter((item) => !sent.has(item.id))) await this.dispatcher.dispatch(event.id, String(event.data.text ?? ''));
    const pending = state.events.filter((event) => event.type.startsWith('alert_') && event.type !== 'alert_digest' && event.data.priority === 'grouped' && !covered.has(event.id)).sort((left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id));
    if (pending.length === 0) return 0;
    const ids = pending.map((event) => event.id);
    const text = [`MintBot reminders (${pending.length}):`, ...pending.map((event) => `• ${String(event.data.text ?? '')}`)].join('\n');
    const digestId = `alert_digest_${shortDigest(ids.join(','))}`;
    // Items keep each alert's card for the sender; the list is capped, while `includes` and `text` still cover every alert.
    const items = pending.slice(0, 30).map((event) => ({ text: String(event.data.text ?? ''), ...(event.data.card ? { card: event.data.card } : {}) }));
    await this.store.transaction((current) => { if (!current.events.some((event) => event.id === digestId)) current.events.push({ id: digestId, type: 'alert_digest', at: this.now().toISOString(), data: { includes: ids, text, items } }); });
    if (this.dispatcher) await this.dispatcher.dispatch(digestId, text);
    return pending.length;
  }

  /**
   * Retries undelivered messages (pending or failed) created within `maxAgeMs`, respecting the
   * outbox backoff and lease. Older ones stay failed: stale news is not resent. Returns attempts made.
   */
  public async retryUndelivered(maxAgeMs = 6 * 60 * 60_000): Promise<number> {
    if (!this.dispatcher) return 0;
    const now = this.now().getTime();
    const due = this.store.snapshot().notificationOutbox.filter((item) => item.state !== 'delivered' && now - Date.parse(item.createdAt) <= maxAgeMs && (!item.nextAttemptAt || Date.parse(item.nextAttemptAt) <= now));
    let attempts = 0;
    for (const item of due) {
      attempts += 1;
      try { await this.dispatcher.dispatch(item.sourceEventId, item.text); } catch { /* stays failed with a later nextAttemptAt; retried on a later tick */ }
    }
    return attempts;
  }

  public async flush(): Promise<void> {
    for (const eventId of this.grouped) {
      const event = this.store.snapshot().events.find((candidate) => candidate.id === eventId);
      if (!event || !this.dispatcher) continue;
      try { await this.dispatcher.dispatch(event.id, String(event.data.text ?? '')); } finally { this.grouped.delete(eventId); }
    }
  }

  private async emit(input: AlertInput): Promise<void> {
    const type = alertType(input.kind);
    const state = this.store.snapshot();
    const duplicate = state.events.some((event) => event.type === type && event.runId === input.runId && (input.kind === 'started' || event.data.reason === input.reason));
    if (duplicate) return;
    const at = input.at ?? this.now().toISOString();
    // Kill, cap, blocked and failed alerts carry a structured message for Telegram; the plain text stays as the fallback.
    const system = systemFor(input, at);
    const text = system ? plainSystemText(system) : alertText(input);
    const retentionUntil = new Date(Date.parse(at) + this.policy.retentionDays * 86_400_000).toISOString();
    const eventId = `alert_${type}_${input.runId ?? 'global'}_${Date.parse(at)}`;
    await this.store.transaction((current) => { current.events.push({ id: eventId, ...(input.runId ? { runId: input.runId } : {}), type, at, data: { ...input, text, retentionUntil, ...(system ? { system } : {}) } }); });
    this.metrics?.recordNotification('pending');
    const priority: AlertPriority = this.policy.immediateKinds.includes(input.kind) ? 'immediate' : 'grouped';
    if (priority === 'grouped') this.grouped.add(eventId);
    else if (this.dispatcher) await this.dispatcher.dispatch(eventId, text);
  }
}

function shortDigest(value: string): string { return createHash('sha256').update(value).digest('hex').slice(0, 24); }
