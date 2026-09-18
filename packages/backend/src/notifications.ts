import type { BackendStore } from './store.js';
import { redactText, MetricsRegistry } from './observability.js';
export interface NotificationSink { send(message: { eventId: string; runId?: string; type: string; text: string }): Promise<void>; }
export class NotificationDispatcher {
  constructor(private readonly store: BackendStore, private readonly sink: NotificationSink, private readonly options: { metrics?: MetricsRegistry; now?: () => Date; retentionDays?: number } = {}) {}
  async dispatch(sourceEventId: string, text: string): Promise<void> {
    const safeText = redactText(text);
    const now = this.options.now ?? (() => new Date());
    const retentionDays = this.options.retentionDays ?? 30;
    if (!Number.isSafeInteger(retentionDays) || retentionDays <= 0) throw new Error('NOTIFICATION_RETENTION_INVALID');
    const item = await this.store.transaction(state => {
      const existing = state.notificationOutbox.find(entry => entry.sourceEventId === sourceEventId); if (existing?.state === 'delivered') return undefined;
      const source = state.events.find(event => event.id === sourceEventId); if (!source) throw new Error('NOTIFICATION_SOURCE_EVENT_NOT_FOUND');
      const createdAt = now().toISOString();
      const retentionUntil = new Date(Date.parse(createdAt) + retentionDays * 86_400_000).toISOString();
      const outbox = existing ?? { id: `notify_${source.id}`, sourceEventId: source.id, ...(source.runId ? { runId: source.runId } : {}), type: source.type, text: safeText, state: 'pending' as const, attempts: 0, createdAt, retentionUntil };
      if (!existing) state.notificationOutbox.push(outbox);
      // A process can die after persisting `delivering`; a subsequent boot is
      // allowed to retry that item instead of treating it as delivered.
      outbox.state = 'delivering'; outbox.attempts += 1; return structuredClone(outbox);
    });
    if (!item) return;
    this.options.metrics?.recordNotification('delivering');
    try { await this.sink.send({ eventId: item.id, ...(item.runId ? { runId: item.runId } : {}), type: item.type, text: item.text }); }
    catch (error) { await this.store.transaction(state => { const failed = state.notificationOutbox.find(entry => entry.id === item.id); if (failed?.state === 'delivering') failed.state = 'pending'; }); this.options.metrics?.recordNotification('failed'); throw error; }
    await this.store.transaction(state => { const delivered = state.notificationOutbox.find(entry => entry.id === item.id); if (!delivered) throw new Error('NOTIFICATION_OUTBOX_NOT_FOUND'); delivered.state = 'delivered'; delivered.deliveredAt = now().toISOString(); });
    this.options.metrics?.recordNotification('delivered');
  }

  async dispatchPending(): Promise<void> {
    const pending = this.store.snapshot().notificationOutbox.filter((entry) => entry.state === 'pending');
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
