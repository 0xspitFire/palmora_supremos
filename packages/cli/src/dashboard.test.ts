import { describe, expect, it } from 'vitest';
import { DurableStore, loadServiceConfig, MetricsRegistry, ServiceHttpServer, type OrchestratorService } from '@mint-bot/backend';
import { request as httpRequest } from 'node:http';
import { createDashboard } from './dashboard.js';
import { EngineIntelligencePort } from './intelligence-adapter.js';

const NFT = '0x3333333333333333333333333333333333333333';

async function serve(store: DurableStore) {
  const dashboard = createDashboard(store);
  const orchestrator = { status: () => ({ running: true, state: 'Blocked', startupState: 'Blocked', active: 0, queued: 0, blocked: 0, failed: 0, completed: 0, blockingReasons: [] }) } as unknown as OrchestratorService;
  const server = new ServiceHttpServer({ host: '127.0.0.1', port: 0, store, orchestrator, metrics: new MetricsRegistry(), readModel: dashboard.readModel, dashboard: (url) => dashboard.render(url) });
  const { port } = await server.start();
  return { server, base: `http://127.0.0.1:${port}` };
}

describe('served read-only dashboard (P2-07)', () => {
  it('serves a script-free dashboard page and read-model JSON, and refuses writes', async () => {
    const store = new DurableStore();
    const at = new Date().toISOString();
    await store.transaction((state) => {
      state.events.push({ id: 'opp-1', type: 'opportunity_notified', at, data: { opportunityId: `seadrop:1:${NFT}`, chainId: 1, contract: NFT, disposition: 'notified', score: 72, scoreVersion: 'v1-rules-p2', factors: [{ code: 'convergence', status: 'available', points: 14, max: 20, explanation: '2 of your watched wallets minted this.' }, { code: 'demand', status: 'available', points: 3, max: 10, explanation: '<script>alert(1)</script>' }], expiresAt: new Date(Date.now() + 900_000).toISOString() } });
      state.events.push({ id: 'cal-1', type: 'calendar_entry', at, data: { id: `calendar:1:${NFT}`, chainId: 1, contract: NFT, openingAt: new Date(Date.now() + 3_600_000).toISOString(), closingAt: null, phase: 'upcoming', priceWei: '0', maxPerWallet: 5, method: 'seadrop-v1-public', publicStatus: 'public', sourceAuthority: 'on_chain', expiresAt: new Date(Date.now() + 900_000).toISOString() } });
    });
    const { server, base } = await serve(store);
    try {
      const page = await fetch(`${base}/`);
      expect(page.status).toBe(200);
      expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
      const html = await page.text();
      expect(html).toContain('<!doctype html>');
      expect(html).toContain('2 of your watched wallets minted this.');
      expect(html).not.toMatch(/<script|<form/i);
      const api = await fetch(`${base}/api/v1/read-model/opportunities`);
      expect(api.status).toBe(200);
      const body = await api.json() as { data: Array<{ score: { value: number } }> };
      expect(body.data[0]?.score.value).toBe(72);
      const readiness = await fetch(`${base}/?readiness=${encodeURIComponent(`calendar:1:${NFT}`)}`);
      expect(readiness.status).toBe(200);
      expect((await fetch(`${base}/api/v1/read-model/opportunities`, { method: 'POST' })).status).toBe(405);
      expect((await fetch(`${base}/`, { method: 'POST' })).status).toBe(405);
      expect((await fetch(`${base}/api/v1/read-model/unknown`)).status).toBe(404);
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    } finally {
      await server.stop();
    }
  });
});

describe('dashboard server hardening (security review T-004)', () => {
  it('refuses non-loopback Host headers (DNS rebinding) and survives a throwing read model', async () => {
    const store = new DurableStore();
    const orchestrator = { status: () => ({ running: true, state: 'Blocked', startupState: 'Blocked', active: 0, queued: 0, blocked: 0, failed: 0, completed: 0, blockingReasons: [] }) } as unknown as OrchestratorService;
    const server = new ServiceHttpServer({ host: '127.0.0.1', port: 0, store, orchestrator, metrics: new MetricsRegistry(), readModel: { handle: () => { throw new Error('boom rpc=https://secret.example/key'); } }, dashboard: () => 'ok' });
    const { port } = await server.start();
    try {
      const request = (path: string, host: string) => new Promise<number>((resolve, reject) => {
        const req = httpRequest({ host: '127.0.0.1', port, path, headers: { host } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
        req.on('error', reject);
        req.end();
      });
      expect(await request('/', 'evil.example')).toBe(421);
      expect(await request('/', `localhost:${port}`)).toBe(200);
      expect(await request('/', `127.0.0.1:${port + 1}`)).toBe(421);
      const failing = await fetch(`http://127.0.0.1:${port}/api/v1/read-model/home`);
      expect(failing.status).toBe(503);
      expect(await failing.text()).not.toContain('secret.example');
    } finally {
      await server.stop();
    }
  });

  it('refuses a non-HTTPS remote RPC for the intelligence port', () => {
    expect(() => EngineIntelligencePort.fromRpcUrl('http://rpc.example.com')).toThrow('INTELLIGENCE_RPC_MUST_BE_HTTPS');
    expect(() => EngineIntelligencePort.fromRpcUrl('not a url')).toThrow('INTELLIGENCE_RPC_URL_INVALID');
    expect(() => EngineIntelligencePort.fromRpcUrl('https://rpc.example.com')).not.toThrow();
  });
});

describe('intelligence service configuration (P2-09)', () => {
  it('is off by default, needs the host secret store when on, and only takes public wallet addresses', () => {
    const config = loadServiceConfig({}, '/tmp/mintbot');
    expect(config).toMatchObject({ intelligenceEnabled: false, intelligenceRpcName: 'ETHEREUM_RPC_URL', readinessWallets: [], discoveryIntervalMs: 120_000 });
    expect(() => loadServiceConfig({ MINT_BOT_INTELLIGENCE_ENABLED: 'true' }, '/tmp/mintbot')).toThrow('INTELLIGENCE_SECRET_STORE_REQUIRED');
    expect(() => loadServiceConfig({ MINT_BOT_READINESS_WALLETS: '0x12' }, '/tmp/mintbot')).toThrow('MINT_BOT_READINESS_WALLETS_INVALID');
    expect(() => loadServiceConfig({ MINT_BOT_INTELLIGENCE_RPC_NAME: 'https://rpc.example' }, '/tmp/mintbot')).toThrow('MINT_BOT_INTELLIGENCE_RPC_NAME_INVALID');
    const wallets = loadServiceConfig({ MINT_BOT_READINESS_WALLETS: `${NFT.toUpperCase().replace('0X', '0x')}, ${NFT}` }, '/tmp/mintbot').readinessWallets;
    expect(wallets).toEqual([NFT]);
    expect(() => loadServiceConfig({ MINT_BOT_DISCOVERY_INTERVAL_MS: '1000' }, '/tmp/mintbot')).toThrow('MINT_BOT_DISCOVERY_INTERVAL_MS_INVALID');
  });
});
