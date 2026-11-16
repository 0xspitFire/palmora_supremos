import type { RpcReadObservation } from '@mint-bot/engine';
/** Fixed, bounded process-local aggregates; endpoint positions are not provider identities. */
export function rpcUsageReporter(chainId: 1 | 8453 | 4663, emit: (value: Record<string, unknown>) => void, now: () => number = Date.now): (value: RpcReadObservation) => void {
  const methods = new Set(['eth_chainId','eth_blockNumber','eth_getLogs','eth_getBalance','eth_getCode','eth_call','eth_estimateGas','eth_getBlockByNumber','other']);
  const outcomes = new Set(['success','timeout','cancelled','rate_limited','monthly_capacity','http_error','rpc_error','invalid_response','network_error','uninspected']);
  const buckets = new Map<string, { endpointIndex: number; method: string; outcome: string; count: number; totalDurationMs: number; maxDurationMs: number }>();
  let started = now();
  return value => {
    const current = now();
    if (!Number.isSafeInteger(value.endpointIndex) || value.endpointIndex < 0 || value.endpointIndex > 31 || !methods.has(value.method) || !outcomes.has(value.outcome) || !Number.isFinite(value.durationMs) || value.durationMs < 0) return;
    if (current - started >= 60_000 || current < started) {
      for (const bucket of buckets.values()) { try { emit({ event: 'intelligence_rpc_usage', chainId, windowMs: Math.max(0, current - started), ...bucket }); } catch { /* Never fail a chain read because logging failed. */ } }
      buckets.clear(); started = current;
    }
    const key = `${value.endpointIndex}:${value.method}:${value.outcome}`;
    if (!buckets.has(key) && buckets.size >= 256) return;
    const row = buckets.get(key) ?? { endpointIndex: value.endpointIndex, method: value.method, outcome: value.outcome, count: 0, totalDurationMs: 0, maxDurationMs: 0 };
    row.count = Math.min(1_000_000_000, row.count + 1);
    row.totalDurationMs = Math.min(Number.MAX_SAFE_INTEGER, row.totalDurationMs + Math.round(value.durationMs));
    row.maxDurationMs = Math.max(row.maxDurationMs, Math.min(Number.MAX_SAFE_INTEGER, Math.round(value.durationMs)));
    buckets.set(key, row);
  };
}
