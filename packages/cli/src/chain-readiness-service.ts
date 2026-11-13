import { BASE_PERSONAL_LIVE_FLEET_POLICY, D033_READINESS_LIMITS, ReadinessSweep, ROBINHOOD_FREE_ACTIVE_PERIOD_CAP_WEI, ROBINHOOD_FREE_PER_WALLET_CAP_WEI, type BackendStore, type IntelligenceAlertSink, type IntelligenceChainPort, type ReadinessLimits, type RedactedLogger } from '@mint-bot/backend';

/** Mirrors approved chain limits for advice, never for admission or permission to sign. */
export function chainReadinessAdvice(chainId: 8453 | 4663): { limits: ReadinessLimits; freeActivePeriodCapWei: bigint; freeMaxQuantity: number; paidAllowed: false } {
  if (chainId === 8453) return {
    limits: { ...D033_READINESS_LIMITS, freeFeeAllowanceWei: BASE_PERSONAL_LIVE_FLEET_POLICY.freeFeeAllowanceWei, paidFeeAllowanceWei: BASE_PERSONAL_LIVE_FLEET_POLICY.paidFeeAllowanceWei },
    freeActivePeriodCapWei: BASE_PERSONAL_LIVE_FLEET_POLICY.freeDailyCapWei,
    freeMaxQuantity: 4,
    paidAllowed: false,
  };
  if (chainId === 4663) return {
    limits: { ...D033_READINESS_LIMITS, freeFeeAllowanceWei: ROBINHOOD_FREE_PER_WALLET_CAP_WEI },
    freeActivePeriodCapWei: ROBINHOOD_FREE_ACTIVE_PERIOD_CAP_WEI,
    freeMaxQuantity: 10,
    paidAllowed: false,
  };
  throw new Error('READINESS_CHAIN_UNSUPPORTED');
}

/** Independent completion-driven timer: slow readiness does not hold discovery or the command loop. */
export function startChainReadiness(options: {
  store: BackendStore;
  port: IntelligenceChainPort;
  wallets(): Promise<readonly string[]>;
  enabled(): boolean;
  intervalMs: number;
  alerts?: IntelligenceAlertSink;
  logger?: Pick<RedactedLogger, 'info' | 'warn'>;
  now?: () => Date;
}): { stop(): Promise<void>; runOnce(): Promise<void> } {
  if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 15_000) throw new Error('READINESS_INTERVAL_INVALID');
  const chainId = options.port.chainId;
  if (chainId !== 8453 && chainId !== 4663) throw new Error('READINESS_CHAIN_UNSUPPORTED');
  const sweep = new ReadinessSweep(options.store, options.port, options.wallets, { ...chainReadinessAdvice(chainId), alerts: options.alerts, now: options.now });
  let stopped = false;
  let running: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const log = (level: 'info' | 'warn', fields: Record<string, unknown>): void => {
    try { options.logger?.[level]({ ...fields, chainId: options.port.chainId }, 'chain readiness advisory pass'); }
    catch { /* Logging failure cannot strand scheduling or change permission. */ }
  };
  const runOnce = async (): Promise<void> => {
    if (stopped || running) return;
    running = (async () => {
      try {
        if (!options.enabled()) return;
        const result = await sweep.tick();
        if (!stopped) log('info', { event: 'chain_readiness', ...result });
      } catch {
        if (!stopped) log('warn', { event: 'chain_readiness_failed', code: 'READINESS_UNAVAILABLE' });
      }
    })();
    try { await running; } finally { running = undefined; }
  };
  const schedule = (delay: number): void => {
    if (stopped) return;
    timer = setTimeout(() => { void runOnce().finally(() => schedule(options.intervalMs)); }, delay);
    timer.unref();
  };
  schedule(0);
  return {
    runOnce,
    async stop(): Promise<void> {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      // Drain the advisory writer before its caller closes the shared canonical store.
      await running;
    },
  };
}
