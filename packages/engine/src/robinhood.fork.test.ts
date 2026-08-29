import { describe, expect, it } from 'vitest';

const rpcUrl = process.env.ANVIL_RPC_URL;
const seaDropSingleton = '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5';

async function rpc(method: string, params: unknown[] = []) {
  const response = await fetch(rpcUrl!, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await response.json() as { result?: string; error?: { message?: string } };
  if (!response.ok || body.error) throw new Error(body.error?.message ?? `RPC ${method} failed`);
  return body.result;
}

describe.skipIf(!rpcUrl)('Robinhood archive fork', () => {
  it('runs against local Anvil with forked Robinhood state', async () => {
    expect(await rpc('eth_chainId')).toBe('0x7a69');
    expect(BigInt((await rpc('eth_blockNumber'))!)).toBeGreaterThan(0n);
    const code = await rpc('eth_getCode', [seaDropSingleton, 'latest']);
    expect(code).not.toBe('0x');
  });
});
