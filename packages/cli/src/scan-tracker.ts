/**
 * What the service remembers about its chain scans (T-030): when one last worked, which block it reached, whether the
 * latest one failed and in what class, and how many attempts failed in the last hour. It keeps only a class of
 * failure (never the provider's own text, which can carry an address or a key) and a bounded list of attempts.
 */
export interface ScanOutcomeLike { status: 'ok' | 'unavailable' | 'idle'; reason?: string; }

const HOUR_MS = 60 * 60_000;
const MAX_ATTEMPTS = 500;

/** The class of a scan failure: a fixed code, so nothing from a provider message is stored or shown. */
export function scanProblemCode(reason: string | undefined): string {
  if (reason === 'HEAD_UNAVAILABLE' || reason === 'LOGS_UNAVAILABLE') return reason;
  if (reason?.startsWith('RATE_LIMITED')) return 'RATE_LIMITED';
  return 'SCAN_FAILED';
}

export class ScanTracker {
  public readonly startedAt: Date;
  public lastOkAt?: Date;
  public lastOkBlock?: string;
  public lastProblem?: string;
  private attempts: Array<{ at: number; ok: boolean }> = [];

  public constructor(startedAt: Date) { this.startedAt = startedAt; }

  /** Records one finished scan; `block` is the block it reached, when known. */
  public record(outcome: ScanOutcomeLike, now: Date, block?: string): void {
    const ok = outcome.status !== 'unavailable';
    this.push(now, ok);
    if (ok) {
      this.lastOkAt = now;
      if (block !== undefined) this.lastOkBlock = block;
      this.lastProblem = undefined;
    } else this.lastProblem = scanProblemCode(outcome.reason);
  }

  /** A scan that threw instead of answering. */
  public recordFailure(now: Date): void {
    this.push(now, false);
    this.lastProblem = 'SCAN_FAILED';
  }

  public lastHour(now: Date): { total: number; failed: number } {
    const recent = this.attempts.filter((attempt) => attempt.at > now.getTime() - HOUR_MS);
    return { total: recent.length, failed: recent.filter((attempt) => !attempt.ok).length };
  }

  private push(now: Date, ok: boolean): void {
    this.attempts.push({ at: now.getTime(), ok });
    this.attempts = this.attempts.filter((attempt) => attempt.at > now.getTime() - HOUR_MS).slice(-MAX_ATTEMPTS);
  }
}
