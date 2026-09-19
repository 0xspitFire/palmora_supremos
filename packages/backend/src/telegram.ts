import { lstat, readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { redactText } from './observability.js';
import type { NotificationSink } from './notifications.js';

export interface HostSecretStore { has(name: string): boolean; get(name: string): string | undefined; }
export interface TelegramCredentials { token: string; chatId: string; }
export interface TelegramFetcherResponse { ok: boolean; status: number; json(): Promise<unknown>; }
export type TelegramFetcher = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<TelegramFetcherResponse>;
export interface TelegramHealth { status: 'ok' | 'failed'; provider: 'telegram'; reason?: string; }
export interface TelegramNotifierOptions { secretStore: HostSecretStore; tokenName?: string; chatIdName?: string; apiBaseUrl?: string; approvedProxy?: string; fetcher?: TelegramFetcher; timeoutMs?: number; }

function parseStore(source: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) throw new Error('SECRET_STORE_ENTRY_INVALID');
    const name = trimmed.slice(0, separator).trim();
    const raw = trimmed.slice(separator + 1).trim();
    if (!/^[A-Z][A-Z0-9_]*$/.test(name) || values.has(name) || !raw) throw new Error('SECRET_STORE_ENTRY_INVALID');
    values.set(name, raw.replace(/^['"]|['"]$/g, ''));
  }
  return values;
}

export async function loadHostSecretStore(path: string): Promise<HostSecretStore> {
  const absolutePath = resolve(path);
  const approvedFiles = new Set(['MINT_BOT_SECRETS', 'MINT_BOT_SECRETS.env', 'TEST_BOT', 'TEST_BOT.env', 'archive-rpc.env', 'turnkey.env']);
  if (basename(dirname(absolutePath)) !== 'Rets' || !approvedFiles.has(basename(absolutePath))) throw new Error('SECRET_STORE_FILE_NOT_APPROVED');
  let parent = dirname(absolutePath);
  while (true) {
    const parentMetadata = await lstat(parent);
    if (parentMetadata.isSymbolicLink() || !parentMetadata.isDirectory()) throw new Error('SECRET_STORE_PARENT_INVALID');
    const next = dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  const metadata = await lstat(absolutePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) throw new Error('SECRET_STORE_FILE_PERMISSIONS_INVALID');
  const values = parseStore(await readFile(absolutePath, 'utf8'));
  return { has: (name) => values.has(name), get: (name) => values.get(name) };
}

function credentials(options: TelegramNotifierOptions): TelegramCredentials {
  const tokenName = options.tokenName ?? 'TG_BOT_TOKEN';
  const chatIdName = options.chatIdName ?? 'TG_CHAT_ID';
  if (!options.secretStore.has(tokenName) || !options.secretStore.has(chatIdName)) throw new Error('TELEGRAM_SECRET_NAMES_MISSING');
  const token = options.secretStore.get(tokenName);
  const chatId = options.secretStore.get(chatIdName);
  if (!token || /\s/.test(token)) throw new Error('TELEGRAM_TOKEN_INVALID');
  if (!chatId || (!/^-?\d+$/.test(chatId) && !/^@[A-Za-z0-9_]{5,}$/.test(chatId))) throw new Error('TELEGRAM_CHAT_ID_INVALID');
  return { token, chatId };
}

/** The notifier is deliberately outbound-only: it never calls getUpdates or accepts Telegram commands. */
export class TelegramNotifier implements NotificationSink {
  private readonly config: TelegramCredentials;
  private readonly fetcher: TelegramFetcher;
  private readonly apiBaseUrl: string;
  private readonly timeoutMs: number;
  public constructor(options: TelegramNotifierOptions) {
    this.config = credentials(options);
    this.fetcher = options.fetcher ?? (globalThis.fetch as unknown as TelegramFetcher);
    const apiBaseUrl = (options.apiBaseUrl ?? 'https://api.telegram.org').replace(/\/$/, '');
    let endpoint: URL;
    try { endpoint = new URL(apiBaseUrl); } catch { throw new Error('TELEGRAM_API_BASE_URL_INVALID'); }
    if (endpoint.protocol !== 'https:') {
      if (!options.approvedProxy || options.approvedProxy !== apiBaseUrl) throw new Error('TELEGRAM_HTTPS_OR_APPROVED_PROXY_REQUIRED');
      if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)) throw new Error('TELEGRAM_APPROVED_PROXY_MUST_BE_LOOPBACK');
    }
    this.apiBaseUrl = apiBaseUrl;
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  public async send(message: { eventId: string; runId?: string; type: string; text: string }): Promise<void> {
    const response = await this.fetcher(`${this.apiBaseUrl}/bot${this.config.token}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: this.config.chatId, text: redactText(message.text).slice(0, 4_000), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`TELEGRAM_DELIVERY_FAILED:${response.status}`);
    let body: unknown;
    try { body = await response.json(); } catch { throw new Error('TELEGRAM_RESPONSE_INVALID'); }
    if (!body || typeof body !== 'object' || (body as { ok?: boolean }).ok !== true) throw new Error('TELEGRAM_DELIVERY_REJECTED');
  }

  public async health(): Promise<TelegramHealth> {
    try {
      const response = await this.fetcher(`${this.apiBaseUrl}/bot${this.config.token}/getMe`, { signal: AbortSignal.timeout(this.timeoutMs) });
      if (!response.ok) return { status: 'failed', provider: 'telegram', reason: `HTTP_${response.status}` };
      const body = await response.json();
      return body && typeof body === 'object' && (body as { ok?: boolean }).ok === true ? { status: 'ok', provider: 'telegram' } : { status: 'failed', provider: 'telegram', reason: 'INVALID_RESPONSE' };
    } catch { return { status: 'failed', provider: 'telegram', reason: 'UNREACHABLE' }; }
  }
}

export function telegramAlertText(input: { kind: string; runId?: string; reason?: string }): string {
  return `${input.kind}${input.runId ? `: ${input.runId}` : ''}${input.reason ? `: ${redactText(input.reason)}` : ''}`;
}

export function parseTelegramSecretStore(source: string): TelegramCredentials {
  const store = parseStore(source);
  const token = store.get('TG_BOT_TOKEN');
  const chatId = store.get('TG_CHAT_ID');
  if (!token || !chatId) throw new Error('TELEGRAM_SECRET_STORE_INVALID');
  if (!/^-?\d+$/.test(chatId) && !/^@[A-Za-z0-9_]{5,}$/.test(chatId)) throw new Error('TELEGRAM_CHAT_ID_INVALID');
  return { token, chatId };
}

export async function readTelegramSecretStore(path: string): Promise<TelegramCredentials> { return parseTelegramSecretStore(await readFile(path, 'utf8')); }
