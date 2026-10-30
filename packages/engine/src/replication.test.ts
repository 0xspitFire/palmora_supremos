import { describe, expect, it } from 'vitest';
import { type Address, type Hex, zeroAddress } from 'viem';
import { buildReplicationPlan } from './replication.js';
import { buildSeaDropPublicMintCalldata } from './strategies/seadrop-v1-public.js';
import type { DropConfig } from './types.js';

const NFT = '0x1111111111111111111111111111111111111111' as Address;
const FEE = '0x2222222222222222222222222222222222222222' as Address;
const SOURCE = '0x3333333333333333333333333333333333333333' as Address;
const WALLET_A = '0x4444444444444444444444444444444444444444' as Address;
const WALLET_B = '0x5555555555555555555555555555555555555555' as Address;
const drop: DropConfig = {
  nftContract: NFT,
  mintPrice: 100n,
  maxTotalMintableByWallet: 5,
  maxTokenSupply: 100n,
  totalMinted: 0n,
  startTime: 1,
  endTime: 2_000_000_000,
  feePayer: FEE,
  strategyName: 'seadrop-v1-public',
  chainId: 1,
  extra: { seaDropAddress: '0x00005ea00ac477b1030ce78506496e8c2de24bf5' },
};

const observed = (data: Hex, overrides: Partial<{ to: Address; value: bigint; chainId: 1 | 8453 | 4663 }> = {}) => ({
  chainId: overrides.chainId ?? 1,
  from: SOURCE,
  to: overrides.to ?? drop.extra!['seaDropAddress'] as Address,
  value: overrides.value ?? 200n,
  data,
  hash: `0x${'a'.repeat(64)}` as `0x${string}`,
});

describe('qualified SeaDrop replication', () => {
  it('decodes a public mint and reconstructs calldata for each target wallet', () => {
    const data = buildSeaDropPublicMintCalldata(NFT, FEE, 2);
    const plan = buildReplicationPlan({ observed: observed(data), drop, targetWallets: [WALLET_A, WALLET_B, WALLET_A] });
    expect(plan.verdict).toBe('replicable');
    expect(plan.targets).toHaveLength(2);
    expect(plan.targets[0]).toMatchObject({ wallet: WALLET_A, quantity: 2, value: 200n, data });
    expect(plan.checklist.walletIndependent).toBe(true);
    expect(plan.operatorApprovalRequired).toBe(true);
  });

  it('refuses wallet-bound calldata instead of copying another wallet recipient', () => {
    const data = buildSeaDropPublicMintCalldata(NFT, FEE, 2).replace(
      zeroAddress.slice(2),
      SOURCE.slice(2),
    ) as Hex;
    const plan = buildReplicationPlan({ observed: observed(data), drop, targetWallets: [WALLET_A] });
    expect(plan.verdict).toBe('not_replicable');
    expect(plan.reasons.map((item) => item.code)).toContain('WALLET_BOUND_ARGUMENT');
    expect(plan.targets).toEqual([]);
  });

  it('refuses an unknown selector and target mismatch', () => {
    const plan = buildReplicationPlan({ observed: observed('0xdeadbeef' as Hex, { to: NFT }), drop, targetWallets: [WALLET_A] });
    expect(plan.verdict).toBe('not_replicable');
    expect(plan.reasons.map((item) => item.code)).toEqual(expect.arrayContaining(['TARGET_NOT_SEADROP', 'UNKNOWN_SELECTOR']));
  });

  it('refuses value, chain, and quantity mismatches', () => {
    const data = buildSeaDropPublicMintCalldata(NFT, FEE, 6);
    const plan = buildReplicationPlan({ observed: observed(data, { value: 1n, chainId: 8453 }), drop, targetWallets: [WALLET_A] });
    expect(plan.verdict).toBe('not_replicable');
    expect(plan.reasons.map((item) => item.code)).toEqual(expect.arrayContaining(['CHAIN_MISMATCH', 'VALUE_MISMATCH', 'QUANTITY_EXCEEDS_DROP_LIMIT']));
  });

  it('does not create a plan without destination wallets', () => {
    const data = buildSeaDropPublicMintCalldata(NFT, FEE, 1);
    const plan = buildReplicationPlan({ observed: observed(data, { value: 100n }), drop, targetWallets: [] });
    expect(plan.verdict).toBe('not_replicable');
    expect(plan.reasons).toContainEqual({ code: 'NO_TARGET_WALLETS', message: 'No valid destination wallets were supplied' });
  });
});
