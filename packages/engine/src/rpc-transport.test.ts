import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPublicClient } from 'viem';
import { failoverTransport, splitBaseEndpoints } from './rpc-transport.js';

/** Real local JSON-RPC servers: one that fails, one that hangs, one that answers, one that answers with a contract revert. */
type Mode = 'ok' | 'fail' | 'hang' | 'revert';
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
      if (mode === 'revert') { response.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: 3, message: 'execution reverted', data: '0x08c379a0' } })); return; }
      response.end(JSON.stringify({ jsonrpc: '2.0', id, result: '0x2a' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

let failing = ''; let hanging = ''; let good = ''; let reverting = ''; let good2 = '';
beforeAll(async () => { failing = await serve('failing', 'fail'); hanging = await serve('hanging', 'hang'); good = await serve('good', 'ok'); reverting = await serve('reverting', 'revert'); good2 = await serve('good2', 'ok'); });
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
});
