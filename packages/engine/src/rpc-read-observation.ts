/** Fixed diagnostic vocabulary. Never expose provider messages, request arguments or URLs. */
export type RpcReadMethod = 'eth_chainId' | 'eth_blockNumber' | 'eth_getLogs' | 'eth_getBalance' | 'eth_getCode' | 'eth_call' | 'eth_estimateGas' | 'eth_getBlockByNumber' | 'other';
export type RpcReadOutcome = 'success' | 'timeout' | 'cancelled' | 'rate_limited' | 'monthly_capacity' | 'http_error' | 'rpc_error' | 'invalid_response' | 'network_error' | 'uninspected';
export interface RpcReadObservation { endpointIndex: number; method: RpcReadMethod; outcome: RpcReadOutcome; durationMs: number; }
const METHODS = new Set<string>(['eth_chainId','eth_blockNumber','eth_getLogs','eth_getBalance','eth_getCode','eth_call','eth_estimateGas','eth_getBlockByNumber']);
export function diagnosticRpcMethod(body: unknown): RpcReadMethod {
  if (typeof body !== 'string' || body.length > 131072) return 'other';
  try { const value: unknown = JSON.parse(body); if (value && typeof value === 'object' && !Array.isArray(value) && 'method' in value && typeof value.method === 'string' && METHODS.has(value.method)) return value.method as RpcReadMethod; } catch { /* fixed fallback only */ }
  return 'other';
}
export function diagnosticRpcOutcome(status: number, bytes?: Uint8Array, method?: RpcReadMethod): RpcReadOutcome {
  if (status === 429) return 'rate_limited';
  if (bytes && bytes.byteLength > 16_384) return 'uninspected';
  let value: unknown;
  try { value = bytes ? JSON.parse(new TextDecoder().decode(bytes)) : undefined; } catch { return status === 429 ? 'rate_limited' : status >= 400 ? 'http_error' : 'invalid_response'; }
  if (method === 'eth_blockNumber' && status < 400) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !('jsonrpc' in value) || value.jsonrpc !== '2.0') return 'invalid_response';
    if (!('error' in value)) {
      return 'result' in value && typeof value.result === 'string' && /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/.test(value.result) ? 'success' : 'invalid_response';
    }
    const rpcError = value.error;
    if ('result' in value || !rpcError || typeof rpcError !== 'object' || Array.isArray(rpcError) || !('code' in rpcError)
      || !Number.isInteger(rpcError.code) || !('message' in rpcError) || typeof rpcError.message !== 'string') return 'invalid_response';
  }
  const error = value && typeof value === 'object' && !Array.isArray(value) && 'error' in value ? value.error : undefined;
  const message = error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ? error.message : '';
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (status === 429 || code === 429) return 'rate_limited';
  const boundedMessage = message.slice(0, 512).toLowerCase();
  if (boundedMessage.includes('monthly') && boundedMessage.includes('exceed') && ['capacity','compute unit','quota','limit'].some(term => boundedMessage.includes(term))) return 'monthly_capacity';
  if (status >= 400) return 'http_error';
  if (error !== undefined) return 'rpc_error';
  return value && typeof value === 'object' && !Array.isArray(value) && 'result' in value ? 'success' : 'invalid_response';
}
