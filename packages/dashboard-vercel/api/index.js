import { ReadModelClient } from '@mint-bot/web';
import { renderDocument } from '@mint-bot/web/server';
import { basicAuthorized, dashboardPath, fetchReadModel, gate, normalizeFreshness, originUrl, reply } from '../src/boundary.js';

const acquire = gate(4);
export function createHandler(env = process.env, transport = fetchReadModel) {
  return async (req, res) => {
    // Vercel terminates HTTPS; reject an explicitly insecure forwarded scheme.
    if (req.headers['x-forwarded-proto'] !== 'https') return reply(res, 400, 'HTTPS required');
    if (!basicAuthorized(req.headers.authorization, env.DASHBOARD_EMAIL, env.DASHBOARD_PASSWORD)) {
      return reply(res, 401, 'Authentication required', undefined, { 'WWW-Authenticate': 'Basic realm="MintBot dashboard", charset="UTF-8"' });
    }
    if (req.method !== 'GET') return reply(res, 405, 'GET required', undefined, { Allow: 'GET' });
    if (req.headers['transfer-encoding'] || req.headers['content-length'] && req.headers['content-length'] !== '0') return reply(res, 400, 'Request body rejected');
    const raw = req.url ?? '';
    if (!dashboardPath(raw, true)) return reply(res, 404, 'Not found');
    const release = acquire();
    if (!release) return reply(res, 429, 'Try again later');
    try {
      originUrl(env.READ_MODEL_ORIGIN);
      if (env.READ_MODEL_GATEWAY_TOKEN === env.DASHBOARD_PASSWORD) throw new Error('Independent credentials required');
      let failed = false;
      const client = new ReadModelClient({ get: async ({ path }) => {
        try { return normalizeFreshness(await transport(path, { origin: env.READ_MODEL_ORIGIN, token: env.READ_MODEL_GATEWAY_TOKEN })); }
        catch { failed = true; throw new Error('Read model unavailable'); }
      } });
      const query = new URL(raw, 'https://dashboard.invalid').searchParams;
      const readinessId = query.get('readiness');
      const snapshot = await client.getDashboard(readinessId ?? undefined, query.has('page') ? Number(query.get('page')) : 1);
      const unavailable = failed || Object.values(snapshot).some(value => value.availability === 'unavailable');
      reply(res, unavailable ? 503 : 200, renderDocument(snapshot), 'text/html; charset=utf-8');
    } catch { reply(res, 503, 'Read model unavailable; freshness unknown.'); }
    finally { release(); }
  };
}
export default createHandler();
