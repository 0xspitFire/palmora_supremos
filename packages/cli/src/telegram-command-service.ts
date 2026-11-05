import type { AlertManager, IntelligenceAlertInput } from '@mint-bot/backend';
import { TelegramRequestError, type TelegramBotApi, type TelegramUpdate } from './telegram-api.js';
import { isStopUpdate, type TelegramCommandRouter } from './telegram-commands.js';

/**
 * T-061 (D-063 item 1): the service fetches the bot's new messages itself (long polling, outbound only). Each update's offset is
 * saved BEFORE the update is handled, so a crash in the middle never runs the same command twice; at worst it is not run, and
 * the owner sends it again.
 */
export interface PollOffsetStore { pollOffset(): number; savePollOffset(offset: number): void }

export function startTelegramCommands(options: {
  api: TelegramBotApi;
  offsets: PollOffsetStore;
  router: Pick<TelegramCommandRouter, 'handle' | 'checkSession' | 'onStart'> & { registerMenus?(): Promise<void>; cleanSensitive?(update: TelegramUpdate): Promise<void> };
  log(event: string, fields?: Record<string, unknown>): void;
  pollTimeoutSeconds?: number;
  retryDelayMs?: number;
  workers?: number;
}): { stop(): void; pollOnce(): Promise<void>; done: Promise<void> } {
  let running = true;
  let failedPolls = 0;
  let wakeRetry: (() => void) | undefined;
  const pollTimeout = options.pollTimeoutSeconds ?? 25;
  const retryDelay = options.retryDelayMs ?? 5_000;
  const workers = options.workers ?? 4;
  const handle = async (update: TelegramUpdate): Promise<void> => {
    try { await options.router.handle(update); }
    catch (error) { options.log('telegram_command_failed', { code: error instanceof Error && /^[A-Z][A-Z0-9_]+/.test(error.message) ? error.message.split(':')[0] : 'FAILED' }); }
  };
  // Stop commands are handled inside the polling loop at once. Everything else waits for one of a few workers, so a slow chain
  // read can never hold up a /kill (D-063 item 4); the router refuses anything that waited more than five minutes.
  const queue: TelegramUpdate[] = [];
  let busy = 0;
  const drain = (): void => {
    while (busy < workers && queue.length > 0) {
      const next = queue.shift()!;
      busy += 1;
      void handle(next).finally(() => { busy -= 1; drain(); });
    }
  };
  const pollOnce = async (): Promise<void> => {
    try { await options.router.checkSession(); } catch { options.log('telegram_session_check_failed'); }
    const updates = await options.api.getUpdates(options.offsets.pollOffset(), pollTimeout);
    for (const update of [...updates].sort((left, right) => left.update_id - right.update_id)) {
      if (!Number.isSafeInteger(update.update_id) || update.update_id + 1 <= options.offsets.pollOffset()) continue;
      options.offsets.savePollOffset(update.update_id + 1);
      // Start code cleanup before ordinary workers can queue it behind slow RPC work. Do not await it here:
      // bounded transport retries must not postpone a /kill or the next poll. The router shares this work with handle().
      void options.router.cleanSensitive?.(update).catch(() => options.log('telegram_sensitive_cleanup_failed'));
      if (isStopUpdate(update)) await handle(update);
      else { queue.push(update); drain(); }
    }
  };
  const done = (async () => {
    try { await options.router.onStart(); } catch { options.log('telegram_start_notice_failed'); }
    try { await options.router.registerMenus?.(); } catch { options.log('telegram_menu_failed'); }
    while (running) {
      try { await pollOnce(); failedPolls = 0; }
      catch (error) {
        failedPolls = Math.min(failedPolls + 1, 4);
        const backoffMs = Math.min(Math.max(30_000, retryDelay), retryDelay * 2 ** (failedPolls - 1));
        const waitMs = Math.max(backoffMs, error instanceof TelegramRequestError ? error.retryAfterMs ?? 0 : 0);
        options.log('telegram_poll_failed', { code: error instanceof Error && /^[A-Z][A-Z0-9_:]+$/.test(error.message) ? error.message : 'FAILED', ...(error instanceof TelegramRequestError ? { reason: error.reason } : {}), retryInMs: waitMs });
        if (running) await new Promise<void>((resolve) => {
          const timer = setTimeout(() => { wakeRetry = undefined; resolve(); }, waitMs);
          timer.unref?.();
          wakeRetry = () => { clearTimeout(timer); wakeRetry = undefined; resolve(); };
        });
      }
    }
  })();
  return { stop: () => { running = false; wakeRetry?.(); }, pollOnce, done };
}

/** D-063 item 8: viewers receive opportunity and opening-soon alerts. These alerts never name the owner's wallets. */
export const VIEWER_ALERT_KINDS: ReadonlySet<IntelligenceAlertInput['kind']> = new Set(['opportunity', 'opening_soon']);

export function withViewerFanout(alerts: AlertManager, send: (text: string) => Promise<void>): AlertManager {
  return new Proxy(alerts, {
    get(target, property, receiver) {
      if (property === 'intelligence') {
        return async (input: IntelligenceAlertInput): Promise<boolean> => {
          const recorded = await target.intelligence(input);
          // Sent alongside, never awaited: viewer delivery can never slow or fail the owner's alert.
          if (recorded && VIEWER_ALERT_KINDS.has(input.kind)) void send(input.text).catch(() => undefined);
          return recorded;
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}
