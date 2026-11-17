/** Public provider capability only; never return or log the URL or its key. */
export function isAlchemyRpcEndpoint(url: string): boolean {
  try { const parsed = new URL(url); return parsed.protocol === 'https:' && parsed.hostname.endsWith('.g.alchemy.com'); } catch { return false; }
}
/** Free-tier eth_getLogs supports at most ten inclusive numeric blocks. */
export function alchemyFreeRequestSupported(body: unknown): boolean {
  if (typeof body !== 'string' || body.length > 131072) return false;
  try {
    const value: unknown = JSON.parse(body);
    if (!value || typeof value !== 'object' || Array.isArray(value) || !('method' in value)) return false;
    if (value.method !== 'eth_getLogs') return true;
    if (!('params' in value) || !Array.isArray(value.params) || value.params.length !== 1) return false;
    const filter: unknown = value.params[0];
    if (!filter || typeof filter !== 'object' || Array.isArray(filter)) return false;
    if ('blockHash' in filter) return !('fromBlock' in filter) && !('toBlock' in filter) && typeof filter.blockHash === 'string' && /^0x[0-9a-f]{64}$/i.test(filter.blockHash);
    if (!('fromBlock' in filter) || !('toBlock' in filter) || typeof filter.fromBlock !== 'string' || typeof filter.toBlock !== 'string') return false;
    if (![filter.fromBlock,filter.toBlock].every(value => /^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/i.test(value))) return false;
    const from = BigInt(filter.fromBlock), to = BigInt(filter.toBlock);
    return to >= from && to - from < 10n;
  } catch { return false; }
}
