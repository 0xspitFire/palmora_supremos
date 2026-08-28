import { randomUUID } from 'node:crypto';
import type { DurableStore } from './store.js';
export interface NotificationSink { send(message: { eventId: string; runId?: string; type: string; text: string }): Promise<void>; }
export class NotificationDispatcher {
  constructor(private readonly store: DurableStore, private readonly sink: NotificationSink) {}
  async dispatch(type: string, text: string, runId?: string, idempotencyKey = `${type}:${runId ?? ''}`): Promise<void> {
    const s = this.store.snapshot(); if (s.events.some(e => e.type === 'notification_delivered' && e.data.idempotencyKey === idempotencyKey)) return;
    const eventId = `evt_${randomUUID()}`; await this.sink.send({ eventId, ...(runId ? { runId } : {}), type, text });
    s.events.push({ id: eventId, ...(runId ? { runId } : {}), type: 'notification_delivered', at: new Date().toISOString(), data: { idempotencyKey, notificationType: type } }); this.store.replace(s); await this.store.commit();
  }
}
