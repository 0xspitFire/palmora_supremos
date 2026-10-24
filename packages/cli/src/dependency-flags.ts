import { unresolvedRunIds, type BackendStore } from '@mint-bot/backend';

/**
 * T-070 (D-068): the host service sets its own deployment-readiness flags from real checks. Before this, nothing in host mode ever
 * turned `engine`, `chain` and `notifications` on, so every live run stopped at DEPLOYMENT_DEPENDENCIES_NOT_READY. (`backup` is set
 * by the orchestrator tick from the backup status check it already makes.)
 *
 * Fail closed: a check that fails, times out or throws turns its flag off at once and blocks the run state with
 * DEPLOYMENT_DEPENDENCIES_NOT_READY. The flags only gate; every other guard (approval, test mints, caps, reservations, the Turnkey
 * policy, the watcher, the kill switch) is unchanged and still applies at arm and run. Nothing here signs or sends.
 */
export interface DependencyFlagDeps {
  store: Pick<BackendStore, 'snapshot' | 'transaction'>;
  /** The signing setup loads: Turnkey secret config readable with the required file permissions. Local checks only. */
  engineReady(): Promise<boolean>;
  /** The Telegram notifier answers its health check. */
  notificationsReady(): Promise<boolean>;
  /** Chains whose RPC must answer: Ethereum and every chain with valid accepted execution evidence. */
  chainsToProbe(): number[];
  /** Timestamp of the chain's latest block. */
  latestBlockTime(chainId: number): Promise<Date>;
  killSwitchOn(): Promise<boolean>;
  now(): Date;
  log?(event: string, fields?: Record<string, unknown>): void;
}

export const BLOCK_MAX_AGE_MS = 180_000;
/** A quiet chain may go minutes between blocks. Robinhood's sequencer only seals a block when it has work, so it gets a longer limit. */
export const BLOCK_MAX_AGE_BY_CHAIN_MS: Readonly<Record<number, number>> = { 4663: 900_000 };
/** A Telegram blip must not block an armed run: notifications turn off only after this many failed checks in a row (90 s). Engine and chain are never delayed. */
export const NOTIFICATION_FAILURES_BEFORE_OFF = 3;
export const BLOCK_MAX_FUTURE_MS = 120_000;
const PROBE_TIMEOUT_MS = 10_000;
const REASON = 'DEPLOYMENT_DEPENDENCIES_NOT_READY';

function within<T>(work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('PROBE_TIMED_OUT')), PROBE_TIMEOUT_MS); timer.unref?.(); });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}
const passes = async (check: () => Promise<boolean>): Promise<boolean> => { try { return (await within(check())) === true; } catch { return false; } };

/** An unreadable kill state counts as killed (fail closed): the block is never lifted on a guess. */
const killSwitchUnknownOrOn = async (deps: DependencyFlagDeps): Promise<boolean> => { try { return (await within(deps.killSwitchOn())) !== false; } catch { return true; } };

export interface DependencyFlagResult { engine: boolean; chain: boolean; notifications: boolean }

export function createDependencyFlags(deps: DependencyFlagDeps): { tick(): Promise<DependencyFlagResult> } {
  const chainReady = async (): Promise<boolean> => {
    let chains: number[];
    try { chains = [...new Set([1, ...deps.chainsToProbe()])]; } catch { return false; }
    const results = await Promise.all(chains.map((chainId) => passes(async () => {
      const at = (await deps.latestBlockTime(chainId)).getTime();
      const now = deps.now().getTime();
      return Number.isFinite(at) && now - at <= (BLOCK_MAX_AGE_BY_CHAIN_MS[chainId] ?? BLOCK_MAX_AGE_MS) && at - now <= BLOCK_MAX_FUTURE_MS;
    })));
    return results.every(Boolean);
  };
  let notificationFailures = 0;
  const write = async (flags: DependencyFlagResult, killed: boolean): Promise<boolean> => {
    let changed = false;
    await deps.store.transaction((state) => {
      const next = { ...state.runtime.dependencies, ...flags };
      changed = next.engine !== state.runtime.dependencies.engine || next.chain !== state.runtime.dependencies.chain || next.notifications !== state.runtime.dependencies.notifications;
      const ready = Object.values(next).every(Boolean);
      const hadReason = state.runtime.blockingReasons.includes(REASON);
      const others = state.runtime.blockingReasons.filter((reason) => reason !== REASON);
      if (!ready) {
        state.runtime = { ...state.runtime, dependencies: next, startupState: 'Blocked', blockingReasons: [...new Set([...others, REASON])] };
        return;
      }
      // Lifted only when this probe caused the block and nothing else blocks: no other reason, no kill (stored, file or unreadable),
      // reconciliation done, no unresolved run. Otherwise its reason stays, so the block never loses its explanation.
      const clear = hadReason && state.runtime.startupState === 'Blocked' && others.length === 0 && !state.killed && !killed && state.runtime.reconciliationCompletedAt !== undefined && unresolvedRunIds(state).length === 0;
      state.runtime = clear ? { ...state.runtime, dependencies: next, blockingReasons: others, startupState: 'Ready' } : { ...state.runtime, dependencies: next };
    });
    return changed;
  };
  return {
    async tick() {
      let flags: DependencyFlagResult;
      let killed = true;
      try {
        const [engine, chain, notifications, killState] = await Promise.all([passes(deps.engineReady), chainReady(), passes(deps.notificationsReady), killSwitchUnknownOrOn(deps)]);
        notificationFailures = notifications ? 0 : notificationFailures + 1;
        // Hysteresis for notifications only: stay on until the third failed check in a row (but an off flag only turns on when a check passes).
        const wasOn = deps.store.snapshot().runtime.dependencies.notifications === true;
        flags = { engine, chain, notifications: notifications || (wasOn && notificationFailures < NOTIFICATION_FAILURES_BEFORE_OFF) };
        killed = killState;
      } catch {
        // The probe itself failed: everything it controls goes off (fail closed).
        flags = { engine: false, chain: false, notifications: false };
        notificationFailures = NOTIFICATION_FAILURES_BEFORE_OFF;
      }
      const changed = await write(flags, killed);
      // The kill file is read again after a lift, so a kill created during the pass is not missed (as the orchestrator tick does).
      if (deps.store.snapshot().runtime.startupState === 'Ready' && await killSwitchUnknownOrOn(deps)) {
        await deps.store.transaction((state) => { state.runtime = { ...state.runtime, startupState: 'Blocked', blockingReasons: [...new Set([...state.runtime.blockingReasons, 'KILL_SWITCH_ENGAGED'])] }; });
      }
      if (changed) deps.log?.('dependency_flags_changed', { ...flags });
      return flags;
    },
  };
}

export function startDependencyFlags(deps: DependencyFlagDeps, options: { intervalMs?: number; onError?: (error: unknown) => void } = {}): { stop(): void; tick(): Promise<DependencyFlagResult | undefined> } {
  const flags = createDependencyFlags(deps);
  let busy = false;
  const tick = async (): Promise<DependencyFlagResult | undefined> => {
    if (busy) return undefined;
    busy = true;
    try { return await flags.tick(); } catch (error) { options.onError?.(error); return undefined; } finally { busy = false; }
  };
  void tick();
  const timer = setInterval(() => { void tick(); }, options.intervalMs ?? 30_000);
  timer.unref?.();
  return { stop: () => clearInterval(timer), tick };
}
