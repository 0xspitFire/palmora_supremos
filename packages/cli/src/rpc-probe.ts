import { providerErrorDetail, SEADROP_MINT_TOPIC, SEADROP_V1_ADDRESS } from '@mint-bot/engine';
import type { Hex, PublicClient } from 'viem';

/**
 * Read-only RPC load probe (checklist: "RPC load behavior"). It sends small, cheap read requests in steps
 * of rising concurrency and reports latency, errors and rate limiting, so we know what a mint-time burst
 * can expect. It never signs or sends a transaction and never prints the endpoint.
 */
export interface ProbeOptions {
  /** Concurrency levels to try, in order (default 1, 5, 15). */
  levels?: readonly number[];
  /** Requests per level (default 30; hard maximum 100). */
  requestsPerLevel?: number;
  now?: () => number;
}

export type FailureClass = 'rate_limited' | 'timeout' | 'other';
export interface LevelResult {
  concurrency: number;
  requests: number;
  ok: number;
  failures: Record<FailureClass, number>;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  requestsPerSecond: number;
}
export interface ProbeResult {
  levels: LevelResult[];
  totalRequests: number;
  /** Highest concurrency that finished with no failures, or null if even the first level failed. */
  cleanUpToConcurrency: number | null;
  firstRateLimitAtConcurrency: number | null;
  stoppedEarly: boolean;
  summary: string;
}

const MAX_TOTAL_REQUESTS = 300;

export function classifyFailure(error: unknown): FailureClass {
  const detail = providerErrorDetail(error);
  if (/rate.?limit|429|too many|capacity|exceeded/i.test(detail)) return 'rate_limited';
  if (/timed? ?out|timeout|ETIMEDOUT|aborted/i.test(`${detail} ${(error as { name?: string } | null)?.name ?? ''}`)) return 'timeout';
  return 'other';
}

function percentile(sorted: readonly number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]!);
}

export async function probeRpc(client: PublicClient, options: ProbeOptions = {}): Promise<ProbeResult> {
  const levels = options.levels ?? [1, 5, 15];
  const perLevel = options.requestsPerLevel ?? 30;
  const now = options.now ?? (() => performance.now());
  if (levels.length === 0 || levels.some((level) => !Number.isSafeInteger(level) || level < 1 || level > 50) || !Number.isSafeInteger(perLevel) || perLevel < 1 || perLevel > 100) throw new Error('PROBE_OPTIONS_INVALID');
  const head = await client.getBlockNumber();
  const results: LevelResult[] = [];
  let total = 0;
  let stoppedEarly = false;
  for (const concurrency of levels) {
    if (total + perLevel > MAX_TOTAL_REQUESTS) { stoppedEarly = true; break; }
    const latencies: number[] = [];
    const failures: Record<FailureClass, number> = { rate_limited: 0, timeout: 0, other: 0 };
    let next = 0;
    const started = now();
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= perLevel) return;
        const begin = now();
        try {
          // Alternate a trivial call and a one-block log query, the two shapes the bot uses.
          if (index % 2 === 0) await client.getBlockNumber();
          else await client.getLogs({ address: SEADROP_V1_ADDRESS, fromBlock: head, toBlock: head, topics: [SEADROP_MINT_TOPIC as Hex] } as never);
          latencies.push(now() - begin);
        } catch (error) { failures[classifyFailure(error)] += 1; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, perLevel) }, worker));
    const seconds = Math.max((now() - started) / 1_000, 0.001);
    const sorted = [...latencies].sort((left, right) => left - right);
    results.push({ concurrency, requests: perLevel, ok: latencies.length, failures, p50Ms: percentile(sorted, 0.5), p95Ms: percentile(sorted, 0.95), maxMs: sorted.length ? Math.round(sorted.at(-1)!) : null, requestsPerSecond: Math.round((perLevel / seconds) * 10) / 10 });
    total += perLevel;
    const failed = failures.rate_limited + failures.timeout + failures.other;
    // Stop climbing once the provider is clearly struggling, rather than hammering it.
    if (failures.rate_limited > 0 || failed / perLevel > 0.5) { stoppedEarly = levels.indexOf(concurrency) < levels.length - 1; break; }
  }
  const clean = results.filter((level) => level.ok === level.requests);
  const cleanUpToConcurrency = clean.length > 0 && clean.every((level, index) => results[index] === level) ? clean.at(-1)!.concurrency : (clean.at(-1)?.concurrency ?? null);
  const firstRateLimit = results.find((level) => level.failures.rate_limited > 0)?.concurrency ?? null;
  const worst = results.at(-1);
  const summary = results.length === 0
    ? 'No requests were sent.'
    : `${cleanUpToConcurrency === null ? 'Even the first step had failures' : `Clean with up to ${cleanUpToConcurrency} request(s) at once`}; ${firstRateLimit === null ? 'no rate limiting seen' : `rate limiting began at ${firstRateLimit} at once`}. Slowest step: median ${worst?.p50Ms ?? 'n/a'} ms, 95th percentile ${worst?.p95Ms ?? 'n/a'} ms.${stoppedEarly ? ' Stopped early to avoid pushing a struggling provider.' : ''}`;
  return { levels: results, totalRequests: total, cleanUpToConcurrency, firstRateLimitAtConcurrency: firstRateLimit, stoppedEarly, summary };
}
