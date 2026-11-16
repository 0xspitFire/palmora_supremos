import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPublicClient } from 'viem';
import { failoverTransport, splitBaseEndpoints } from './rpc-transport.js';

/** Real local JSON-RPC servers: one that fails, one that hangs, one that answers, one that answers with a contract revert. */
type Mode = 'ok' | 'fail' | 'hang' | 'body-hang' | 'oversized' | 'revert';
const servers: Server[] = [];
const hits: Record<string, number> = {};
async function serve(name: string, mode: Mode): Promise<string> {
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      hits[name] = (hits[name] ?? 0) + 1;
      const id = (JSON.parse(body) as { id: number }).id;
      if (mode === 'hang') return; // never answers
      if (mode === 'fail') { response.writeHead(503); response.end('down'); return; }
      response.writeHead(200, { 'content-type': 'application/json' });
      if (mode === 'body-hang') { response.write('{"jsonrpc":"2.0",'); return; }
      if (mode === 'oversized') { response.end('x'.repeat(10_485_761)); return; }
      if (mode === 'revert') { response.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: 3, message: 'execution reverted', data: '0x08c379a0' } })); return; }
      response.end(JSON.stringify({ jsonrpc: '2.0', id, result: '0x2a' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

let failing = ''; let hanging = ''; let good = ''; let reverting = ''; let good2 = ''; let bodyHanging = ''; let oversized = '';
beforeAll(async () => { failing = await serve('failing', 'fail'); hanging = await serve('hanging', 'hang'); good = await serve('good', 'ok'); reverting = await serve('reverting', 'revert'); good2 = await serve('good2', 'ok'); bodyHanging = await serve('body-hang', 'body-hang'); oversized = await serve('oversized', 'oversized'); });
afterAll(() => { for (const server of servers) { server.closeAllConnections?.(); server.close(); } });

describe('read failover across RPC providers', () => {
  it('uses the first provider while it answers', async () => {
    const before = hits.good2 ?? 0;
    const client = createPublicClient({ transport: failoverTransport([good, good2]) });
    expect(await client.getBlockNumber({ cacheTime: 0 })).toBe(42n);
    expect(hits.good2 ?? 0).toBe(before);
  });

  it('moves to the next provider when the first fails or times out', async () => {
    expect(await createPublicClient({ transport: failoverTransport([failing, good]) }).getBlockNumber({ cacheTime: 0 })).toBe(42n);
    expect(await createPublicClient({ transport: failoverTransport([hanging, good], { timeoutMs: 300 }) }).getBlockNumber({ cacheTime: 0 })).toBe(42n);
  });

  it('a contract revert is an answer: it is reported, not retried on another provider', async () => {
    const before = hits.good ?? 0;
    const client = createPublicClient({ transport: failoverTransport([reverting, good]) });
    await expect(client.call({ to: '0x0000000000000000000000000000000000000001', data: '0x' })).rejects.toThrow(/revert/i);
    expect(hits.good ?? 0).toBe(before);
  });

  it('fails only when every provider fails, and refuses an empty list', async () => {
    await expect(createPublicClient({ transport: failoverTransport([failing, hanging], { timeoutMs: 300 }) }).getBlockNumber({ cacheTime: 0 })).rejects.toThrow();
    expect(() => failoverTransport([])).toThrow('RPC_ENDPOINT_UNAVAILABLE');
    expect(() => failoverTransport([undefined, ''])).toThrow('RPC_ENDPOINT_UNAVAILABLE');
  });

  it('Base keeps the second provider apart as the independent cross-check', () => {
    expect(splitBaseEndpoints(['a', 'b', 'c'])).toEqual({ primary: ['a', 'c'], independent: 'b' });
    expect(splitBaseEndpoints(['a'])).toEqual({ primary: ['a'], independent: undefined });
  });
  it('aborts a scoped read before the ordinary HTTP timeout and does not contact a fallback after cancellation',async()=>{
    const controller=new AbortController();const before=hits.good??0;const start=Date.now();
    const pending=createPublicClient({transport:failoverTransport([hanging,good],{timeoutMs:15000,signal:controller.signal})}).getBlockNumber({cacheTime:0});
    const timer=setTimeout(()=>controller.abort(),30);try{await expect(pending).rejects.toThrow();expect(Date.now()-start).toBeLessThan(2000);expect(hits.good??0).toBe(before);}finally{clearTimeout(timer);}
  });

  it.each(['headers', 'body'])('fails over within the scoped operation budget when %s never arrive', async stage => {
    const controller = new AbortController();
    const outer = setTimeout(() => controller.abort(), 1500);
    const start = Date.now();
    try {
      const client = createPublicClient({ transport: failoverTransport([stage === 'headers' ? hanging : bodyHanging, good], { signal: controller.signal, completeResponseTimeoutMs: 50 }) });
      expect(await client.getBlockNumber({ cacheTime: 0 })).toBe(42n);
      expect(controller.signal.aborted).toBe(false);
      expect(Date.now() - start).toBeLessThan(1200);
    } finally { clearTimeout(outer); }
  });

  it('does not fail over after the caller aborts a partially received body', async () => {
    const controller = new AbortController();
    const before = hits.good ?? 0;
    const pending = createPublicClient({ transport: failoverTransport([bodyHanging, good], { signal: controller.signal, completeResponseTimeoutMs: 1000 }) }).getBlockNumber({ cacheTime: 0 });
    const timer = setTimeout(() => controller.abort(), 50);
    try { await expect(pending).rejects.toThrow(); expect(hits.good ?? 0).toBe(before); }
    finally { clearTimeout(timer); }
  });

  it('does not recontact a timed-out provider for later chunks in the same scoped operation', async () => {
    const controller = new AbortController(); const before = hits['body-hang'] ?? 0;
    const client = createPublicClient({ transport: failoverTransport([bodyHanging, good], { signal: controller.signal, completeResponseTimeoutMs: 50 }) });
    for (let i = 0; i < 3; i++) expect(await client.getBlockNumber({ cacheTime: 0 })).toBe(42n);
    expect((hits['body-hang'] ?? 0) - before).toBe(1);
    // A new operation gets a fresh provider decision; no persistent blacklist.
    const next = createPublicClient({ transport: failoverTransport([bodyHanging, good], { signal: new AbortController().signal, completeResponseTimeoutMs: 50 }) });
    expect(await next.getBlockNumber({ cacheTime: 0 })).toBe(42n);
    expect((hits['body-hang'] ?? 0) - before).toBe(2);
  });

  it('rejects an oversized scoped body before proceeding to a bounded fallback', async () => {
    const controller = new AbortController();
    expect(await createPublicClient({ transport: failoverTransport([oversized, good], { signal: controller.signal, completeResponseTimeoutMs: 1000 }) }).getBlockNumber({ cacheTime: 0 })).toBe(42n);
  });

  it('does not retry a scoped contract revert and refuses unscoped or invalid complete-response budgets', async () => {
    const controller = new AbortController(); const before = hits.good ?? 0;
    await expect(createPublicClient({ transport: failoverTransport([reverting, good], { signal: controller.signal, completeResponseTimeoutMs: 1000 }) }).call({ to: '0x0000000000000000000000000000000000000001', data: '0x' })).rejects.toThrow(/revert/i);
    expect(hits.good ?? 0).toBe(before);
    for (const completeResponseTimeoutMs of [0, -1, 1.5, 15001, NaN]) expect(() => failoverTransport([good], { signal: controller.signal, completeResponseTimeoutMs })).toThrow('RPC_COMPLETE_RESPONSE_BOUNDS_INVALID');
    expect(() => failoverTransport([good], { completeResponseTimeoutMs: 50 })).toThrow('RPC_COMPLETE_RESPONSE_BOUNDS_INVALID');
  });

  it.each(['headers', 'body', 'blocked-timer'])('rejects late primary success after an ignored abort (%s)', async stage => {
    const primary = 'https://primary.example.invalid'; const secondary = 'https://secondary.example.invalid';
    const calls: string[] = [];
    const mocked = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input)).origin; calls.push(url);
      const { id } = JSON.parse(String(init?.body)) as { id: number };
      const text = JSON.stringify({ jsonrpc: '2.0', id, result: url === primary ? '0x1' : '0x2a' });
      if (url === secondary) return new Response(text);
      if (url !== primary) throw new Error('UNEXPECTED_TEST_ENDPOINT');
      if (stage === 'headers') await new Promise(resolve => setTimeout(resolve, 60));
      if (stage === 'blocked-timer') { const until = performance.now() + 40; while (performance.now() < until) { /* simulate synchronous work delaying timers */ } }
      if (stage === 'body') return new Response(new ReadableStream({ start(controller) { setTimeout(() => { controller.enqueue(new TextEncoder().encode(text)); controller.close(); }, 60); } }));
      return new Response(text);
    });
    try {
      const client = createPublicClient({ transport: failoverTransport([primary, secondary], { signal: new AbortController().signal, completeResponseTimeoutMs: 20 }) });
      expect(await client.getBlockNumber({ cacheTime: 0 })).toBe(42n);
      expect(calls).toEqual([primary, secondary]);
    } finally { mocked.mockRestore(); }
  });

  it('rejects a late no-body response and caller-aborted body without publishing or fallback after caller abort', async () => {
    const primary = 'https://primary.example.invalid'; const secondary = 'https://secondary.example.invalid';
    const mocked = vi.spyOn(globalThis, 'fetch');
    try {
      mocked.mockImplementation(async () => { await new Promise(resolve => setTimeout(resolve, 60)); return new Response(null); });
      await expect(createPublicClient({ transport: failoverTransport([primary], { signal: new AbortController().signal, completeResponseTimeoutMs: 20 }) }).getBlockNumber({ cacheTime: 0 })).rejects.toThrow(/took too long|timed out/i);
      const controller = new AbortController(); let calls = 0;
      mocked.mockImplementation(async (_input, init) => {
        calls++; const { id } = JSON.parse(String(init?.body)) as { id: number };
        return new Response(new ReadableStream({ start(stream) { setTimeout(() => { controller.abort(); stream.enqueue(new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', id, result: '0x1' }))); stream.close(); }, 20); } }));
      });
      await expect(createPublicClient({ transport: failoverTransport([primary, secondary], { signal: controller.signal, completeResponseTimeoutMs: 1000 }) }).getBlockNumber({ cacheTime: 0 })).rejects.toThrow();
      expect(calls).toBe(1);
    } finally { mocked.mockRestore(); }
  });

  it.each(['pending', 'rejected'])('retains ownership when oversized-body cleanup is %s', async mode => {
    let release: (() => void) | undefined; let calls = 0; let settled = false;
    const cleanup = new Promise<void>(resolve => { release = resolve; });
    const mocked = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      calls++;
      return new Response(new ReadableStream({ start(stream) { stream.enqueue(new Uint8Array(10_485_761)); }, cancel() { return mode === 'pending' ? cleanup : Promise.reject(new Error('SYNTHETIC_CANCEL_FAILURE')); } }));
    });
    try {
      const pending = createPublicClient({ transport: failoverTransport(['https://primary.example.invalid', 'https://secondary.example.invalid'], { signal: new AbortController().signal, completeResponseTimeoutMs: 20 }) }).getBlockNumber({ cacheTime: 0 });
      void pending.then(() => { settled = true; }, () => { settled = true; });
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(settled).toBe(false); expect(calls).toBe(1);
      // Only successful cleanup settlement allows fallback. A rejection remains
      // conservatively owned forever, including after the provider deadline.
      if (mode === 'pending') { mocked.mockImplementation(async (_input, init) => { calls++; const { id } = JSON.parse(String(init?.body)) as { id: number }; return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: '0x2a' })); }); release!(); expect(await pending).toBe(42n); expect(calls).toBe(2); }
    } finally { mocked.mockRestore(); }
  });

});
