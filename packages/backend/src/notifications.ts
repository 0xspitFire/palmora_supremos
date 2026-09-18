import { randomUUID } from 'node:crypto';
import type { BackendStore } from './store.js';
import { PHASE2_DEFAULTS } from './phase2-defaults.js';
import type { EventRecord, NotificationOutboxRecord } from './types.js';

export interface NotificationMessage {
  eventId: string;
  runId?: string;
  type: string;
  text: string;
  canonicalLink?: string;
}

/** One-way sink. It cannot acknowledge, approve, kill, or execute a run. */
export interface NotificationSink { send(message: NotificationMessage): Promise<void>; }

const SENSITIVE_VALUE = /(?:private[_-]?key|mnemonic|seed(?:[_-]?phrase)?|passphrase|password|api[_-]?key|access[_-]?token|secret[_-]?key|auth[_-]?token|authorization|calldata|raw(?:[_-]?transaction)?|provider[_-]?payload)\s*[:=]\s*[^,\s]+/gi;
const CREDENTIAL_URL = /https?:\/\/[^\s/]+(?::[^\s/@]+)?@[^\s/]+[^\s]*/gi;

export function redactNotificationText(value: string): string {
  return value.replace(SENSITIVE_VALUE, (match) => `${match.slice(0, match.search(/[:=]/))}=[REDACTED]`).replace(CREDENTIAL_URL, '[endpoint]');
}

function canonicalRunLink(runId: string | undefined): string | undefined {
  return runId ? `/api/v1/read-model/runs/${encodeURIComponent(runId)}` : undefined;
}

function sourceText(source: EventRecord, supplied?: string): string {
  const candidate = supplied ?? source.type.replaceAll('_', ' ');
  return redactNotificationText(candidate).slice(0, 1_000);
}

export class NotificationDispatcher {
  private readonly active = new Set<string>();

  constructor(private readonly store: BackendStore, private readonly sink: NotificationSink, private readonly now: () => Date = () => new Date()) {}

  /** Queue and deliver one event. Repeating an event is idempotent. */
  async dispatch(sourceEventId: string, text?: string): Promise<void> {
    if (this.active.has(sourceEventId)) return;
    this.active.add(sourceEventId);
    let item: NotificationOutboxRecord | undefined;
    try {
      item = await this.store.transaction(state => {
        const source = state.events.find(event => event.id === sourceEventId);
        if (!source) throw new Error('NOTIFICATION_SOURCE_EVENT_NOT_FOUND');
        const safeText = sourceText(source, text);
        const existing = state.notificationOutbox.find(entry => entry.sourceEventId === sourceEventId);
        if (existing?.state === 'delivered') {
          if (existing.text !== safeText) throw new Error('NOTIFICATION_IDEMPOTENCY_CONFLICT');
          return undefined;
        }
        if (existing && existing.text !== safeText) throw new Error('NOTIFICATION_IDEMPOTENCY_CONFLICT');
        const outbox = existing ?? {
          id: `notify_${source.id}`,
          sourceEventId: source.id,
          ...(source.runId ? { runId: source.runId } : {}),
          type: source.type,
          text: safeText,
          state: 'pending' as const,
          attempts: 0,
          createdAt: this.now().toISOString(),
          ...(canonicalRunLink(source.runId) ? { canonicalLink: canonicalRunLink(source.runId) } : {}),
        };
        if (!existing) state.notificationOutbox.push(outbox);
        outbox.state = 'delivering';
        outbox.attempts += 1;
        outbox.lastError = undefined;
        outbox.nextAttemptAt = undefined;
        return structuredClone(outbox);
      });
      if (!item) return;
      await this.sink.send({ eventId: item.id, ...(item.runId ? { runId: item.runId } : {}), type: item.type, text: item.text, ...(item.canonicalLink ? { canonicalLink: item.canonicalLink } : {}) });
      await this.store.transaction(state => {
        const delivered = state.notificationOutbox.find(entry => entry.id === item!.id);
        if (!delivered) throw new Error('NOTIFICATION_OUTBOX_NOT_FOUND');
        delivered.state = 'delivered';
        delivered.deliveredAt = this.now().toISOString();
        delivered.lastError = undefined;
        state.events.push({ id: `evt_${randomUUID()}`, runId: delivered.runId, type: 'notification_delivered', at: this.now().toISOString(), data: { sourceEventId: delivered.sourceEventId, notificationId: delivered.id, notificationType: delivered.type } });
      });
    } catch (error) {
      if (item) {
        const safeError = redactNotificationText(error instanceof Error ? error.message : String(error)).slice(0, 500);
        await this.store.transaction(state => {
          const failed = state.notificationOutbox.find(entry => entry.id === item!.id);
          // Normalized SQLite projects the process-local `delivering` lease
          // as pending/queued, so accept both representations here.
          if (!failed || !['delivering', 'pending'].includes(failed.state)) return;
          failed.state = 'failed';
          failed.lastError = safeError;
        });
      }
      throw error;
    } finally {
      this.active.delete(sourceEventId);
    }
  }

  async dispatchEvent(source: EventRecord, text?: string): Promise<void> {
    const existing = this.store.snapshot().events.some(event => event.id === source.id);
    if (!existing) await this.store.transaction(state => { state.events.push(structuredClone(source)); });
    return this.dispatch(source.id, text);
  }

  /** Deliver pending/failed records after a process restart. */
  async dispatchPending(): Promise<void> {
    const pending = this.store.snapshot().notificationOutbox.filter(item => item.state !== 'delivered');
    for (const item of pending) await this.dispatch(item.sourceEventId, item.text);
  }

  /** Remove only delivered read-model alerts outside the approved retention window. */
  async prune(now = this.now()): Promise<void> {
    const cutoff = now.getTime() - PHASE2_DEFAULTS.alertRetentionMs;
    await this.store.transaction(state => {
      state.notificationOutbox = state.notificationOutbox.filter(item => item.state !== 'delivered' || Date.parse(item.deliveredAt ?? item.createdAt) >= cutoff);
    });
  }
}

/** Alias used by callers that model notifications as a service. */
export { NotificationDispatcher as OneWayNotificationDispatcher };
