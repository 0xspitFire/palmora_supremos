import type { AdvancedIntelligencePort, AdvancedIntelligenceSnapshot, FeatureContext, IntelligenceChainId, SourcedFact } from '@mint-bot/backend';

export interface AdvancedReadContext { chainId: IntelligenceChainId; contract: string; now: Date; signal: AbortSignal; consumeRpc(count?: number): void; }
export interface AdvancedIntelligenceReaders {
  /** Real readers are composed from existing approved transports; no arbitrary URL comes from collection metadata. */
  trustedOrigin: 'approved-rpc' | 'https://api.opensea.io' | 'https://api.blockscout.com' | 'https://sourcify.dev';
  floor?(context: AdvancedReadContext): Promise<SourcedFact<{ floorWei: string; feePerNftWei: string }> | undefined>;
  contractCreatedAt?(context: AdvancedReadContext): Promise<SourcedFact<string> | undefined>;
  sourceVerified?(context: AdvancedReadContext): Promise<SourcedFact<boolean> | undefined>;
  demand?(context: AdvancedReadContext): Promise<SourcedFact<{ distinctPayers: number; mintCount: number }> | undefined>;
}

/** Queue-only discovery facade, separately scheduled bounded reads, and no signing/funding authority. */
export function createAdvancedIntelligenceProvider(options: { readers: readonly AdvancedIntelligenceReaders[]; now?: () => Date; timeoutMs?: number; rpcBudget?: number; maxPerTick?: number }) {
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? 2000; const rpcBudget = options.rpcBudget ?? 16; const maxPerTick = options.maxPerTick ?? 4;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 10_000 || !Number.isSafeInteger(rpcBudget) || rpcBudget < 1 || rpcBudget > 64 || !Number.isSafeInteger(maxPerTick) || maxPerTick < 1 || maxPerTick > 8 || options.readers.length > 4 || options.readers.some(reader => !['approved-rpc', 'https://api.opensea.io', 'https://api.blockscout.com', 'https://sourcify.dev'].includes(reader.trustedOrigin))) throw new Error('ADVANCED_PROVIDER_CONFIGURATION_INVALID');
  const pending = new Map<string, FeatureContext>();
  const cache = new Map<string, { value: AdvancedIntelligenceSnapshot; refreshedAt: number }>();
  const retryAt = new Map<string, number>();
  const key = (context: FeatureContext) => `${context.chainId}:${context.contract.toLowerCase()}`;
  let stopped = false; let running: Promise<void> | undefined; let timer: ReturnType<typeof setTimeout> | undefined;
  const validContext = (context: FeatureContext) => [1, 8453, 4663].includes(context.chainId) && /^0x[0-9a-f]{40}$/i.test(context.contract) && Number.isFinite(context.now.getTime());
  const request = (context: FeatureContext): void => {
    if (stopped || !validContext(context)) return;
    const identity = key(context); const at = now().getTime();
    if ((cache.get(identity)?.refreshedAt ?? -Infinity) + 60_000 > at || (retryAt.get(identity) ?? 0) > at || pending.has(identity)) return;
    pending.set(identity, { ...context, watchedWallets: [...context.watchedWallets].slice(0, 100) });
    if (pending.size > 64) pending.delete(pending.keys().next().value!);
  };
  const snapshot: AdvancedIntelligencePort['snapshot'] = context => {
    if (!validContext(context)) return undefined;
    const hit = cache.get(key(context));
    return hit ? structuredClone(hit.value) : undefined;
  };
  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    running = (async () => {
      for (const [identity, context] of [...pending.entries()].slice(0, maxPerTick)) {
        pending.delete(identity);
        if (stopped) break;
        const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
        let remaining = rpcBudget;
        const readContext: AdvancedReadContext = { chainId: context.chainId, contract: context.contract, now: now(), signal: controller.signal, consumeRpc(count = 1) { if (!Number.isSafeInteger(count) || count < 1 || count > remaining) throw new Error('ADVANCED_RPC_BUDGET_EXHAUSTED'); remaining -= count; } };
        const value: AdvancedIntelligenceSnapshot = { version: 'advanced-facts-v1', chainId: context.chainId, contract: context.contract };
        try {
          const read = async () => {
            for (const readers of options.readers) {
              for (const field of ['floor', 'contractCreatedAt', 'sourceVerified', 'demand'] as const) {
                if (controller.signal.aborted) return;
                const reader = readers[field];
                if (!reader) continue;
                // The first reader is not allowed to overwrite a different source's
                // contradictory fact. A conflict makes that factor unavailable.
                try {
                  const fact = await reader(readContext);
                  if (!fact) continue;
                  const existing = value[field];
                  if (existing && JSON.stringify(existing.value) !== JSON.stringify(fact.value)) { delete value[field]; conflicts.add(field); }
                  else if (!conflicts.has(field)) Object.assign(value, { [field]: fact });
                } catch { /* uncovered source stays unknown, never false/zero */ }
              }
            }
          };
          const conflicts = new Set<string>();
          await Promise.race([read(), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('ADVANCED_PROVIDER_TIMEOUT')); }, timeoutMs); })]);
          if (!stopped && !controller.signal.aborted) {
            cache.set(identity, { value: structuredClone(value), refreshedAt: now().getTime() });
            if (cache.size > 500) cache.delete(cache.keys().next().value!);
          }
        } catch { retryAt.set(identity, now().getTime() + 60_000); }
        finally { if (timer) clearTimeout(timer); controller.abort(); }
        if (retryAt.size > 500) retryAt.delete(retryAt.keys().next().value!);
      }
    })();
    try { await running; } finally { running = undefined; }
  };
  const start = (intervalMs = 30_000): void => {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 15_000 || intervalMs > 300_000) throw new Error('ADVANCED_PROVIDER_INTERVAL_INVALID');
    if (stopped || timer) return;
    const schedule = () => { if (stopped) return; timer = setTimeout(() => { void tick().finally(schedule); }, intervalMs); timer.unref(); };
    schedule();
  };
  return { request, snapshot, tick, start, async stop() { stopped = true; if (timer) clearTimeout(timer); await running; }, diagnostics() { return { queued: pending.size, cached: cache.size, running: running !== undefined, liveActivation: false }; } };
}
