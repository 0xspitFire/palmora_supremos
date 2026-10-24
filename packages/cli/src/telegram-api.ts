import type { TelegramFetcher } from '@mint-bot/backend';

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
}

const MAX_TEXT = 4_000;

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
    let response;
    // A network error can carry the request address, which holds the token: only a fixed code leaves this function.
    try { response = await fetcher(`${base}/bot${options.token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(timeout) }); }
    catch { throw new Error(`TELEGRAM_${method.toUpperCase()}_UNREACHABLE`); }
    if (!response.ok) throw new Error(`TELEGRAM_${method.toUpperCase()}_FAILED:${response.status}`);
    let body: unknown;
    try { body = await response.json(); } catch { throw new Error('TELEGRAM_RESPONSE_INVALID'); }
    if (!body || typeof body !== 'object' || (body as { ok?: unknown }).ok !== true) throw new Error(`TELEGRAM_${method.toUpperCase()}_REJECTED`);
    return (body as { result?: unknown }).result;
  };
  return {
    async getUpdates(offset, timeoutSeconds) {
      const result = await call('getUpdates', { offset, timeout: timeoutSeconds, allowed_updates: ['message', 'callback_query'] }, (timeoutSeconds + 10) * 1_000);
      return Array.isArray(result) ? result as TelegramUpdate[] : [];
    },
    async sendMessage(chatId, text, buttons) {
      await call('sendMessage', { chat_id: chatId, text: text.slice(0, MAX_TEXT), disable_web_page_preview: true, ...(buttons && buttons.length > 0 ? { reply_markup: { inline_keyboard: buttons } } : {}) });
    },
    async answerCallback(callbackId, text) {
      await call('answerCallbackQuery', { callback_query_id: callbackId, ...(text ? { text: text.slice(0, 190) } : {}) });
    },
    async deleteMessage(chatId, messageId) {
      await call('deleteMessage', { chat_id: chatId, message_id: messageId });
    },
  };
}
