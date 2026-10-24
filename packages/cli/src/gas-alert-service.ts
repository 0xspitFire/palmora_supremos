import type { GasAlertRow } from '@mint-bot/database';

/**
 * T-066: checks the owner's fee alerts. It only reads each chain's current gas price and messages the owner when a price crosses a
 * threshold; it never signs, sends or changes a limit. An alert fires once when the price crosses and again only after it has gone
 * back across (a restart can repeat one alert that is already true, which is harmless).
 */
export interface GasAlertDeps {
  alerts(): GasAlertRow[];
  /** Current gas price of a chain in gwei, or undefined when it cannot be read. */
  gasGwei(chainId: number): Promise<number | undefined>;
  alert(text: string, dedupe: string): Promise<void>;
  now?(): Date;
  log?(event: string, fields?: Record<string, unknown>): void;
  /** Longest wait for one price (default 15 s). */
  readTimeoutMs?: number;
  /** Least time between two messages for the same alert (default 10 minutes). */
  minGapMs?: number;
}

const CHAIN_NAMES: Record<number, string> = { 1: 'Ethereum', 8453: 'Base', 4663: 'Robinhood' };
export const gasAlertSentence = (alert: Pick<GasAlertRow, 'chainId' | 'direction' | 'thresholdGwei'>): string => `${CHAIN_NAMES[alert.chainId] ?? `chain ${alert.chainId}`} fees ${alert.direction} ${alert.thresholdGwei} gwei`;

export function createGasAlertChecker(deps: GasAlertDeps): { tick(): Promise<number> } {
  const crossed = new Map<string, boolean>();
  const lastSent = new Map<string, number>();
  const minGap = deps.minGapMs ?? 600_000;
  const readTimeout = deps.readTimeoutMs ?? 15_000;
  return {
    async tick(): Promise<number> {
      const alerts = deps.alerts();
      const prices = new Map<number, number | undefined>();
      let sent = 0;
      for (const alert of alerts) {
        if (!prices.has(alert.chainId)) prices.set(alert.chainId, await Promise.race([deps.gasGwei(alert.chainId), new Promise<undefined>((resolve) => { const timer = setTimeout(() => resolve(undefined), readTimeout); timer.unref?.(); })]).catch(() => undefined));
        const price = prices.get(alert.chainId);
        // A price that could not be read changes nothing: no alert and no reset.
        if (price === undefined || !Number.isFinite(price)) continue;
        const threshold = Number(alert.thresholdGwei);
        const isCrossed = alert.direction === 'below' ? price < threshold : price > threshold;
        const was = crossed.get(alert.id) ?? false;
        if (!isCrossed) { crossed.set(alert.id, false); continue; }
        if (was) continue;
        const at = (deps.now?.() ?? new Date()).getTime();
        // A price that keeps flapping across the line is told at most once per gap, with one stable key per gap, so the log cannot grow fast.
        if (at - (lastSent.get(alert.id) ?? Number.NEGATIVE_INFINITY) < minGap) { crossed.set(alert.id, true); continue; }
        try { await deps.alert(`Fee alert: ${gasAlertSentence(alert)}. Now ${price.toFixed(4)} gwei.`, `gas-alert:${alert.id}:${Math.floor(at / Math.max(minGap, 1))}`); lastSent.set(alert.id, at); crossed.set(alert.id, true); sent += 1; }
        // A delivery that failed is tried again on the next pass.
        catch { deps.log?.('gas_alert_delivery_failed'); }
      }
      // Alerts the owner removed no longer need their state.
      const live = new Set(alerts.map((alert) => alert.id));
      for (const id of [...crossed.keys()]) if (!live.has(id)) { crossed.delete(id); lastSent.delete(id); }
      return sent;
    },
  };
}

export function startGasAlerts(deps: GasAlertDeps, options: { intervalMs?: number } = {}): { stop(): void; tick(): Promise<number> } {
  const checker = createGasAlertChecker(deps);
  let busy = false;
  const tick = async (): Promise<number> => {
    if (busy) return 0;
    busy = true;
    try { return await checker.tick(); } catch { deps.log?.('gas_alert_tick_failed'); return 0; } finally { busy = false; }
  };
  const timer = setInterval(() => { void tick(); }, options.intervalMs ?? 60_000);
  timer.unref?.();
  return { stop: () => clearInterval(timer), tick };
}
