import { appendFileSync, chmodSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

const SENSITIVE_KEY = /(?:private[_-]?key|mnemonic|seed(?:[_-]?phrase)?|passphrase|password|secret|token|authorization|api[_-]?key|chat[_-]?id|raw(?:tx|_transaction)|calldata|payload)/i;
const SENSITIVE_VALUE = /(?:Bearer|Basic)\s+\S+|-----BEGIN [^-]+PRIVATE KEY-----|https?:\/\/[^\s/]+\/bot[^\s/?]+/gi;
const HEX_SECRET = /0x[0-9a-f]{64,}/gi;

/**
 * Redact structured operational data before it reaches stdout, a file, or a
 * notification. Identifiers such as run IDs remain available; secret-like
 * field names and provider payloads do not.
 */
export function redactRecord(value: unknown, key = '', seen = new WeakSet<object>()): unknown {
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map((entry) => redactRecord(entry, key, seen));
  if (value !== null && typeof value === 'object') {
    if (seen.has(value)) return '[CIRCULAR]';
    seen.add(value);
    return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, redactRecord(entry, name, seen)]));
  }
  return value;
}

export function redactText(value: string): string {
  return value.replace(SENSITIVE_VALUE, '[REDACTED]').replace(HEX_SECRET, '[REDACTED]').slice(0, 2_000);
}

export function redactError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: redactText(error.message) };
  return { name: 'UnknownError', message: redactText(String(error)) };
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogWriterOptions {
  destination?: string;
  stdout?: boolean;
  maxBytes?: number;
  maxFiles?: number;
}

/** A small synchronous JSON logger with bounded, redacted file output. */
export class RedactedLogger {
  private readonly destination?: string;
  private readonly stdout: boolean;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private readonly registeredSecrets = new Set<string>();

  public constructor(options: LogWriterOptions = {}) {
    this.destination = options.destination;
    this.stdout = options.stdout ?? true;
    this.maxBytes = Number.isSafeInteger(options.maxBytes) && (options.maxBytes ?? 0) > 0 ? options.maxBytes! : 10 * 1024 * 1024;
    this.maxFiles = Number.isSafeInteger(options.maxFiles) && (options.maxFiles ?? 0) > 0 ? options.maxFiles! : 5;
  }

  /** Register a host-injected value for in-memory exact-match redaction. */
  public registerSecret(value: string): void {
    if (value.length > 0) this.registeredSecrets.add(value);
  }

  public debug(fields: Record<string, unknown> = {}, message?: string): void { this.write('debug', fields, message); }
  public info(fields: Record<string, unknown> = {}, message?: string): void { this.write('info', fields, message); }
  public warn(fields: Record<string, unknown> = {}, message?: string): void { this.write('warn', fields, message); }
  public error(fields: Record<string, unknown> = {}, message?: string): void { this.write('error', fields, message); }

  public write(level: LogLevel, fields: Record<string, unknown> = {}, message?: string): void {
    const safe = redactRecord(fields) as Record<string, unknown>;
    const record = {
      timestamp: new Date().toISOString(),
      level,
      ...safe,
      ...(message === undefined ? {} : { message: redactText(message) }),
    };
    let line = JSON.stringify(record);
    for (const secret of this.registeredSecrets) line = line.split(secret).join('[REDACTED]');
    line += '\n';
    if (this.stdout) process.stdout.write(line);
    if (this.destination) this.writeFile(line);
  }

  private writeFile(line: string): void {
    const path = this.destination!;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try { chmodSync(dirname(path), 0o700); } catch { /* best-effort on filesystems without POSIX modes */ }
    try {
      const size = statSync(path).size;
      if (size + Buffer.byteLength(line) > this.maxBytes) this.rotate(path);
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    appendFileSync(path, line, { encoding: 'utf8', mode: 0o600 });
    try { chmodSync(path, 0o600); } catch { /* best-effort on filesystems without POSIX modes */ }
  }

  private rotate(path: string): void {
    for (let index = this.maxFiles - 1; index >= 1; index -= 1) {
      const older = `${path}.${index}`;
      const newer = `${path}.${index + 1}`;
      try { renameSync(older, newer); } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    try { renameSync(path, `${path}.1`); } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

type Labels = Readonly<Record<string, string | number>>;
type MetricKind = 'counter' | 'gauge' | 'histogram';

interface MetricSeries {
  name: string;
  labels: Labels;
  value: number;
  kind: MetricKind;
}

interface HistogramSeries extends MetricSeries {
  buckets: number[];
  counts: number[];
  sum: number;
  count: number;
}

function validMetricName(name: string): boolean { return /^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(name); }
function safeLabel(value: string | number): string { return String(value).replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 64) || 'unknown'; }
function seriesKey(name: string, labels: Labels): string {
  return `${name}|${Object.entries(labels).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}=${safeLabel(value)}`).join(',')}`;
}
function renderLabels(labels: Labels): string {
  const entries = Object.entries(labels).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) return '';
  return `{${entries.map(([key, value]) => `${key}="${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n')}"`).join(',')}}`;
}

/** In-process metrics registry rendered as safe Prometheus text. */
export class MetricsRegistry {
  private readonly series = new Map<string, MetricSeries | HistogramSeries>();
  private readonly kinds = new Map<string, MetricKind>();
  private readonly defaultBuckets: number[];

  public constructor(defaultBuckets = [5, 25, 100, 500, 1_000, 5_000, 30_000, 120_000]) {
    this.defaultBuckets = [...defaultBuckets].filter((item) => Number.isFinite(item) && item > 0).sort((left, right) => left - right);
  }

  public increment(name: string, labels: Labels = {}, amount = 1): number {
    this.assertMetric(name, 'counter');
    const key = seriesKey(name, labels);
    const current = this.series.get(key) as MetricSeries | undefined;
    if (current) { current.value += amount; return current.value; }
    const next: MetricSeries = { name, labels, value: amount, kind: 'counter' };
    this.series.set(key, next);
    return amount;
  }

  public set(name: string, value: number, labels: Labels = {}): void {
    this.assertMetric(name, 'gauge');
    if (!Number.isFinite(value)) throw new Error('METRIC_VALUE_INVALID');
    this.series.set(seriesKey(name, labels), { name, labels, value, kind: 'gauge' });
  }

  public setCounter(name: string, value: number, labels: Labels = {}): void {
    this.assertMetric(name, 'counter');
    if (!Number.isFinite(value) || value < 0) throw new Error('METRIC_VALUE_INVALID');
    this.series.set(seriesKey(name, labels), { name, labels, value, kind: 'counter' });
  }

  public observe(name: string, value: number, labels: Labels = {}, buckets = this.defaultBuckets): void {
    this.assertMetric(name, 'histogram');
    if (!Number.isFinite(value) || value < 0) throw new Error('METRIC_OBSERVATION_INVALID');
    const sortedBuckets = [...buckets].filter((item) => Number.isFinite(item) && item > 0).sort((left, right) => left - right);
    const key = seriesKey(name, labels);
    const current = this.series.get(key) as HistogramSeries | undefined;
    if (current) {
      current.count += 1;
      current.sum += value;
      sortedBuckets.forEach((bucket, index) => { if (value <= bucket) current.counts[index] = (current.counts[index] ?? 0) + 1; });
      return;
    }
    const counts = sortedBuckets.map((bucket) => value <= bucket ? 1 : 0);
    this.series.set(key, { name, labels, value: 0, kind: 'histogram', buckets: sortedBuckets, counts, sum: value, count: 1 });
  }

  public recordRestart(): void { this.increment('mintbot_process_restarts_total'); }
  public recordEndpoint(chain: string, endpointReference: string, ok: boolean, latencyMs: number): void {
    // Keep provider URLs and query strings out of labels; a stable class is
    // enough to alert on endpoint degradation without risking secret leakage.
    const normalizedEndpoint = endpointReference.toLowerCase();
    const endpointClass = normalizedEndpoint.includes('archive') ? 'archive' : normalizedEndpoint.includes('sequencer') ? 'sequencer' : 'primary';
    const labels = { chain: safeLabel(chain), endpoint: endpointClass, outcome: ok ? 'ok' : 'error' };
    this.increment('mintbot_endpoint_requests_total', labels);
    this.observe('mintbot_endpoint_latency_ms', latencyMs, { chain: safeLabel(chain), endpoint: endpointClass });
  }
  public recordNotification(state: 'pending' | 'delivering' | 'delivered' | 'failed'): void {
    this.increment('mintbot_notification_delivery_total', { channel: 'telegram', state });
  }
  public recordReconciliation(ageMs: number, unresolved: number): void {
    this.set('mintbot_reconciliation_age_seconds', Math.max(0, ageMs) / 1_000);
    this.set('mintbot_reconciliation_unresolved', Math.max(0, unresolved));
  }
  public recordQueue(depth: number, active: number): void {
    this.set('mintbot_queue_depth', Math.max(0, depth));
    this.set('mintbot_jobs_active', Math.max(0, active));
  }
  public recordDisk(freeBytes: number, logBytes: number): void {
    this.set('mintbot_disk_free_bytes', Math.max(0, freeBytes));
    this.set('mintbot_log_bytes', Math.max(0, logBytes));
  }
  public recordBackup(status: 'ok' | 'failed', recordedAtSeconds?: number): void {
    this.increment('mintbot_backup_operations_total', { outcome: status });
    this.set('mintbot_backup_last_success_timestamp_seconds', status === 'ok' ? (recordedAtSeconds ?? Date.now() / 1_000) : 0);
  }

  public snapshot(): Array<MetricSeries | HistogramSeries> { return [...this.series.values()].map((item) => structuredClone(item)); }

  public renderPrometheus(): string {
    const output: string[] = [];
    const renderedKinds = new Set<string>();
    for (const item of this.series.values()) {
      if (!renderedKinds.has(item.name)) {
        output.push(`# TYPE ${item.name} ${item.kind}`);
        renderedKinds.add(item.name);
      }
      if (item.kind === 'histogram') {
        const histogram = item as HistogramSeries;
        histogram.buckets.forEach((bucket, index) => output.push(`${item.name}_bucket${renderLabels({ ...item.labels, le: bucket })} ${histogram.counts[index] ?? 0}`));
        output.push(`${item.name}_bucket${renderLabels({ ...item.labels, le: '+Inf' })} ${histogram.count}`);
        output.push(`${item.name}_sum${renderLabels(item.labels)} ${histogram.sum}`);
        output.push(`${item.name}_count${renderLabels(item.labels)} ${histogram.count}`);
      } else {
        output.push(`${item.name}${renderLabels(item.labels)} ${item.value}`);
      }
    }
    return `${output.join('\n')}\n`;
  }

  private assertMetric(name: string, kind: MetricKind): void {
    if (!validMetricName(name)) throw new Error('METRIC_NAME_INVALID');
    const existing = this.kinds.get(name);
    if (existing && existing !== kind) throw new Error('METRIC_KIND_CONFLICT');
    this.kinds.set(name, kind);
  }
}

export { safeLabel };
