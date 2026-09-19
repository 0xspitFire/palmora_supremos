import type { BackendStore } from './store.js';
import type { MetricsRegistry } from './observability.js';
import type { NotificationDispatcher } from './notifications.js';

export type AlertKind = 'started' | 'kill' | 'cap' | 'blocked' | 'failed' | 'reminder';
export type AlertPriority = 'immediate' | 'grouped';
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
    const text = alertText(input);
    const retentionUntil = new Date(Date.parse(at) + this.policy.retentionDays * 86_400_000).toISOString();
    const eventId = `alert_${type}_${input.runId ?? 'global'}_${Date.parse(at)}`;
    await this.store.transaction((current) => { current.events.push({ id: eventId, ...(input.runId ? { runId: input.runId } : {}), type, at, data: { ...input, text, retentionUntil } }); });
    this.metrics?.recordNotification('pending');
    const priority: AlertPriority = this.policy.immediateKinds.includes(input.kind) ? 'immediate' : 'grouped';
    if (priority === 'grouped') this.grouped.add(eventId);
    else if (this.dispatcher) await this.dispatcher.dispatch(eventId, text);
  }
}
