import type { TelegramFetcher } from '@mint-bot/backend';
import { toCopyableHtml } from './telegram-format.js';

/**
 * T-061 (D-063 item 1): the parts of the Telegram Bot API the command service uses. Every call is made by the service (outbound);
 * no port is opened. The token stays in this object and is never logged or returned.
 */
export interface TelegramUser { id: number; is_bot?: boolean; username?: string; first_name?: string }
export interface TelegramChat { id: number; type: string }
export interface TelegramMessage { message_id: number; date: number; chat: TelegramChat; from?: TelegramUser; text?: string }
export interface TelegramCallbackQuery { id: string; from: TelegramUser; data?: string; message?: TelegramMessage }
export interface TelegramUpdate { update_id: number; message?: TelegramMessage; callback_query?: TelegramCallbackQuery }
export interface InlineButton { text: string; callback_data: string }

export interface TelegramBotApi {
  getUpdates(offset: number, timeoutSeconds: number): Promise<TelegramUpdate[]>;
  sendMessage(chatId: number | string, text: string, buttons?: InlineButton[][]): Promise<void>;
  answerCallback(callbackId: string, text?: string): Promise<void>;
  deleteMessage(chatId: number | string, messageId: number): Promise<void>;
  /** T-066: the command menu Telegram shows. Without a chat it sets the default list for every private chat. */
  setMyCommands?(commands: BotCommand[], chatId?: number | string): Promise<void>;
  deleteMyCommands?(chatId: number | string): Promise<void>;
}

export interface BotCommand { command: string; description: string }

const MAX_TEXT = 4_000;
const MAX_FORMATTED = 4_096;

export type TelegramFailureReason = 'TIMEOUT' | 'DNS' | 'CONNECT' | 'TLS' | 'NETWORK' | 'RESPONSE_INVALID' | 'RATE_LIMITED' | 'FORBIDDEN' | 'BAD_REQUEST' | 'SERVER' | 'REJECTED';
/** Only fixed classifications cross this boundary; never expose fetch errors, URLs or Telegram descriptions. */
export class TelegramRequestError extends Error {
  constructor(code: string, public readonly reason: TelegramFailureReason, public readonly retryAfterMs?: number) { super(code); this.name = 'TelegramRequestError'; }
}
function networkReason(error: unknown): TelegramFailureReason {
  const value = error as { name?: unknown; code?: unknown; cause?: { code?: unknown } } | undefined;
  if (value?.name === 'TimeoutError' || value?.name === 'AbortError') return 'TIMEOUT';
  const code = value?.cause?.code ?? value?.code;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'DNS';
  if (code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT') return 'TIMEOUT';
  if (code === 'ECONNREFUSED' || code === 'ENETUNREACH' || code === 'EHOSTUNREACH') return 'CONNECT';
  if (code === 'CERT_HAS_EXPIRED' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || code === 'DEPTH_ZERO_SELF_SIGNED_CERT') return 'TLS';
  return 'NETWORK';
}
const pause = async (milliseconds: number): Promise<void> => new Promise(resolve => setTimeout(resolve, milliseconds));

export function createTelegramBotApi(options: { token: string; apiBaseUrl?: string; approvedProxy?: string; fetcher?: TelegramFetcher; timeoutMs?: number }): TelegramBotApi {
  if (!options.token || /\s/.test(options.token)) throw new Error('TELEGRAM_TOKEN_INVALID');
  const base = (options.apiBaseUrl ?? 'https://api.telegram.org').replace(/\/$/, '');
  let endpoint: URL;
  try { endpoint = new URL(base); } catch { throw new Error('TELEGRAM_API_BASE_URL_INVALID'); }
  if (endpoint.protocol !== 'https:') {
    if (!options.approvedProxy || options.approvedProxy !== base) throw new Error('TELEGRAM_HTTPS_OR_APPROVED_PROXY_REQUIRED');
    if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)) throw new Error('TELEGRAM_APPROVED_PROXY_MUST_BE_LOOPBACK');
  }
  const fetcher = options.fetcher ?? (globalThis.fetch as unknown as TelegramFetcher);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const call = async (method: string, payload: Record<string, unknown>, timeout = timeoutMs): Promise<unknown> => {
    let retryWaitMs = 0;
    const deleting = method === 'deleteMessage';
    for (let attempt = 0; ; attempt += 1) {
      let response;
      try { response = await fetcher(`${base}/bot${options.token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(timeout) }); }
      catch (error) {
        const reason = networkReason(error);
        // Deleting this exact message again is safe even if the first response was lost. Never retry an ambiguous send.
        if (deleting && attempt < 2 && reason !== 'TLS') { await pause(250 * (attempt + 1)); continue; }
        throw new TelegramRequestError(`TELEGRAM_${method.toUpperCase()}_UNREACHABLE`, reason);
      }
      let body: unknown;
      try { body = await response.json(); } catch { body = undefined; }
      const result = body && typeof body === 'object' ? body as { ok?: unknown; result?: unknown; description?: unknown; parameters?: { retry_after?: unknown } } : undefined;
      if (!response.ok) {
        // The only accepted non-success deletion response is this exact already-absent result, never a permission error.
        if (deleting && response.status === 400 && result?.ok === false && result.description === 'Bad Request: message to delete not found') return true;
        if (response.status === 429) {
          const seconds = result?.parameters?.retry_after;
          const retryAfterMs = typeof seconds === 'number' && Number.isSafeInteger(seconds) && seconds > 0 && seconds <= 7 * 24 * 3600 ? seconds * 1_000 : undefined;
          if (retryAfterMs !== undefined && attempt < 2 && retryWaitMs + retryAfterMs <= 15_000) {
            retryWaitMs += retryAfterMs;
            await pause(retryAfterMs);
            continue;
          }
          throw new TelegramRequestError(`TELEGRAM_${method.toUpperCase()}_FAILED:429`, 'RATE_LIMITED', retryAfterMs);
        }
        if (deleting && response.status >= 500 && response.status <= 599 && attempt < 2) { await pause(250 * (attempt + 1)); continue; }
        const reason = response.status === 403 ? 'FORBIDDEN' : response.status === 400 ? 'BAD_REQUEST' : response.status >= 500 && response.status <= 599 ? 'SERVER' : 'REJECTED';
        throw new TelegramRequestError(`TELEGRAM_${method.toUpperCase()}_FAILED:${response.status}`, reason);
      }
      if (!result) {
        if (deleting && attempt < 2) { await pause(250 * (attempt + 1)); continue; }
        throw new TelegramRequestError('TELEGRAM_RESPONSE_INVALID', 'RESPONSE_INVALID');
      }
      if (result.ok !== true) throw new TelegramRequestError(`TELEGRAM_${method.toUpperCase()}_REJECTED`, 'REJECTED');
      if (deleting && result.result !== true) {
        if (attempt < 2) { await pause(250 * (attempt + 1)); continue; }
        throw new TelegramRequestError('TELEGRAM_RESPONSE_INVALID', 'RESPONSE_INVALID');
      }
      return result.result;
    }
  };
  return {
    async getUpdates(offset, timeoutSeconds) {
      const result = await call('getUpdates', { offset, timeout: timeoutSeconds, allowed_updates: ['message', 'callback_query'] }, (timeoutSeconds + 10) * 1_000);
      return Array.isArray(result) ? result as TelegramUpdate[] : [];
    },
    async sendMessage(chatId, text, buttons) {
      const plain = text.slice(0, MAX_TEXT);
      const extra = { chat_id: chatId, disable_web_page_preview: true, ...(buttons && buttons.length > 0 ? { reply_markup: { inline_keyboard: buttons } } : {}) };
      // T-069: copy-friendly formatting. A reply is never lost: if the formatted version is too long or Telegram refuses it (400), the plain text is sent.
      const html = toCopyableHtml(plain);
      if (html.length <= MAX_FORMATTED) {
        try { await call('sendMessage', { ...extra, text: html, parse_mode: 'HTML' }); return; }
        catch (error) { if (!(error instanceof Error) || !error.message.endsWith(':400')) throw error; }
      }
      await call('sendMessage', { ...extra, text: plain });
    },
    async answerCallback(callbackId, text) {
      await call('answerCallbackQuery', { callback_query_id: callbackId, ...(text ? { text: text.slice(0, 190) } : {}) });
    },
    async deleteMessage(chatId, messageId) {
      await call('deleteMessage', { chat_id: chatId, message_id: messageId });
    },
    async setMyCommands(commands, chatId) {
      const valid = commands.filter((item) => /^[a-z0-9_]{1,32}$/.test(item.command) && item.description.length >= 1).slice(0, 100).map((item) => ({ command: item.command, description: item.description.slice(0, 256) }));
      await call('setMyCommands', { commands: valid, ...(chatId === undefined ? { scope: { type: 'all_private_chats' } } : { scope: { type: 'chat', chat_id: chatId } }) });
    },
    async deleteMyCommands(chatId) {
      await call('deleteMyCommands', { scope: { type: 'chat', chat_id: chatId } });
    },
  };
}
