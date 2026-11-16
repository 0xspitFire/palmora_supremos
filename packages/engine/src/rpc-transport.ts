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
function completeResponseFetch(timeoutMs: number, signal: AbortSignal): typeof fetch {
  // This closure belongs to one provider in one scoped operation. A timed-out
  // provider must not consume the same budget again for every watched chunk.
  let timedOut = false;
  return async (input, init) => {
    signal.throwIfAborted();
    if (timedOut) throw new TimeoutError({ url: String(input), body: {} });
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
      if (!response.body) { checkPublication(); return response; }
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
      const buffered = new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
      checkPublication();
      return buffered;
    } catch (error) {
      if (expired && !signal.aborted) throw new TimeoutError({ url: String(input), body: {} });
      throw error;
    } finally {
      clearTimeout(timer);
      controller.abort();
      signal.removeEventListener('abort', abort);
    }
  };
}

export function failoverTransport(endpoints: readonly (string | undefined)[], options: { timeoutMs?: number; signal?:AbortSignal; completeResponseTimeoutMs?: number } = {}): Transport {
  if (options.completeResponseTimeoutMs !== undefined && (!options.signal || !Number.isSafeInteger(options.completeResponseTimeoutMs) || options.completeResponseTimeoutMs < 1 || options.completeResponseTimeoutMs > READ_TIMEOUT_MS)) throw new Error('RPC_COMPLETE_RESPONSE_BOUNDS_INVALID');
  const unique = [...new Set(endpoints.filter((endpoint): endpoint is string => typeof endpoint === 'string' && endpoint.length > 0))];
  if (unique.length === 0) throw new Error('RPC_ENDPOINT_UNAVAILABLE');
  const transports = unique.map((url) => http(url, { timeout: options.timeoutMs ?? READ_TIMEOUT_MS, retryCount: 0, ...(options.signal?{fetchOptions:{signal:options.signal}}:{}), ...(options.completeResponseTimeoutMs !== undefined ? { fetchFn: completeResponseFetch(options.completeResponseTimeoutMs, options.signal!) } : {}) }));
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
