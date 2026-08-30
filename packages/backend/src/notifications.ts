import type { BackendStore } from './store.js';
export interface NotificationSink { send(message: { eventId: string; runId?: string; type: string; text: string }): Promise<void>; }
export class NotificationDispatcher {
  constructor(private readonly store: BackendStore, private readonly sink: NotificationSink) {}
  async dispatch(sourceEventId: string, text: string): Promise<void> {
    const item = await this.store.transaction(state => {
      const existing = state.notificationOutbox.find(entry => entry.sourceEventId === sourceEventId); if (existing?.state === 'delivered') return undefined;
      const source = state.events.find(event => event.id === sourceEventId); if (!source) throw new Error('NOTIFICATION_SOURCE_EVENT_NOT_FOUND');
      const outbox = existing ?? { id: `notify_${source.id}`, sourceEventId: source.id, ...(source.runId ? { runId: source.runId } : {}), type: source.type, text, state: 'pending' as const, attempts: 0, createdAt: new Date().toISOString() };
      if (!existing) state.notificationOutbox.push(outbox); if (outbox.state === 'delivering') return undefined; outbox.state = 'delivering'; outbox.attempts += 1; return structuredClone(outbox);
    });
    if (!item) return;
    try { await this.sink.send({ eventId: item.id, ...(item.runId ? { runId: item.runId } : {}), type: item.type, text: item.text }); }
    catch (error) { await this.store.transaction(state => { const failed = state.notificationOutbox.find(entry => entry.id === item.id); if (failed?.state === 'delivering') failed.state = 'pending'; }); throw error; }
    await this.store.transaction(state => { const delivered = state.notificationOutbox.find(entry => entry.id === item.id); if (!delivered) throw new Error('NOTIFICATION_OUTBOX_NOT_FOUND'); delivered.state = 'delivered'; delivered.deliveredAt = new Date().toISOString(); });
  }
}
