import { describe, expect, it } from 'vitest';
import { createPublicClient, http, type Address } from 'viem';
import { buildReplicationPlan } from './replication.js';
import { SeaDropV1PublicStrategy } from './strategies/seadrop-v1-public.js';
import { SEADROP_V1_ADDRESS } from './chains.js';

const rpc = process.env.ANVIL_ETHEREUM_RPC_URL;
const nft = process.env.ETHEREUM_SEADROP_NFT as Address | undefined;
const local = (value?: string) => { try { const url = new URL(value!); return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname); } catch { return false; } };

describe.skipIf(!local(rpc) || !nft)('pinned Ethereum archive SeaDrop replication (eth_call only)', () => {
  it('qualifies the pinned public drop and simulates three reconstructed own-wallet calls', async () => {
    const client = createPublicClient({ transport: http(rpc!) });
    // This RPC method must exist: the test cannot execute against a public mainnet endpoint.
    const response = await fetch(rpc!, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'anvil_nodeInfo', params: [] }) });
    expect((await response.json() as { result?: unknown }).result).toBeDefined();
    const accountsResponse = await fetch(rpc!, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'eth_accounts', params: [] }) });
    const accounts = (await accountsResponse.json() as { result: Address[] }).result;
    expect(accounts.length).toBeGreaterThanOrEqual(3);
    const strategy = new SeaDropV1PublicStrategy();
    const drop = await strategy.readDrop(client, nft!, 1);
    const data = strategy.buildCalldata(drop, accounts[0]!, 1);
    const plan = buildReplicationPlan({ observed: { chainId: 1, from: accounts[0]!, to: SEADROP_V1_ADDRESS, data, value: drop.mintPrice }, drop, targetWallets: accounts.slice(0, 3) });
    expect(plan.verdict).toBe('replicable');
    expect(plan.targets).toHaveLength(3);
    for (const target of plan.targets) await expect(client.call({ account: target.wallet, to: target.to, data: target.data, value: target.value })).resolves.toBeDefined();
  });
});
