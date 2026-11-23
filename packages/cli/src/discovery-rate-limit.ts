/** Back off on classified rate limits without changing successful scan cadence. */
export function discoveryRateLimitDelay(intervalMs: number, limitMs: number, random = Math.random): (rateLimited: boolean) => number {
  const ceiling = Math.max(intervalMs, limitMs);
  let next = intervalMs;
  return rateLimited => {
    if (!rateLimited) {
      next = intervalMs;
      return intervalMs;
    }
    const sample = random();
    const jitter = Number.isFinite(sample) ? Math.max(0, Math.min(1, sample)) : 0;
    const delay = Math.min(ceiling, Math.round(next * (1 + jitter * 0.25)));
    next = Math.min(ceiling, next * 2);
    return delay;
  };
}
