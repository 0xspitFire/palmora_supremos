import type { AlertManager, IntelligenceAlertInput } from '@mint-bot/backend';
import type { TelegramBotApi, TelegramUpdate } from './telegram-api.js';
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
  router: Pick<TelegramCommandRouter, 'handle' | 'checkSession' | 'onStart'>;
  log(event: string, fields?: Record<string, unknown>): void;
  pollTimeoutSeconds?: number;
  retryDelayMs?: number;
  workers?: number;
}): { stop(): void; pollOnce(): Promise<void>; done: Promise<void> } {
  let running = true;
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
      if (isStopUpdate(update)) await handle(update);
      else { queue.push(update); drain(); }
    }
  };
  const done = (async () => {
    try { await options.router.onStart(); } catch { options.log('telegram_start_notice_failed'); }
    while (running) {
      try { await pollOnce(); }
      catch (error) {
        options.log('telegram_poll_failed', { code: error instanceof Error && /^[A-Z][A-Z0-9_:]+$/.test(error.message) ? error.message : 'FAILED' });
        if (running) await new Promise((resolve) => setTimeout(resolve, retryDelay).unref?.());
      }
    }
  })();
  return { stop: () => { running = false; }, pollOnce, done };
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
