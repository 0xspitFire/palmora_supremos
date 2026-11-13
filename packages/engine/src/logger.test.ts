import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLogger } from './logger.js';
import { redactEngineText, redactEngineValue } from './log-redaction.js';

let directory: string | undefined;
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

describe('engine logging output boundary', () => {
  it('sanitizes actual root, nested, child, Error, and interpolated file output', async () => {
    directory = await mkdtemp(join(tmpdir(), 'mintbot-redaction-'));
    const path = join(directory, 'output.log');
    const logger = createLogger('info', path);
    const apiKey = ['nested', 'marker'].join('-');
    const apiToken = ['set', 'bindings', 'marker'].join('-');
    const compoundMarker = ['compound', 'credential', 'marker'].join('-');
    const child = logger.child({ component: 'test', providerUrl: 'https://rpc.example/child-marker', nested: { apiKey } }).child({ nestedContext: 'retained' });
    child.setBindings({ apiToken });
    child.error({ providerUrl: 'https://rpc.example/root-marker', nested: { calldata: '0x12345678abcdef00', password: 'password-marker' }, err: new Error('unlabelled-error-marker'), txHash: `0x${'a'.repeat(64)}` }, 'provider https://rpc.example/message-marker Authorization: Bearer bearer-marker data 0x12345678abcdef00');
    child.info('token=%s', 'token=interpolation-marker');
    child.info({ apiPrivateKey: compoundMarker, 'x-api-key': compoundMarker, nested: { fallbackRpcUrl: compoundMarker, errorMessage: compoundMarker } }, 'compound sensitive fields');
    child.flush();
    let content = '';
    for (let i = 0; i < 100; i++) {
      try { content = await readFile(path, 'utf8'); } catch { /* worker creates destination asynchronously */ }
      if (content.split('\n').length >= 4) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(content).toContain('"component":"test"');
    for (const marker of ['set-bindings-marker', 'child-marker', 'nested-marker', 'root-marker', 'password-marker', 'unlabelled-error-marker', 'message-marker', 'bearer-marker', 'interpolation-marker', '0x12345678abcdef00']) expect(content).not.toContain(marker);
    expect(content).toContain(`0x${'a'.repeat(64)}`);
    expect(content).toContain('[REDACTED]');
    expect(content).toContain('retained');
    expect(content).not.toContain(compoundMarker);
  });
  it('does not invoke getters/toJSON and bounds circular and deep payloads', () => {
    const item = { get value() { throw new Error('getter must not execute'); }, toJSON() { throw new Error('toJSON must not execute'); } };
    expect(() => JSON.stringify(redactEngineValue(item))).not.toThrow();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(redactEngineValue(circular)).toEqual({ self: '[bounded]' });
    expect(redactEngineText(['api_key', '="synthetic quoted marker" wss://rpc.example/path'].join(''))).toBe('[REDACTED] [endpoint]');
  });
});
