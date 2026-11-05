import { describe, expect, it, vi } from 'vitest';
import { createTelegramBotApi } from './telegram-api.js';
import { startTelegramCommands } from './telegram-command-service.js';

const token = ['123', 'test-only'].join(':');
const response = (status: number, body: unknown) => ({ ok: status === 200, status, json: async () => body });

describe('bounded Telegram deletion recovery', () => {
  it('retries the same message after ambiguous network and server failures without retrying sends', async () => {
    vi.useFakeTimers();
    try {
      const payloads: string[] = [];
      const api = createTelegramBotApi({ token, fetcher: async (_url, init) => {
        payloads.push(String(init?.body));
        if (payloads.length === 1) throw Object.assign(new Error('private transport details'), { cause: { code: 'ECONNRESET' } });
        return payloads.length === 2 ? response(503, {}) : response(200, { ok: true, result: true });
      } });
      const deleting = api.deleteMessage(1, 7);
      await vi.advanceTimersByTimeAsync(249); expect(payloads).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1); expect(payloads).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(500); await deleting;
      expect(payloads).toEqual(Array(3).fill(JSON.stringify({ chat_id: 1, message_id: 7 })));
      let sends = 0;
      const sender = createTelegramBotApi({ token, fetcher: async () => { sends += 1; throw new Error('ambiguous send'); } });
      await expect(sender.sendMessage(1, 'reply')).rejects.toMatchObject({ message: 'TELEGRAM_SENDMESSAGE_UNREACHABLE', reason: 'NETWORK' });
      expect(sends).toBe(1);
    } finally { vi.useRealTimers(); }
  });

  it('accepts only the exact already-absent deletion response and preserves permission failures', async () => {
    const gone = createTelegramBotApi({ token, fetcher: async () => response(400, { ok: false, description: 'Bad Request: message to delete not found' }) });
    await expect(gone.deleteMessage(1, 7)).resolves.toBeUndefined();
    for (const [status, description, reason] of [[400, 'Bad Request: message can\'t be deleted', 'BAD_REQUEST'], [400, 'Bad Request: chat not found', 'BAD_REQUEST'], [403, 'Forbidden: bot blocked', 'FORBIDDEN']] as const) {
      let attempts = 0;
      const api = createTelegramBotApi({ token, fetcher: async () => { attempts += 1; return response(status, { ok: false, description }); } });
      await expect(api.deleteMessage(1, 7)).rejects.toMatchObject({ reason });
      expect(attempts).toBe(1);
    }
  });

  it('bounds invalid deletion-response recovery and never claims false results were deleted', async () => {
    vi.useFakeTimers();
    try {
      for (const malformed of [null, { ok: true, result: false }]) {
        let attempts = 0;
        const api = createTelegramBotApi({ token, fetcher: async () => { attempts += 1; return response(200, malformed); } });
        const deleting = expect(api.deleteMessage(1, 7)).rejects.toMatchObject({ reason: 'RESPONSE_INVALID' });
        await vi.advanceTimersByTimeAsync(750); await deleting;
        expect(attempts).toBe(3);
      }
    } finally { vi.useRealTimers(); }
  });

  it('exports only fixed classifications for timeout, DNS, TLS and unknown transport errors', async () => {
    for (const [error, reason] of [[{ name: 'TimeoutError' }, 'TIMEOUT'], [{ cause: { code: 'EAI_AGAIN' } }, 'DNS'], [{ cause: { code: 'CERT_HAS_EXPIRED' } }, 'TLS'], [{ cause: { code: 'private token=do-not-log' } }, 'NETWORK']] as const) {
      const api = createTelegramBotApi({ token, fetcher: async () => { throw Object.assign(new Error('secret URL/code/text'), error); } });
      await expect(api.getUpdates(0, 25)).rejects.toMatchObject({ message: 'TELEGRAM_GETUPDATES_UNREACHABLE', reason });
    }
  });
});

describe('Telegram polling recovery', () => {
  it('backs off repeated failures, resets after recovery and preserves offset-before-handler ordering', async () => {
    vi.useFakeTimers();
    let service: ReturnType<typeof startTelegramCommands> | undefined;
    try {
      let calls = 0; let offset = 0;
      const order: string[] = []; const logs: Array<Record<string, unknown> | undefined> = [];
      const api = createTelegramBotApi({ token, fetcher: async () => {
        calls += 1;
        if (calls === 1 || calls === 2 || calls === 4) throw Object.assign(new Error('secret URL'), { cause: { code: 'EAI_AGAIN' } });
        if (calls === 3) return response(200, { ok: true, result: [{ update_id: 7 }] });
        return new Promise(() => undefined);
      } });
      service = startTelegramCommands({ api, offsets: { pollOffset: () => offset, savePollOffset: value => { offset = value; order.push('saved'); } }, router: { onStart: async () => undefined, checkSession: async () => undefined, handle: async () => { order.push('handled'); } }, log: (_event, fields) => { logs.push(fields); } });
      await vi.advanceTimersByTimeAsync(0); expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(5_000); expect(calls).toBe(2);
      await vi.advanceTimersByTimeAsync(10_000); expect(calls).toBe(4);
      expect(order).toEqual(['saved', 'handled']); expect(offset).toBe(8);
      expect(logs.map(fields => fields?.retryInMs)).toEqual([5_000, 10_000, 5_000]);
      expect(logs.every(fields => fields?.reason === 'DNS')).toBe(true);
      expect(JSON.stringify(logs)).not.toContain('secret');
      service.stop(); await service.done;
    } finally { service?.stop(); vi.useRealTimers(); }
  });

  it('honors a long explicit provider cooldown and stops promptly during the wait', async () => {
    vi.useFakeTimers();
    let service: ReturnType<typeof startTelegramCommands> | undefined;
    try {
      let calls = 0;
      const api = createTelegramBotApi({ token, fetcher: async () => { calls += 1; return response(429, { ok: false, parameters: { retry_after: 120 } }); } });
      service = startTelegramCommands({ api, offsets: { pollOffset: () => 0, savePollOffset: () => undefined }, router: { onStart: async () => undefined, checkSession: async () => undefined, handle: async () => undefined }, log: () => undefined });
      await vi.advanceTimersByTimeAsync(119_999); expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(1); expect(calls).toBe(2);
      service.stop(); await service.done;
      expect(vi.getTimerCount()).toBe(0);
    } finally { service?.stop(); vi.useRealTimers(); }
  });
});
