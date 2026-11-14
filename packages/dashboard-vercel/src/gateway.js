import { createServer } from 'node:http';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isAbsolute } from 'node:path';
import { allowedPath, equalSecret, fetchReadModel, gate, reply } from './boundary.js';

export async function loadToken(path) {
  if (!path || !isAbsolute(path)) throw new Error('Absolute token file path required');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 513 || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.()) throw new Error('Token file must be owner-only mode 0600');
    const token = (await file.readFile('utf8')).trim();
    if (!/^[A-Za-z0-9_-]{32,512}$/.test(token)) throw new Error('Token must be 32–512 URL-safe characters');
    return token;
  } finally { await file.close(); }
}
export function createGateway(token, transport = fetchReadModel) {
  if (!/^[A-Za-z0-9_-]{32,512}$/.test(token ?? '')) throw new Error('Invalid gateway token');
  const acquire = gate(8);
  const server = createServer({ maxHeaderSize: 8192 }, async (req, res) => {
    if (!equalSecret(req.headers.authorization, `Bearer ${token}`)) return reply(res, 401, 'Authentication required');
    if (req.method !== 'GET') return reply(res, 405, 'GET required', undefined, { Allow: 'GET' });
    if (req.headers['transfer-encoding'] || req.headers['content-length'] && req.headers['content-length'] !== '0') return reply(res, 400, 'Request body rejected');
    if (!allowedPath(req.url)) return reply(res, 404, 'Not found');
    const release = acquire();
    if (!release) return reply(res, 429, 'Try again later');
    try {
      const value = await transport(req.url, { loopback: true, token });
      reply(res, 200, JSON.stringify(value), 'application/json; charset=utf-8');
    } catch { reply(res, 503, 'Read model unavailable'); }
    finally { release(); }
  });
  server.requestTimeout = 8000;
  server.headersTimeout = 8000;
  server.keepAliveTimeout = 1000;
  server.maxRequestsPerSocket = 10;
  server.maxConnections = 32;
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const token = await loadToken(process.env.READ_MODEL_GATEWAY_TOKEN_FILE);
    createGateway(token).on('error', () => {
      console.error('Dashboard gateway listener unavailable.');
      process.exitCode = 1;
    }).listen(8781, '127.0.0.1');
  } catch {
    console.error('Dashboard gateway startup failed; check protected token file and listener configuration.');
    process.exitCode = 1;
  }
}
