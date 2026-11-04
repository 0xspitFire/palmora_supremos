import { describe, expect, it, vi } from 'vitest';
import type { Campaign, BackendStore } from '@mint-bot/backend';
import type { PublicClient } from 'viem';
import { simulateAllowlistCampaign } from './allowlist-execution.js';
const state = vi.hoisted(() => ({ records: [] as unknown[], calls: 0, recorded: [] as unknown[] }));
vi.mock('@mint-bot/engine', async (load) => ({ ...await load<typeof import('@mint-bot/engine')>(),
  readTurnkeyApprovedPolicyRecords: async () => state.records,
  turnkeyPolicySelection: () => ({ policyReference: 'policy-ref', recordDigest: 'record-digest' }),
  getStrategy: () => ({ readDrop: async () => ({ mintPrice: 0n, maxTotalMintableByWallet: 4, extra: { seaDropAddress: '0x3333333333333333333333333333333333333333' } }), validateDrop: () => ({ valid: true }), buildCalldata: (_drop: unknown, wallet: string) => wallet.toLowerCase().endsWith('1') ? '0x1111' : '0x2222' }),
}));
vi.mock('@mint-bot/backend', async (load) => ({ ...await load<typeof import('@mint-bot/backend')>(), recordWalletSimulations: async (_store: unknown, _campaign: unknown, rows: unknown[]) => { state.recorded = rows; } }));
const walletA = '0x1111111111111111111111111111111111111111';
const walletB = '0x2222222222222222222222222222222222222222';
const campaign = { id: 'campaign', chainId: 4663, contract: '0x4444444444444444444444444444444444444444', strategy: 'seadrop-v1-allowlist', custodyPolicy: { policyReference: 'policy-ref', recordDigest: 'record-digest' }, quantity: 1, mintPriceWei: 0n } as unknown as Campaign;
const client = { getBlock: async () => ({ number: 1n, hash: `0x${'a'.repeat(64)}` }), call: async () => { state.calls += 1; } } as unknown as PublicClient;
const family = { enforcementPolicy: { family: { kind: 'seadrop-free-allowlist-v1', maxQuantity: 4 }, transaction: { chainId: 4663, valueWei: '0', from: [walletA, walletB], data: '0x4300a4e6' } } };
describe('allowlist simulation with signed custody', () => {
  it('simulates each own-wallet call under one matching free family record', async () => {
    state.records = [family]; state.calls = 0; state.recorded = [];
    const result = await simulateAllowlistCampaign({ campaign, wallets: [walletA, walletB], client, store: {} as BackendStore, secretRoot: '/not-read' });
    expect(result.recorded).toEqual([walletA, walletB]);
    expect(state.calls).toBe(2);
    expect(state.recorded).toEqual([{ wallet: walletA, success: true }, { wallet: walletB, success: true }]);
  });
  it('blocks wrong chain, over-limit and out-of-scope family calls', async () => {
    for (const changed of [{ ...family.enforcementPolicy, transaction: { ...family.enforcementPolicy.transaction, chainId: 1 } }, { ...family.enforcementPolicy, family: { ...family.enforcementPolicy.family, maxQuantity: 0 } }, { ...family.enforcementPolicy, transaction: { ...family.enforcementPolicy.transaction, from: [walletB] } }]) {
      state.records = [{ enforcementPolicy: changed }]; state.calls = 0;
      const result = await simulateAllowlistCampaign({ campaign, wallets: [walletA], client, store: {} as BackendStore, secretRoot: '/not-read' });
      expect(result.recorded).toEqual([]);
      expect(state.calls).toBe(0);
    }
  });
});
