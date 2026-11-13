import { describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import type { QualifiedSource } from './replication-source.js';
import { buildReplicationPlan, buildSeaDropPublicMintCalldata, SEADROP_V1_ADDRESS, type DropConfig } from '@mint-bot/engine';
import { fundedReplicationWallets, replicationFundingRequirement } from './replication-prepare.js';
const wallet = `0x${'1'.repeat(40)}` as Address;
const other = `0x${'2'.repeat(40)}` as Address;
function source(chainId: 1 | 8453 | 4663): QualifiedSource {
  const drop: DropConfig = { chainId, mintPrice: 0n, maxTotalMintableByWallet: 10, nftContract: other, feePayer: wallet, strategyName: 'seadrop-v1-public', maxTokenSupply: 100n, totalMinted: 0n, startTime: 1, endTime: 2_000_000_000 };
  const observed = { chainId, from: wallet, to: SEADROP_V1_ADDRESS, value: 0n, data: buildSeaDropPublicMintCalldata(other, wallet, 2) };
  return { drop, observed, mintedAt: '2026-11-07T00:00:00Z', plan: buildReplicationPlan({ observed, drop, targetWallets: [wallet, other] }) };
}
describe('funding before a one-shot replication claim', () => {
  it.each([[1, 400_000_000_000_000n], [8453, 200_000_000_000_000n], [4663, 200_000_000_000_000n]] as const)('keeps chain %s reserve arithmetic in wei', (chainId, reserve) => {
    expect(replicationFundingRequirement(source(chainId), 10)).toBe(reserve);
  });
  it('keeps only target wallets with independently readable sufficient balance', async () => {
    const read = vi.fn(async (address: Address) => address === wallet ? 200_000_000_000_000n : 0n);
    expect(await fundedReplicationWallets(source(4663), [wallet, other], 10, read)).toEqual([wallet]);
    read.mockRejectedValue(new Error('untrusted RPC response'));
    await expect(fundedReplicationWallets(source(4663), [wallet, other], 10, read)).rejects.toThrow('REPLICATION_BALANCE_UNAVAILABLE');
  });
  it('does not confuse a zero balance with unavailable RPC authority or read unrelated wallets', async () => {
    const read = vi.fn(async () => 0n);
    expect(await fundedReplicationWallets(source(8453), [wallet], 10, read)).toEqual([]);
    const irrelevant = `0x${'3'.repeat(40)}` as Address;
    read.mockClear();
    expect(await fundedReplicationWallets(source(8453), [irrelevant], 10, read)).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });
});
