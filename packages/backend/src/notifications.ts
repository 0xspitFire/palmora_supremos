import type { BackendStore } from './store.js';
import { redactError, redactText, MetricsRegistry } from './observability.js';
export interface NotificationSink { send(message: { eventId: string; runId?: string; type: string; text: string }): Promise<void>; }
export interface NotificationDispatcherOptions { metrics?: MetricsRegistry; now?: () => Date; retentionDays?: number; leaseMs?: number; retryBaseMs?: number; retryMaxMs?: number; }
export class NotificationDispatcher {
  constructor(private readonly store: BackendStore, private readonly sink: NotificationSink, private readonly options: NotificationDispatcherOptions = {}) {}
  async dispatch(sourceEventId: string, text: string): Promise<void> {
    const safeText = redactText(text);
    const now = this.options.now ?? (() => new Date());
    const retentionDays = this.options.retentionDays ?? 30;
    const leaseMs = this.options.leaseMs ?? 30_000;
    const retryBaseMs = this.options.retryBaseMs ?? 1_000;
    const retryMaxMs = this.options.retryMaxMs ?? 300_000;
    if (!Number.isSafeInteger(retentionDays) || retentionDays <= 0) throw new Error('NOTIFICATION_RETENTION_INVALID');
    if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0 || !Number.isSafeInteger(retryBaseMs) || retryBaseMs <= 0 || !Number.isSafeInteger(retryMaxMs) || retryMaxMs < retryBaseMs) throw new Error('NOTIFICATION_RETRY_POLICY_INVALID');
    const startedAt = now();
    const item = await this.store.transaction(state => {
      const existing = state.notificationOutbox.find(entry => entry.sourceEventId === sourceEventId);
      if (existing?.state === 'delivered') return undefined;
      if (existing?.deliveryLeaseUntil && Date.parse(existing.deliveryLeaseUntil) > startedAt.getTime()) return undefined;
      if (existing?.nextAttemptAt && Date.parse(existing.nextAttemptAt) > startedAt.getTime()) return undefined;
      const source = state.events.find(event => event.id === sourceEventId); if (!source) throw new Error('NOTIFICATION_SOURCE_EVENT_NOT_FOUND');
      const createdAt = startedAt.toISOString();
      const retentionUntil = new Date(Date.parse(createdAt) + retentionDays * 86_400_000).toISOString();
      const outbox = existing ?? { id: `notify_${source.id}`, sourceEventId: source.id, ...(source.runId ? { runId: source.runId } : {}), type: source.type, text: safeText, state: 'pending' as const, attempts: 0, createdAt, retentionUntil };
      if (!existing) state.notificationOutbox.push(outbox);
      // A process can die after persisting `delivering`; a subsequent boot is
      // allowed to retry that item instead of treating it as delivered.
      outbox.state = 'delivering'; outbox.attempts += 1; outbox.deliveryLeaseUntil = new Date(startedAt.getTime() + leaseMs).toISOString(); outbox.nextAttemptAt = undefined; return structuredClone(outbox);
    });
    if (!item) return;
    this.options.metrics?.recordNotification('delivering');
    try { await this.sink.send({ eventId: item.id, ...(item.runId ? { runId: item.runId } : {}), type: item.type, text: item.text }); }
    catch (error) {
      const safeError = redactError(error).message;
      await this.store.transaction(state => {
        const failed = state.notificationOutbox.find(entry => entry.id === item.id);
        if (failed?.state === 'delivering') {
          failed.state = 'pending';
          failed.deliveryLeaseUntil = undefined;
          failed.lastError = safeError;
          failed.nextAttemptAt = new Date(startedAt.getTime() + Math.min(retryMaxMs, retryBaseMs * (2 ** Math.max(0, failed.attempts - 1)))).toISOString();
        }
      });
      this.options.metrics?.recordNotification('failed');
      throw new Error(safeError);
    }
    await this.store.transaction(state => { const delivered = state.notificationOutbox.find(entry => entry.id === item.id); if (!delivered) throw new Error('NOTIFICATION_OUTBOX_NOT_FOUND'); delivered.state = 'delivered'; delivered.deliveredAt = now().toISOString(); delivered.deliveryLeaseUntil = undefined; delivered.nextAttemptAt = undefined; delivered.lastError = undefined; });
    this.options.metrics?.recordNotification('delivered');
  }

  async dispatchPending(): Promise<void> {
    const current = (this.options.now ?? (() => new Date()))().getTime();
    const pending = this.store.snapshot().notificationOutbox.filter((entry) => entry.state === 'pending' && (!entry.nextAttemptAt || Date.parse(entry.nextAttemptAt) <= current));
    for (const entry of pending) await this.dispatch(entry.sourceEventId, entry.text);
  }
}

/** Remove only transient notification delivery rows; canonical audit events remain indefinite. */
export async function pruneNotificationOutbox(store: BackendStore, olderThan: Date): Promise<number> {
  if (Number.isNaN(olderThan.getTime())) throw new Error('NOTIFICATION_RETENTION_CUTOFF_INVALID');
  const candidate = store as BackendStore & { pruneNotificationsBefore?: (cutoff: Date) => number };
  if (candidate.pruneNotificationsBefore) return candidate.pruneNotificationsBefore(olderThan);
  return store.transaction(state => {
    const before = state.notificationOutbox.length;
    state.notificationOutbox = state.notificationOutbox.filter(entry => Date.parse(entry.retentionUntil ?? entry.createdAt) > olderThan.getTime());
    return before - state.notificationOutbox.length;
  });
}
