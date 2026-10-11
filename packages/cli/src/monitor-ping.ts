/**
 * "I am alive" signal to an outside monitor (for example Healthchecks.io). A frozen or sleeping bot cannot warn anyone
 * itself; the monitor alerts when the signals stop. The ping address is a secret: anyone holding it could fake a signal,
 * so it is never logged and never put in an error message.
 */
export type MonitorStatus = 'ok' | 'fail';

export type MonitorPing = (status: MonitorStatus) => Promise<void>;

/** Returns a clean https address, or undefined when the value is missing, not https, or carries a login. */
export function validMonitorUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) return undefined;
    return url.toString().replace(/\/+$/, '');
  } catch { return undefined; }
}

export function createMonitorPing(address: string, options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): MonitorPing {
  const base = validMonitorUrl(address);
  if (!base) throw new Error('MONITOR_URL_INVALID');
  const send = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  return async (status) => {
    let response: Response;
    try {
      response = await send(status === 'ok' ? base : `${base}/fail`, { method: 'GET', signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    } catch { throw new Error('MONITOR_PING_FAILED'); }
    if (!response.ok) throw new Error(`MONITOR_PING_FAILED_${response.status}`);
  };
}
