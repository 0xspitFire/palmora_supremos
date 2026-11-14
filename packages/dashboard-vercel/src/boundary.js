import { createHash, timingSafeEqual } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { lookup } from 'node:dns';
import { isIP } from 'node:net';

export const MAX_BYTES = 2 * 1024 * 1024;
export const DEADLINE_MS = 6000;
const ROUTES = new Set(['home', 'calendar', 'alerts', 'health', 'analytics']);
// Canonical calendar IDs contain colons. Only that exact escape is accepted;
// encoded separators, dots and double-encoding never reach the backend.
const ID = '(?:[A-Za-z0-9_:-]|%3[Aa]){1,100}';
export function dashboardPath(path, frontend = false) {
  const page = 'page=[1-9][0-9]{0,3}';
  const readiness = `readiness=${ID}`;
  return typeof path === 'string' && path.length < 256 && new RegExp(`^${frontend ? '/(?:api/index)?' : '/api/v1/read-model/dashboard'}(?:\\?(?:${readiness}(?:&${page})?|${page}(?:&${readiness})?))?$`).test(path);
}
export function allowedPath(path) {
  return typeof path === 'string' && path.length < 256 && (
    dashboardPath(path)
    || ROUTES.has(path.replace(/^\/api\/v1\/read-model\//, '')) && path.startsWith('/api/v1/read-model/')
    || new RegExp(`^/api/v1/read-model/campaigns/${ID}/readiness$`).test(path));
}
export function equalSecret(actual, expected) {
  const hash = value => createHash('sha256').update(value).digest();
  return typeof actual === 'string' && typeof expected === 'string' && timingSafeEqual(hash(actual), hash(expected));
}
export function basicAuthorized(header, email, password) {
  if (!email || email.includes(':') || !password || password.length < 32 || password.length > 512) return false;
  if (typeof header !== 'string' || header.length > 2048 || !/^Basic [A-Za-z0-9+/]+={0,2}$/.test(header)) return false;
  return equalSecret(header, `Basic ${Buffer.from(`${email}:${password}`).toString('base64')}`);
}
export function originUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash || isIP(url.hostname) || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(url.hostname)) throw new Error('Invalid origin');
  return url;
}
export function publicAddress(address) {
  if (isIP(address) === 6) return /^[23][0-9a-f]{3}:/i.test(address) && !/^2001:/i.test(address) && !/^2002:/i.test(address);
  if (isIP(address) !== 4) return false;
  const [a, b] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 || b === 2 || b === 88) || a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19 || b === 51) || a === 203 && b === 0);
}
function publicLookup(hostname, options, callback) {
  lookup(hostname, { all: true }, (error, addresses) => {
    if (error || !addresses.length || addresses.some(item => !publicAddress(item.address))) return callback(new Error('Origin DNS rejected'));
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  });
}
export const SECURITY_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000',
};
export function reply(res, status, body, type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, ...extra });
  res.end(body);
}
export function gate(limit = 8) {
  let active = 0; let count = 0; let windowStart = Date.now();
  return () => {
    if (Date.now() - windowStart > 60000) { count = 0; windowStart = Date.now(); }
    if (++count > 120 || active >= limit) return null;
    active++;
    return () => { active--; };
  };
}
/** No redirect following, caller headers, arbitrary URLs or upstream headers. */
export function fetchReadModel(path, { origin, token, loopback = false, deadlineMs = DEADLINE_MS }) {
  if (!allowedPath(path)) return Promise.reject(new Error('Route rejected'));
  if (!token || token.length < 32 || token.length > 512 || /[\r\n]/.test(token)) return Promise.reject(new Error('Token rejected'));
  const url = loopback ? new URL('http://127.0.0.1:8780') : originUrl(origin);
  return new Promise((resolve, reject) => {
    const request = (loopback ? httpRequest : httpsRequest)({
      protocol: url.protocol, hostname: url.hostname, port: loopback ? 8780 : 443,
      path, method: 'GET', headers: { Accept: 'application/json', ...(loopback ? { Host: '127.0.0.1:8780' } : { Authorization: `Bearer ${token}` }) },
      ...(loopback ? {} : { lookup: publicLookup }),
    });
    const timer = setTimeout(() => request.destroy(new Error('Deadline exceeded')), deadlineMs);
    request.on('error', reject);
    request.on('close', () => clearTimeout(timer));
    request.on('response', response => {
      if (response.statusCode !== 200 || !/^application\/json(?:;|$)/i.test(response.headers['content-type'] ?? '')) {
        response.resume(); request.destroy(new Error('Origin unavailable')); return;
      }
      const chunks = []; let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_BYTES) request.destroy(new Error('Response too large'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new Error('Invalid response')); }
      });
    });
    request.end();
  });
}
/** Invalid freshness must never be promoted to fresh. Walk nested read models too. */
export function normalizeFreshness(value, now = Date.now(), depth = 0) {
  if (depth > 48) throw new Error('Response nesting exceeded');
  if (Array.isArray(value)) return value.map(item => normalizeFreshness(item, now, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const result = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeFreshness(item, now, depth + 1)]));
  if (Object.hasOwn(result, 'freshness')) {
    const f = result.freshness;
    const observed = Date.parse(f?.observedAt); const expires = Date.parse(f?.expiresAt);
    if (!f || !['fresh', 'stale', 'unknown'].includes(f.status) || !Number.isFinite(observed) || !Number.isFinite(expires) || observed > now || expires < observed) {
      result.freshness = { status: 'unknown', observedAt: null, expiresAt: null, ageSeconds: null, policyVersion: null };
    } else result.freshness = { ...f, status: f.status === 'fresh' && expires <= now ? 'stale' : f.status, ageSeconds: String(Math.max(0, Math.floor((now - observed) / 1000))) };
  }
  return result;
}
