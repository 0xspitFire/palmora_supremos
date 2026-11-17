import { isAlchemyRpcEndpoint, alchemyFreeRequestSupported } from './alchemy-free-logs.js';
import { diagnosticRpcMethod, diagnosticRpcOutcome, type RpcReadObservation, type RpcReadOutcome } from './rpc-read-observation.js';
import { fallback, http, TimeoutError, ResponseBodyTooLargeError, type Transport } from 'viem';

/**
 * Read transport for every chain read (simulation, balances, readiness, reconciliation, intelligence, the wallet watcher). The
 * endpoints are tried in the order given: a timeout, a connection failure or an HTTP/RPC-level failure moves to the next one.
 * A contract revert is an answer, not a failure, so it is returned as is and never retried elsewhere. Broadcasting does not use
 * this; it has its own broadcasters.
 */
export const READ_TIMEOUT_MS = 15_000;

/** Scoped intelligence reads need a provider budget covering headers AND body.
 * viem's ordinary timeout ends at response headers. Keep cancellation attached
 * until the body settles, before permitting failover to another endpoint. */
function completeResponseFetch(timeoutMs: number, signal: AbortSignal, endpointIndex: number, observe?: (value: RpcReadObservation) => void): typeof fetch {
  // This closure belongs to one provider in one scoped operation. A timed-out
  // provider must not consume the same budget again for every watched chunk.
  let timedOut = false;
  return async (input, init) => {
    signal.throwIfAborted();
    if (timedOut) throw new TimeoutError({ url: String(input), body: {} });
    const started = performance.now();
    const method = observe ? diagnosticRpcMethod(init?.body) : 'other';
    let outcome: RpcReadOutcome = 'network_error';
    const controller = new AbortController();
    const abort = (): void => { controller.abort(); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    let expired = false;
    const deadline = performance.now() + timeoutMs;
    const timer = setTimeout(() => { expired = true; timedOut = true; controller.abort(); }, timeoutMs);
    const checkPublication = (): void => {
      signal.throwIfAborted();
      if (expired || performance.now() >= deadline) {
        expired = true; timedOut = true; controller.abort();
        throw new TimeoutError({ url: String(input), body: {} });
      }
    };
    try {
      const response = await fetch(input, { ...init, signal: controller.signal, redirect: 'error' });
      if (!response.body) { checkPublication(); if (observe) outcome = diagnosticRpcOutcome(response.status); return response; }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 10_485_760) {
            controller.abort();
            try { await reader.cancel(); }
            catch { await new Promise<never>(() => { /* Failed cleanup retains ownership. */ }); }
            throw new ResponseBodyTooLargeError({ maxSize: 10_485_760, size });
          }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      checkPublication();
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      if (observe) outcome = diagnosticRpcOutcome(response.status, bytes);
      const buffered = new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
      checkPublication();
      return buffered;
    } catch (error) {
      outcome = signal.aborted ? 'cancelled' : expired || performance.now() >= deadline ? 'timeout' : 'network_error';
      if (expired && !signal.aborted) throw new TimeoutError({ url: String(input), body: {} });
      throw error;
    } finally {
      clearTimeout(timer);
      controller.abort();
      signal.removeEventListener('abort', abort);
      try { observe?.({ endpointIndex, method, outcome, durationMs: Math.max(0, Math.round(performance.now() - started)) }); } catch { /* Diagnostics cannot change request outcomes. */ }
    }
  };
}

export function failoverTransport(endpoints: readonly (string | undefined)[], options: { timeoutMs?: number; signal?:AbortSignal; completeResponseTimeoutMs?: number; observe?: (value: RpcReadObservation) => void; alchemyFreeTier?: boolean } = {}): Transport {
  if (options.completeResponseTimeoutMs !== undefined && (!options.signal || !Number.isSafeInteger(options.completeResponseTimeoutMs) || options.completeResponseTimeoutMs < 1 || options.completeResponseTimeoutMs > READ_TIMEOUT_MS)) throw new Error('RPC_COMPLETE_RESPONSE_BOUNDS_INVALID');
  if (options.alchemyFreeTier && options.completeResponseTimeoutMs === undefined) throw new Error('RPC_FREE_TIER_REQUIRES_SCOPED_READ');
  const unique = [...new Set(endpoints.filter((endpoint): endpoint is string => typeof endpoint === 'string' && endpoint.length > 0))];
  if (unique.length === 0) throw new Error('RPC_ENDPOINT_UNAVAILABLE');
  const transports = unique.map((url, endpointIndex) => {
    const scopedFetch = options.completeResponseTimeoutMs === undefined ? undefined : completeResponseFetch(options.completeResponseTimeoutMs, options.signal!, endpointIndex, options.observe);
    const guardedFetch: typeof fetch | undefined = scopedFetch && options.alchemyFreeTier && isAlchemyRpcEndpoint(url) ? async (input, init) => {
      options.signal!.throwIfAborted();
      if (!alchemyFreeRequestSupported(init?.body)) throw new Error('RPC_LOG_RANGE_UNSUPPORTED');
      return scopedFetch(input, init);
    } : scopedFetch;
    return http(url, { timeout: options.timeoutMs ?? READ_TIMEOUT_MS, retryCount: 0, ...(options.signal?{fetchOptions:{signal:options.signal}}:{}), ...(options.completeResponseTimeoutMs !== undefined ? { fetchFn: guardedFetch } : {}) }); });
  return transports.length === 1 ? transports[0]! : fallback(transports, { rank: false, retryCount: 0 });
}

/**
 * Base keeps one provider apart as the INDEPENDENT second source that receipts and finality are cross-checked against (D-057).
 * The main reads fail over among the other providers only, so the cross-check never ends up asking the same provider twice.
 */
export function splitBaseEndpoints(endpoints: readonly string[]): { primary: string[]; independent: string | undefined } {
  const unique = [...new Set(endpoints.filter((endpoint) => endpoint.length > 0))];
  return { primary: unique.filter((_, index) => index !== 1), independent: unique[1] };
}
