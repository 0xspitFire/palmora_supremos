import { fallback, http, type Transport } from 'viem';

/**
 * Read transport for every chain read (simulation, balances, readiness, reconciliation, intelligence, the wallet watcher). The
 * endpoints are tried in the order given: a timeout, a connection failure or an HTTP/RPC-level failure moves to the next one.
 * A contract revert is an answer, not a failure, so it is returned as is and never retried elsewhere. Broadcasting does not use
 * this; it has its own broadcasters.
 */
export const READ_TIMEOUT_MS = 15_000;

export function failoverTransport(endpoints: readonly (string | undefined)[], options: { timeoutMs?: number } = {}): Transport {
  const unique = [...new Set(endpoints.filter((endpoint): endpoint is string => typeof endpoint === 'string' && endpoint.length > 0))];
  if (unique.length === 0) throw new Error('RPC_ENDPOINT_UNAVAILABLE');
  const transports = unique.map((url) => http(url, { timeout: options.timeoutMs ?? READ_TIMEOUT_MS, retryCount: 0 }));
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
