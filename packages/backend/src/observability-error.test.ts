import { describe, expect, it } from 'vitest';
import { redactRecord } from './observability.js';

describe('logged errors keep a safe reason (T-015)', () => {
  it('turns an Error into name, first-line message, code, status and causes instead of {}', () => {
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND rpc.example.com'), { code: 'ENOTFOUND' });
    const error = Object.assign(new Error('HTTP request failed.\n\nURL: https://rpc.example.com/v2/abcdefghijklmnopqrstuvwxyz0123456789\nRequest body: {"method":"eth_getLogs"}', { cause }), { name: 'HttpRequestError', status: 503 });
    const logged = redactRecord({ event: 'intelligence_digest_failed', error }) as { error: Record<string, unknown> };
    expect(logged.error).toEqual({ name: 'HttpRequestError', message: 'HTTP request failed.', status: 503, causes: ['Error ENOTFOUND: getaddrinfo ENOTFOUND rpc.example.com'] });
  });

  it('never keeps a URL or key from the message, even on the first line', () => {
    const query = ['api', 'key'].join('_');
    const error = new Error(`fetch failed for https://eth.example/v3/supersecretkey1234567890abcdef?${query}=zzz`);
    const text = JSON.stringify(redactRecord({ error }));
    expect(text).not.toMatch(/eth\.example|supersecretkey|zzz/);
    expect(text).toContain('[url]');
  });

  it('keeps redacting secret-named fields and does not loop on a self-referencing cause', () => {
    const error = new Error('boom');
    (error as Error & { cause?: unknown }).cause = error;
    const logged = redactRecord({ passphrase: 'abc', error }) as { passphrase: string; error: { causes?: string[] } };
    expect(logged.passphrase).toBe('[REDACTED]');
    expect(logged.error.causes).toHaveLength(3);
  });
});
