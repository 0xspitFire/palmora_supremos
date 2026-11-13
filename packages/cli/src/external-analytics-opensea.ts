import type { ExternalAnalyticsCandidatePage, ExternalAnalyticsCandidatePort } from '@mint-bot/backend';
import { OPENSEA_CHAIN_SLUG } from './opensea-client.js';

/** Official account events discover candidates only. Neither payment JSON nor
 * provider pagination is finality, a sale settlement, or proof of full history.
 * Raw HTTP schema is snake_case. Official SDK BaseEvent + SaleEvent/TransferEvent/MintEvent
 * https://github.com/ProjectOpenSea/opensea-sdk/blob/main/src/api/types.ts#L469-L650
 * confirms chain:string, transaction:string, event_timestamp:number (SDK camelizes).
 * Contract: https://docs.opensea.io/reference/list_events_by_account
 */
export interface ExternalAnalyticsHttpResponse {
  ok: boolean; status: number; headers?: { get(name: string): string | null };
  body?: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
}
export type ExternalAnalyticsFetch = (url: string, init: { method: 'GET'; headers: Record<string, string>; redirect: 'error'; signal: AbortSignal }) => Promise<ExternalAnalyticsHttpResponse>;
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const HASH = /^0x[0-9a-f]{64}$/i;
const MAX_BODY = 1_048_576;
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const cursorValid = (value: unknown): value is string => typeof value === 'string' && value.length >= 1 && value.length <= 2048 && !/[\u0000-\u001f\u007f]/.test(value);
const SAFE = new Set(['EXTERNAL_OPENSEA_ACCESS_DENIED', 'EXTERNAL_OPENSEA_RATE_LIMITED', 'EXTERNAL_OPENSEA_UNAVAILABLE', 'EXTERNAL_OPENSEA_RESPONSE_INVALID', 'EXTERNAL_OPENSEA_RESPONSE_TOO_LARGE', 'EXTERNAL_OPENSEA_SCOPE_INVALID']);

export function parseOpenSeaExternalAnalyticsPage(value: unknown, input: { chainId: number; after: number; before: number }): ExternalAnalyticsCandidatePage {
  const body = object(value); const slug = OPENSEA_CHAIN_SLUG[input.chainId];
  if (!slug || !body || !Array.isArray(body.asset_events) || body.asset_events.length > 200 || body.next !== undefined && body.next !== null && !cursorValid(body.next)) throw new Error('EXTERNAL_OPENSEA_RESPONSE_INVALID');
  const hashes = new Set<string>(); let omitted = 0;
  for (const entry of body.asset_events) {
    const row = object(entry);
    if (!row || !['sale', 'transfer', 'mint'].includes(String(row.event_type))) { omitted += 1; continue; }
    if (row.chain !== slug || typeof row.transaction !== 'string' || !HASH.test(row.transaction) || typeof row.event_timestamp !== 'number' || !Number.isSafeInteger(row.event_timestamp) || row.event_timestamp < input.after || row.event_timestamp > input.before) { omitted += 1; continue; }
    hashes.add(row.transaction.toLowerCase());
  }
  return { candidates: [...hashes].map(transactionHash => ({ transactionHash })), ...(typeof body.next === 'string' ? { next: body.next } : {}), coverage: omitted ? 'unknown' : 'partial', code: omitted ? 'EXTERNAL_OPENSEA_RECORDS_OMITTED' : 'EXTERNAL_OPENSEA_INDEX_COVERAGE_LIMITED' };
}

export function createOpenSeaExternalAnalyticsCandidates(options: { apiKey: string; fetcher?: ExternalAnalyticsFetch; now?: () => Date; sleep?: (ms: number) => Promise<void>; timeoutMs?: number }): ExternalAnalyticsCandidatePort {
  if (!options.apiKey || /[\r\n]/.test(options.apiKey)) throw new Error('EXTERNAL_OPENSEA_ACCESS_DENIED');
  const timeout = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30_000) throw new Error('EXTERNAL_OPENSEA_SCOPE_INVALID');
  const fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
  const now = options.now ?? (() => new Date()); const sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  let queue: Promise<unknown> = Promise.resolve(); let nextAt = 0; let blockedUntil = 0;
  const readBody = async (response: ExternalAnalyticsHttpResponse): Promise<string> => {
    if (Number(response.headers?.get('content-length') ?? 0) > MAX_BODY) throw new Error('EXTERNAL_OPENSEA_RESPONSE_TOO_LARGE');
    if (!response.body) { const value = await response.text(); if (Buffer.byteLength(value) > MAX_BODY) throw new Error('EXTERNAL_OPENSEA_RESPONSE_TOO_LARGE'); return value; }
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
    try { for (;;) { const row = await reader.read(); if (row.done) break; length += row.value.byteLength; if (length > MAX_BODY) { await reader.cancel(); throw new Error('EXTERNAL_OPENSEA_RESPONSE_TOO_LARGE'); } chunks.push(row.value); } }
    finally { reader.releaseLock(); }
    return Buffer.concat(chunks).toString('utf8');
  };
  return {
    page(input) {
      const work = queue.then(async () => {
        const slug = OPENSEA_CHAIN_SLUG[input.chainId];
        if (!slug || !ADDRESS.test(input.wallet) || !Number.isSafeInteger(input.after) || input.after < 0 || !Number.isSafeInteger(input.before) || input.before <= input.after || input.cursor !== undefined && !cursorValid(input.cursor)) throw new Error('EXTERNAL_OPENSEA_SCOPE_INVALID');
        if (now().getTime() < blockedUntil) throw new Error('EXTERNAL_OPENSEA_RATE_LIMITED');
        const wait = nextAt - now().getTime(); if (wait > 0) await sleep(wait);
        nextAt = now().getTime() + 500;
        const query = new URLSearchParams({ chain: slug, after: String(input.after), before: String(input.before), limit: '200', ...(input.cursor ? { next: input.cursor } : {}) });
        for (const type of ['sale', 'transfer', 'mint']) query.append('event_type', type);
        const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
        const read = async (): Promise<ExternalAnalyticsCandidatePage> => {
          const response = await fetcher(`https://api.opensea.io/api/v2/events/accounts/${input.wallet.toLowerCase()}?${query}`, { method: 'GET', headers: { accept: 'application/json', 'x-api-key': options.apiKey }, redirect: 'error', signal: controller.signal });
          if (response.status === 401 || response.status === 403) throw new Error('EXTERNAL_OPENSEA_ACCESS_DENIED');
          if (response.status === 429 || response.status === 503) { const retry = Number(response.headers?.get('retry-after')); blockedUntil = now().getTime() + Math.min(300_000, Math.max(1000, Number.isFinite(retry) && retry > 0 ? retry * 1000 : 60_000)); throw new Error('EXTERNAL_OPENSEA_RATE_LIMITED'); }
          if (!response.ok) throw new Error('EXTERNAL_OPENSEA_UNAVAILABLE');
          return parseOpenSeaExternalAnalyticsPage(JSON.parse(await readBody(response)), input);
        };
        try { return await Promise.race([read(), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('EXTERNAL_OPENSEA_UNAVAILABLE')); }, timeout); })]); }
        catch (error) { throw new Error(error instanceof Error && SAFE.has(error.message) ? error.message : 'EXTERNAL_OPENSEA_UNAVAILABLE'); }
        finally { controller.abort(); if (timer) clearTimeout(timer); }
      });
      queue = work.catch(() => undefined);
      return work;
    },
  };
}
