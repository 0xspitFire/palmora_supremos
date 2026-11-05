import { randomUUID } from 'node:crypto';
import type { BackendStore } from './store.js';
import { PHASE2_DEFAULTS } from './phase2-defaults.js';
import type { BackendState, EventRecord, NotificationOutboxRecord } from './types.js';
import type { MetricsRegistry } from './observability.js';
import { parseAlertCard, parseDigestItems, type AlertCard, type DigestItem } from './alert-card.js';
import { parseSystemCard, type SystemCard } from './system-card.js';

export interface NotificationMessage {
  eventId: string;
  runId?: string;
  type: string;
  text: string;
  canonicalLink?: string;
  /** Structured collection alert, read from the stored event on every attempt; sinks that cannot render it use `text`. */
  card?: AlertCard;
  /** Items of a digest, with their cards where they have one. */
  items?: DigestItem[];
  /** Structured system message (start, check-in, kill switch, spend cap, health). */
  system?: SystemCard;
}

/** One-way sink. It cannot acknowledge, approve, kill, or execute a run. */
export interface NotificationSink { send(message: NotificationMessage): Promise<void>; }

const SENSITIVE_VALUE = /(?:private[_-]?key|mnemonic|seed(?:[_-]?phrase)?|passphrase|password|api[_-]?key|access[_-]?token|secret[_-]?key|auth[_-]?token|authorization|calldata|raw(?:[_-]?transaction)?|provider[_-]?payload)\s*[:=]\s*[^,\s]+/gi;
const CREDENTIAL_URL = /https?:\/\/[^\s/]+(?::[^\s/@]+)?@[^\s/]+[^\s]*/gi;
const RAW_HEX_VALUE = /0x[0-9a-f]{64}/gi;
const JSON_SECRET_VALUE = /["'](?:api[_-]?key|token|secret|authorization|calldata|raw[_-]?transaction)["']\s*:\s*["'][^"']*["']/gi;

export function redactNotificationText(value: string): string {
  return value.replace(SENSITIVE_VALUE, (match) => `${match.slice(0, match.search(/[:=]/))}=[REDACTED]`).replace(JSON_SECRET_VALUE, '[REDACTED]').replace(CREDENTIAL_URL, '[endpoint]').replace(RAW_HEX_VALUE, '[REDACTED]');
}

function canonicalRunLink(runId: string | undefined): string | undefined {
  return runId ? `/api/v1/read-model/runs/${encodeURIComponent(runId)}` : undefined;
}

function sourceText(source: EventRecord, supplied?: string): string {
  const candidate = supplied ?? source.type.replaceAll('_', ' ');
  return redactNotificationText(candidate).slice(0, 1_000);
}

/** Queue alongside the source event so a crash before delivery cannot lose an immediate alert. */
export function enqueueNotification(state: BackendState, source: EventRecord, text: string | undefined, now: Date, retentionDays: number): NotificationOutboxRecord {
  const existing = state.notificationOutbox.find(item => item.sourceEventId === source.id);
  if (existing) return existing;
  const sourceTime = Date.parse(source.at);
  const createdAt = Number.isFinite(sourceTime) && sourceTime <= now.getTime() ? source.at : now.toISOString();
  const item: NotificationOutboxRecord = {
    id: `notify_${source.id}`, sourceEventId: source.id, ...(source.runId ? { runId: source.runId } : {}),
    type: source.type, text: sourceText(source, text), state: 'pending', attempts: 0, createdAt,
    retentionUntil: new Date(Date.parse(createdAt) + retentionDays * 86_400_000).toISOString(),
    ...(canonicalRunLink(source.runId) ? { canonicalLink: canonicalRunLink(source.runId) } : {}),
  };
  state.notificationOutbox.push(item);
  return item;
}

/** A retained explicit Telegram refusal applies to the shared owner delivery channel, across restarts. */
function sharedBackoff(state: BackendState, now: number): number {
  return state.notificationOutbox.reduce((until, item) => {
    const next = Date.parse(item.nextAttemptAt ?? '');
    return item.lastError === 'TELEGRAM_DELIVERY_FAILED:429' && item.state !== 'delivered' && Number.isFinite(next) && next > now ? Math.max(until, next) : until;
  }, 0);
}
function deferForProvider(state: BackendState, item: NotificationOutboxRecord, now: number): boolean {
  const until = sharedBackoff(state, now);
  if (until <= now) return false;
  if (item.state !== 'delivered' && !(item.deliveryLeaseUntil && Date.parse(item.deliveryLeaseUntil) > now)) {
    item.nextAttemptAt = new Date(Math.max(until, Date.parse(item.nextAttemptAt ?? '') || 0)).toISOString();
  }
  return true;
}

/** An explicit provider refusal with a minimum retry delay; never evidence of delivery. */
export class NotificationRateLimitError extends Error {
  constructor(public readonly retryAfterMs: number) { super('TELEGRAM_DELIVERY_FAILED:429'); this.name = 'NotificationRateLimitError'; }
}

export class NotificationDispatcher {
  private readonly active = new Set<string>();
  private readonly now: () => Date;
  private readonly metrics?: MetricsRegistry;
  private readonly retentionDays: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly leaseMs: number;
  private readonly minIntervalMs: number;
  private nextDeliveryAt = 0;

  constructor(private readonly store: BackendStore, private readonly sink: NotificationSink, options: (() => Date) | { now?: () => Date; metrics?: MetricsRegistry; retentionDays?: number; leaseMs?: number; retryBaseMs?: number; retryMaxMs?: number; minIntervalMs?: number } = {}) {
    if (typeof options === 'function') {
      this.now = options;
      this.retentionDays = Math.floor(PHASE2_DEFAULTS.alertRetentionMs / 86_400_000);
      this.retryBaseMs = 1_000;
      this.retryMaxMs = 60_000;
      this.leaseMs = 30_000;
      this.minIntervalMs = 0;
    } else {
      this.now = options.now ?? (() => new Date());
      this.metrics = options.metrics;
      this.retentionDays = options.retentionDays ?? Math.floor(PHASE2_DEFAULTS.alertRetentionMs / 86_400_000);
      this.retryBaseMs = options.retryBaseMs ?? 1_000;
      this.retryMaxMs = options.retryMaxMs ?? 60_000;
      this.leaseMs = options.leaseMs ?? 30_000;
      this.minIntervalMs = options.minIntervalMs ?? 0;
      if (!Number.isSafeInteger(this.minIntervalMs) || this.minIntervalMs < 0 || this.minIntervalMs > 10_000) throw new Error('NOTIFICATION_INTERVAL_INVALID');
    }
  }

  /** Queue and deliver one event. Repeating an event is idempotent. */
  async dispatch(sourceEventId: string, text?: string): Promise<void> {
    if (this.active.has(sourceEventId)) return;
    this.active.add(sourceEventId);
    let item: NotificationOutboxRecord | undefined;
    let card: AlertCard | undefined;
    let items: DigestItem[] | undefined;
    let system: SystemCard | undefined;
    try {
      // Persist pending work before pacing. A restart can then retry the same event without losing it.
      const eligible = await this.store.transaction(state => {
        const source = state.events.find(event => event.id === sourceEventId);
        if (!source) throw new Error('NOTIFICATION_SOURCE_EVENT_NOT_FOUND');
        const queued = enqueueNotification(state, source, text, this.now(), this.retentionDays);
        return queued.state !== 'delivered' && !deferForProvider(state, queued, this.now().getTime());
      });
      if (!eligible) return;
      // Pace before acquiring the durable delivery lease, so a waiting slot cannot expire that lease.
      if (this.minIntervalMs > 0) {
        const slot = Math.max(this.now().getTime(), this.nextDeliveryAt);
        this.nextDeliveryAt = slot + this.minIntervalMs;
        const delay = slot - this.now().getTime();
        if (delay > 0) await new Promise<void>(resolve => { setTimeout(resolve, delay); });
      }
      item = await this.store.transaction(state => {
        const source = state.events.find(event => event.id === sourceEventId);
        if (!source) throw new Error('NOTIFICATION_SOURCE_EVENT_NOT_FOUND');
        // The structured form is re-read on every attempt so retry rendering uses current delivery time.
        card = parseAlertCard(source.data.card) ?? undefined;
        items = parseDigestItems(source.data.items) ?? undefined;
        system = parseSystemCard(source.data.system) ?? undefined;
        const outbox = enqueueNotification(state, source, text, this.now(), this.retentionDays);
        if (outbox.state === 'delivered' || deferForProvider(state, outbox, this.now().getTime())) return undefined;
        if (outbox.nextAttemptAt && Date.parse(outbox.nextAttemptAt) > this.now().getTime()) return undefined;
        if (outbox.deliveryLeaseUntil && Date.parse(outbox.deliveryLeaseUntil) > this.now().getTime()) return undefined;
        outbox.state = 'delivering';
        outbox.attempts += 1;
        outbox.lastError = undefined;
        outbox.nextAttemptAt = undefined;
        outbox.deliveryLeaseUntil = new Date(this.now().getTime() + this.leaseMs).toISOString();
        return structuredClone(outbox);
      });
      if (!item) return;
      this.metrics?.recordNotification('delivering');
      await this.sink.send({ eventId: item.id, ...(item.runId ? { runId: item.runId } : {}), type: item.type, text: item.text, ...(item.canonicalLink ? { canonicalLink: item.canonicalLink } : {}), ...(card ? { card } : {}), ...(items ? { items } : {}), ...(system ? { system } : {}) });
      await this.store.transaction(state => {
        const delivered = state.notificationOutbox.find(entry => entry.id === item!.id);
        if (!delivered) throw new Error('NOTIFICATION_OUTBOX_NOT_FOUND');
        delivered.state = 'delivered';
        delivered.deliveredAt = this.now().toISOString();
        delivered.lastError = undefined;
        delivered.deliveryLeaseUntil = undefined;
        delivered.nextAttemptAt = undefined;
        state.events.push({ id: `evt_${randomUUID()}`, runId: delivered.runId, type: 'notification_delivered', at: this.now().toISOString(), data: { sourceEventId: delivered.sourceEventId, notificationId: delivered.id, notificationType: delivered.type } });
      });
      this.metrics?.recordNotification('delivered');
    } catch (error) {
      if (item) {
        const safeError = redactNotificationText(error instanceof Error ? error.message : String(error)).slice(0, 500);
        await this.store.transaction(state => {
          const failed = state.notificationOutbox.find(entry => entry.id === item!.id);
          // Normalized SQLite projects the process-local `delivering` lease
          // as pending/queued, so accept both representations here.
          if (!failed || !['delivering', 'pending'].includes(failed.state)) return;
          failed.state = 'failed';
          failed.deliveryLeaseUntil = undefined;
          failed.lastError = safeError;
          failed.nextAttemptAt = new Date(this.now().getTime() + Math.max(Math.min(this.retryMaxMs, this.retryBaseMs * Math.max(1, 2 ** Math.min(8, failed.attempts))), error instanceof NotificationRateLimitError && Number.isSafeInteger(error.retryAfterMs) && error.retryAfterMs > 0 ? error.retryAfterMs : 0)).toISOString();
        });
      }
      this.metrics?.recordNotification('failed');
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
    const now = this.now();
    const pending = this.store.snapshot().notificationOutbox.filter(item => item.state !== 'delivered' && (!item.nextAttemptAt || Date.parse(item.nextAttemptAt) <= now.getTime()));
    for (const item of pending) await this.dispatch(item.sourceEventId, item.text);
  }

  /** Remove only delivered read-model alerts outside the approved retention window. */
  async prune(now = this.now()): Promise<void> {
    const retentionDays = Number.isSafeInteger(this.retentionDays) && this.retentionDays > 0 ? this.retentionDays : Math.floor(PHASE2_DEFAULTS.alertRetentionMs / 86_400_000);
    const cutoff = now.getTime() - retentionDays * 86_400_000;
    await this.store.transaction(state => {
      state.notificationOutbox = state.notificationOutbox.filter(item => item.state !== 'delivered' || Date.parse(item.deliveredAt ?? item.createdAt) >= cutoff);
    });
  }
}

/** Alias used by callers that model notifications as a service. */
export { NotificationDispatcher as OneWayNotificationDispatcher };
