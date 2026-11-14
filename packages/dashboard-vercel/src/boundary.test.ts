import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, request } from 'node:http';
import { mkdtemp, writeFile, chmod, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { allowedPath, basicAuthorized, fetchReadModel, MAX_BYTES, normalizeFreshness, originUrl, publicAddress } from './boundary.js';
import { createGateway, loadToken } from './gateway.js';
import { createHandler } from '../api/index.js';
import { DurableStore } from '../../backend/src/store.js';
import { Phase2ReadModelService } from '../../backend/src/read-model-v1.js';
import { Phase2ReadOnlyApi } from '../../backend/src/api.js';

const token = Array(49).join('g');
const password = 'p'.repeat(48);
const env = { DASHBOARD_EMAIL: 'owner@example.invalid', DASHBOARD_PASSWORD: password, READ_MODEL_ORIGIN: 'https://test.trycloudflare.com', READ_MODEL_GATEWAY_TOKEN: token };
const authorization = `Basic ${Buffer.from(`${env.DASHBOARD_EMAIL}:${password}`).toString('base64')}`;
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
async function listen(server: ReturnType<typeof createServer>, port = 0) {
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return (server.address() as { port: number }).port;
}
async function get(port: number, path: string, auth?: string, method = 'GET') {
  return new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: auth ? { Authorization: auth, Cookie: 'private=never-forward' } : {} }, res => {
      const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    }); req.on('error', reject); req.end();
  });
}
async function render(url: string, auth = authorization, transport = vi.fn(async () => ({})), headers: Record<string, string> = {}) {
  const response = { status: 0, headers: {} as Record<string, string>, body: '', writeHead(status: number, values: Record<string, string>) { this.status = status; this.headers = values; }, end(body: string) { this.body = body; } };
  await createHandler(env, transport)({ method: 'GET', url, headers: { authorization: auth, 'x-forwarded-proto': 'https', ...headers } }, response);
  return response;
}
describe('dashboard authority boundary', () => {
  it('requires exact independent long Basic credentials before any fetch', async () => {
    const transport = vi.fn();
    expect((await render('/', '', transport)).status).toBe(401);
    expect(transport).not.toHaveBeenCalled();
    expect(basicAuthorized(authorization, env.DASHBOARD_EMAIL, password)).toBe(true);
    expect(basicAuthorized(authorization, env.DASHBOARD_EMAIL, 'short')).toBe(false);
    expect(basicAuthorized(`Bearer ${token}`, env.DASHBOARD_EMAIL, password)).toBe(false);
    expect((await render('/', authorization, transport, { 'x-forwarded-proto': 'http' })).status).toBe(400);
    expect((await render('/?readiness=..%2Fmetrics', authorization, transport)).status).toBe(404);
    expect((await render('/metrics', authorization, transport)).status).toBe(404);
    expect(transport).not.toHaveBeenCalled();
  });
  it('fails 503 without echoing origin errors or credentials and marks unknown schemas', async () => {
    const result = await render('/', authorization, vi.fn(async () => { throw new Error(`${token} ${password}`); }));
    expect(result.status).toBe(503);
    expect(result.body).toContain('unknown');
    expect(result.body).not.toContain(token); expect(result.body).not.toContain(password);
    expect(result.headers['Cache-Control']).toContain('no-store');
    expect((await render('/')).status).toBe(503);
  });
  it('renders actual validated data with no browser credentials or scripts', async () => {
    const store = new DurableStore();
    const api = new Phase2ReadOnlyApi(new Phase2ReadModelService(), store, { discovery: () => ({ status: 'degraded', chains: [{ chainId: 1, state: 'stalled' }] }) });
    const transport = vi.fn(async (path: string) => api.handle({ method: 'GET', path }).body);
    const calendarId = `calendar:1:0x${'1'.repeat(40)}`;
    const result = await render(`/?readiness=${encodeURIComponent(calendarId)}`, authorization, transport);
    // Empty real state stays unavailable; the HTML still exposes the validated health failure.
    expect(result.status).toBe(503); expect(result.body).toContain('snapshot_');
    expect(result.body).toContain('Discovery: degraded');
    expect(result.body).toContain('stalled');
    expect(result.body).not.toContain('<script'); expect(result.body).not.toContain(token); expect(result.body).not.toContain(password);
    expect(transport.mock.calls.map(([path]) => path)).toEqual([`/api/v1/read-model/dashboard?readiness=${encodeURIComponent(calendarId)}`]);
    const direct = await render('/api/index', authorization, transport);
    expect(direct.status).toBe(503);
    expect((await render('/api/index', '', transport)).status).toBe(401);
  });
  it('allows only literal predefined read-model paths without queries or traversal', () => {
    expect(allowedPath('/api/v1/read-model/home')).toBe(true);
    expect(allowedPath('/api/v1/read-model/campaigns/campaign-1/readiness')).toBe(true);
    expect(allowedPath('/api/v1/read-model/dashboard?page=2&readiness=calendar%3A1%3Atest')).toBe(true);
    for (const path of ['/api/v1/read-model/dashboard?page=0', '/api/v1/read-model/dashboard?page=2&page=3', '/api/v1/read-model/dashboard?page=1&url=https://evil.invalid']) expect(allowedPath(path)).toBe(false);
    for (const value of ['/metrics', '/control/stop', '/api/v1/read-model/home?url=https://evil.invalid', '/api/v1/read-model/%2e%2e/health', '/api/v1/read-model/campaigns/../readiness', 'https://evil.invalid/api/v1/read-model/home', '/api/v1/read-model/runs/1']) expect(allowedPath(value)).toBe(false);
  });
  it('serves a valid partial batch through the direct function path with one upstream request', async () => {
    const store = new DurableStore();
    const batch = new Phase2ReadModelService().dashboard(store.snapshot());
    // Controlled schema fixture only; no claim of live eligibility or host readiness.
    for (const surface of Object.values(batch.data!)) Object.assign(surface, { availability: 'partial', issues: [] });
    Object.assign(batch, { availability: 'partial', issues: [] });
    const transport = vi.fn(async () => batch);
    const result = await render('/api/index', authorization, transport);
    expect(result.status).toBe(200);
    expect(result.body).toContain('data-read-only="true"');
    expect(transport).toHaveBeenCalledExactlyOnceWith('/api/v1/read-model/dashboard', expect.objectContaining({ origin: env.READ_MODEL_ORIGIN, token }));
    expect(result.body).not.toMatch(/<script|<form/i);
    expect((await render('/api/index?page=2', authorization, transport)).status).toBe(200);
    expect(transport).toHaveBeenLastCalledWith('/api/v1/read-model/dashboard?page=2', expect.any(Object));
    const unavailable = structuredClone(batch);
    Object.assign(unavailable, { availability: 'unavailable' });
    expect((await render('/', authorization, vi.fn(async () => unavailable))).status).toBe(503);
  });
  it('rejects URL tricks and private/link-local DNS targets', () => {
    for (const value of ['http://example.com', 'https://a:b@example.com', 'https://127.0.0.1', 'https://example.com:8443', 'https://example.com/path', 'https://example.com?x=1', 'https://example.com/#x']) expect(() => originUrl(value)).toThrow();
    for (const value of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '100.64.0.1', '192.168.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', '2002:7f00:1::', '2001:db8::1', '2001::1', '192.88.99.1']) expect(publicAddress(value)).toBe(false);
    expect(publicAddress('1.1.1.1')).toBe(true);
  });
  it('turns malformed and expired freshness into unknown/stale, never fresh', () => {
    expect(normalizeFreshness({ freshness: { status: 'fresh' } }).freshness.status).toBe('unknown');
    const f = { status: 'fresh', observedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-01T00:01:00.000Z' };
    expect(normalizeFreshness({ rows: [{ freshness: f }] }, Date.parse('2026-01-02')).rows[0].freshness.status).toBe('stale');
  });
  it('keeps gateway unauthenticated calls data-free; never forwards caller credentials', async () => {
    const transport = vi.fn(async () => ({ contract: 'mintbot.read-model', data: 'safe' }));
    const port = await listen(createGateway(token, transport));
    expect((await get(port, '/api/v1/read-model/home')).status).toBe(401);
    expect(transport).not.toHaveBeenCalled();
    expect((await get(port, '/api/v1/read-model/home', authorization)).status).toBe(401);
    expect((await get(port, '/metrics', `Bearer ${token}`)).status).toBe(404);
    expect((await get(port, '/api/v1/read-model/home', `Bearer ${token}`, 'POST')).status).toBe(405);
    const result = await get(port, '/api/v1/read-model/home', `Bearer ${token}`);
    expect(result.status).toBe(200); expect(result.headers['cache-control']).toContain('no-store');
    expect(transport).toHaveBeenCalledExactlyOnceWith('/api/v1/read-model/home', { loopback: true, token });
  });
  it('enforces deadlines, byte caps, backend Host and strips upstream headers', async () => {
    let mode = 'normal';
    await listen(createServer((req, res) => {
      expect(req.headers.host).toBe('127.0.0.1:8780');
      expect(req.headers.authorization).toBeUndefined(); expect(req.headers.cookie).toBeUndefined();
      if (mode === 'timeout') return;
      res.writeHead(mode === 'redirect' ? 302 : 200, { 'Content-Type': 'application/json', 'Set-Cookie': 'secret=value', Location: 'https://evil.invalid', 'WWW-Authenticate': 'secret' });
      res.end(mode === 'large' ? 'x'.repeat(MAX_BYTES + 1) : '{"data":"safe"}');
    }), 8780);
    expect(await fetchReadModel('/api/v1/read-model/home', { loopback: true, token })).toEqual({ data: 'safe' });
    for (const next of ['redirect', 'large', 'timeout']) {
      mode = next;
      await expect(fetchReadModel('/api/v1/read-model/home', { loopback: true, token, deadlineMs: 30 })).rejects.toThrow();
    }
  });
  it('requires protected regular owner token file and rejects symlinks', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dashboard-token-'));
    try {
      const path = join(directory, 'token'); await writeFile(path, token, { mode: 0o600 });
      expect(await loadToken(path)).toBe(token);
      await chmod(path, 0o644); await expect(loadToken(path)).rejects.toThrow();
      await chmod(path, 0o600); await symlink(path, join(directory, 'link')); await expect(loadToken(join(directory, 'link'))).rejects.toThrow();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('imports no signer, database, RPC or backend authority in runtime sources', () => {
    for (const file of ['src/boundary.js', 'src/gateway.js', 'api/index.js']) {
      const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
      for (const imported of source.matchAll(/from ['"]([^'"]+)['"]/g)) expect(imported[1]).toMatch(/^(?:node:|@mint-bot\/web(?:\/server)?$|\.\.\/src\/boundary\.js$|\.\/boundary\.js$)/);
    }
  });
});
