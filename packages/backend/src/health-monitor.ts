import { DEFAULT_ALERT_THRESHOLDS, evaluateOperationalAlerts, type AlertManager, type AlertThresholds } from './alerts.js';
import { plainSystemText } from './system-card.js';
import { durationText, healthCard, recoveredCard, type HealthFacts, type HealthKey } from './system-messages.js';

/**
 * Bot health warnings for Telegram (T-030, D-045). The monitor looks at a sample of facts the host supplies (when the
 * chain scan last worked, how many reads failed, free disk space, the last backup, undelivered messages), decides which
 * troubles are active, and sends one message when a trouble begins, one if it gets worse, a reminder every six hours
 * while it lasts, and a RECOVERED message with how long it lasted. It reads nothing itself and changes nothing: a
 * health warning is information only, never a permission, and it never touches a run, a cap or the kill switch.
 *
 * The thresholds for the connection, disk and backup conditions come from `evaluateOperationalAlerts`, so there is one
 * source for them. Signals that do not apply here (process, reconciliation, kill switch, spend cap) are passed as neutral
 * values: that function treats a missing value as the worst case.
 */
export interface HealthSample {
  now: Date;
  scan: {
    /** When the host started watching; the stall clock begins here until a scan succeeds. */
    startedAt: Date;
    lastOkAt?: Date;
    lastOkBlock?: string;
    /** Reason code of the latest failed scan (`HEAD_UNAVAILABLE`, `LOGS_UNAVAILABLE`, `RATE_LIMITED...`), if the latest scan failed. */
    lastProblem?: string;
  };
  /** Scan attempts in the last hour. */
  endpoint: { total: number; failed: number };
  disk?: { freeBytes: number; totalBytes: number };
  /** Undefined when no backup is configured. */
  backup?: { status: 'ok' | 'failed'; recordedAt: Date };
  /** Messages that failed to deliver and are still within their retry window. */
  delivery: { failed: number; oldestFailedAt?: Date };
}

export interface HealthMonitorOptions {
  thresholds?: Partial<AlertThresholds>;
  /** No successful scan for this long raises ATTENTION. */
  scanStalledMs?: number;
  /** ... and CRITICAL after this long. */
  scanCriticalMs?: number;
  /** Fewer attempts than this in the last hour are too few to judge a failure ratio. */
  minEndpointSample?: number;
  reminderMs?: number;
  now?: () => Date;
  onError?: (error: unknown) => void;
}

interface Episode { id: string; since: Date; severity: 'attention' | 'critical'; lastSentAt: Date; reminders: number; }
type Active = HealthFacts;

const gigabytes = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

/** Plain words for a scan problem code. The raw provider text is never shown: it can carry an address or a key. */
export function scanCauseWords(code: string | undefined): string {
  if (!code) return 'not known yet';
  if (code.startsWith('RATE_LIMITED')) return 'the chain provider is limiting requests (the plan limit may be reached)';
  if (code === 'HEAD_UNAVAILABLE') return 'the chain provider is not answering';
  if (code === 'LOGS_UNAVAILABLE') return 'the chain provider is not returning mint events';
  return 'the scan failed for a reason that is only in the log';
}

export class HealthMonitor {
  private readonly episodes = new Map<HealthKey, Episode>();
  private readonly thresholds: AlertThresholds;
  private readonly scanStalledMs: number;
  private readonly scanCriticalMs: number;
  private readonly minEndpointSample: number;
  private readonly reminderMs: number;
  private readonly onError: (error: unknown) => void;

  public constructor(private readonly alerts: Pick<AlertManager, 'intelligence'>, options: HealthMonitorOptions = {}) {
    this.thresholds = { ...DEFAULT_ALERT_THRESHOLDS, ...options.thresholds };
    this.scanStalledMs = options.scanStalledMs ?? 15 * 60_000;
    this.scanCriticalMs = options.scanCriticalMs ?? 60 * 60_000;
    this.minEndpointSample = options.minEndpointSample ?? 6;
    this.reminderMs = options.reminderMs ?? 6 * 60 * 60_000;
    this.onError = options.onError ?? (() => undefined);
  }

  /** Troubles currently open, for the check-in. */
  public openKeys(): HealthKey[] { return [...this.episodes.keys()]; }

  public evaluate(sample: HealthSample): Active[] {
    const active: Active[] = [];
    const { now } = sample;

    const reference = sample.scan.lastOkAt ?? sample.scan.startedAt;
    const stalledFor = now.getTime() - reference.getTime();
    if (stalledFor >= this.scanStalledMs) {
      active.push({
        key: 'scan_stalled',
        severity: stalledFor >= this.scanCriticalMs ? 'critical' : 'attention',
        facts: [
          { label: 'What happened', value: `no successful chain scan for ${durationText(stalledFor / 1_000)}.`, strong: true },
          { label: 'Last good scan', value: sample.scan.lastOkAt ? `${sample.scan.lastOkAt.toISOString().slice(11, 16)} UTC${sample.scan.lastOkBlock ? `, block ${Number(sample.scan.lastOkBlock).toLocaleString('en-US')}` : ''}` : 'none since the bot started', strong: true },
          { label: 'Likely cause', value: scanCauseWords(sample.scan.lastProblem) },
        ],
        meaning: 'new mints and wallet activity are not being seen, so you may miss alerts. The bot resumes from the last block it checked when scanning works again.',
        steps: [
          'Check that the chain provider is up and your plan limit is not used up.',
          'If it is still failing in an hour, restart the service on the host and read its log.',
        ],
        since: reference,
      });
    }

    const evaluated = evaluateOperationalAlerts({
      processAlive: true,
      reconciliationAgeSeconds: 0,
      unresolvedSubmissions: 0,
      endpointErrorRatio: sample.endpoint.total >= this.minEndpointSample ? sample.endpoint.failed / sample.endpoint.total : 0,
      ...(sample.disk ? { diskFreeBytes: sample.disk.freeBytes, diskFreeRatio: sample.disk.totalBytes > 0 ? sample.disk.freeBytes / sample.disk.totalBytes : 1 } : {}),
      backupAgeSeconds: sample.backup ? (now.getTime() - sample.backup.recordedAt.getTime()) / 1_000 : 0,
      backupFailed: sample.backup?.status === 'failed',
      killSwitchEngaged: false,
      capHit: false,
      notificationConnected: true,
    }, this.endpointThresholds(), now);
    const firing = new Set(evaluated.map((entry) => entry.key));

    if (firing.has('endpoint_degraded')) {
      active.push({
        key: 'endpoint_errors',
        severity: 'attention',
        facts: [
          { label: 'What happened', value: `${sample.endpoint.failed} of ${sample.endpoint.total} chain scans failed in the last hour (${Math.round(100 * sample.endpoint.failed / sample.endpoint.total)}%).`, strong: true },
          { label: 'Likely cause', value: scanCauseWords(sample.scan.lastProblem) },
        ],
        meaning: 'the bot still works but sees the chain late or in gaps. If it gets worse, a scan stall warning follows.',
        steps: ['Nothing is needed yet. If it keeps up for hours, check the chain provider and your plan limit.'],
        since: new Date(now.getTime() - 60 * 60_000),
      });
    }
    if (firing.has('disk_pressure') && sample.disk) {
      active.push({
        key: 'disk_pressure',
        severity: 'critical',
        facts: [{ label: 'What happened', value: `only ${gigabytes(sample.disk.freeBytes)} of disk space is free (${Math.round(100 * sample.disk.freeBytes / Math.max(1, sample.disk.totalBytes))}%).`, strong: true }],
        meaning: 'when the disk is full the bot cannot save its state and may stop.',
        steps: ['Free up space on the host: old logs, old backups, downloads.', 'Then check that the bot is still running.'],
        since: now,
      });
    }
    if (firing.has('backup_stale') && sample.backup) {
      const failed = sample.backup.status === 'failed';
      active.push({
        key: 'backup_stale',
        severity: 'critical',
        facts: [
          { label: 'What happened', value: failed ? 'the last backup failed.' : `the last backup is older than ${Math.round(this.thresholds.backupMaxAgeSeconds / 3_600)} h.`, strong: true },
          { label: 'Last backup', value: `${sample.backup.recordedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC` },
        ],
        meaning: 'if the host is lost now, recent state could not be restored.',
        steps: ['Check that the backup job runs and its target has space.', 'Run a backup by hand and confirm it reports OK.'],
        since: sample.backup.recordedAt,
      });
    }
    if (sample.delivery.failed > 0) {
      const oldest = sample.delivery.oldestFailedAt ?? now;
      active.push({
        key: 'delivery_trouble',
        severity: 'attention',
        facts: [
          { label: 'What happened', value: `${sample.delivery.failed} ${sample.delivery.failed === 1 ? 'message' : 'messages'} did not reach Telegram, the oldest ${durationText((now.getTime() - oldest.getTime()) / 1_000)} ago.`, strong: true },
        ],
        meaning: 'you may be missing alerts. The bot retries for 6 hours and sends them when Telegram works again, so they can arrive late.',
        steps: ['Check that Telegram is reachable from the host and that the bot token is still valid.'],
        since: oldest,
      });
    }
    return active;
  }

  /** Once a trouble is open, it clears only when the ratio falls well below the trigger, so it does not flap. */
  private endpointThresholds(): AlertThresholds {
    return this.episodes.has('endpoint_errors') ? { ...this.thresholds, endpointErrorRatio: this.thresholds.endpointErrorRatio / 2 } : this.thresholds;
  }

  /** Evaluates one sample and sends what is due. Returns the messages sent (or recorded, when delivery failed and is retried). */
  public async check(sample: HealthSample): Promise<string[]> {
    const active = new Map(this.evaluate(sample).map((entry) => [entry.key, entry] as const));
    const sent: string[] = [];
    const emit = async (key: HealthKey, id: string, stage: string, card: ReturnType<typeof healthCard>): Promise<void> => {
      try {
        await this.alerts.intelligence({ kind: 'health', dedupe: `health:${key}:${id}:${stage}`, text: plainSystemText(card), priority: 'immediate', system: card, at: sample.now.toISOString() });
      } catch (error) {
        // The alert is recorded before delivery; a failed delivery is retried from the outbox.
        this.onError(error);
      }
      sent.push(`${key}:${stage}`);
    };
    for (const key of ['scan_stalled', 'endpoint_errors', 'disk_pressure', 'backup_stale', 'delivery_trouble'] as const) {
      const current = active.get(key);
      const episode = this.episodes.get(key);
      if (current && !episode) {
        const opened: Episode = { id: sample.now.toISOString(), since: new Date(current.since), severity: current.severity, lastSentAt: sample.now, reminders: 0 };
        this.episodes.set(key, opened);
        await emit(key, opened.id, current.severity === 'critical' ? 'critical' : 'open', healthCard(current));
      } else if (current && episode) {
        if (current.severity === 'critical' && episode.severity === 'attention') {
          episode.severity = 'critical';
          episode.lastSentAt = sample.now;
          await emit(key, episode.id, 'critical', healthCard({ ...current, since: episode.since }));
        } else if (sample.now.getTime() - episode.lastSentAt.getTime() >= this.reminderMs) {
          episode.reminders += 1;
          episode.lastSentAt = sample.now;
          await emit(key, episode.id, `reminder${episode.reminders}`, healthCard({ ...current, since: episode.since }, { reminder: episode.reminders }));
        }
      } else if (!current && episode) {
        this.episodes.delete(key);
        await emit(key, episode.id, 'recovered', recoveredCard(key, { since: episode.since, now: sample.now }));
      }
    }
    return sent;
  }
}
