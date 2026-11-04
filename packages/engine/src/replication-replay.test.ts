import { describe, expect, it } from 'vitest';
import { encodeFunctionData, zeroAddress, type Address, type Hex } from 'viem';
import { buildReplicationPlan } from './replication.js';
import { buildSeaDropPublicMintCalldata } from './strategies/seadrop-v1-public.js';
import { ALLOWLIST_MINT_ABI } from './allowlist-authority.js';
import { SEADROP_V1_ADDRESS } from './chains.js';
import type { DropConfig } from './types.js';

const nft = '0x1111111111111111111111111111111111111111' as Address;
const fee = '0x2222222222222222222222222222222222222222' as Address;
const wallet = '0x3333333333333333333333333333333333333333' as Address;
const drop: DropConfig = { chainId: 1, nftContract: nft, feePayer: fee, strategyName: 'seadrop-v1-public', mintPrice: 0n, maxTotalMintableByWallet: 5, maxTokenSupply: 100n, totalMinted: 0n, startTime: 1, endTime: 2_000_000_000 };
const publicData = (n = 1) => buildSeaDropPublicMintCalldata(nft, fee, n);
const merkle = encodeFunctionData({ abi: ALLOWLIST_MINT_ABI, functionName: 'mintAllowList', args: [nft, fee, zeroAddress, 1n, { mintPrice: 0n, maxTotalMintableByWallet: 1n, startTime: 1n, endTime: 2_000_000_000n, dropStageIndex: 1n, maxTokenSupplyForStage: 100n, feeBps: 0n, restrictFeeRecipients: false }, []] });

describe('approved SeaDrop deterministic replay matrix (no RPC or broadcasting)', () => {
  const cases = [
    { name: 'free public', data: publicData(), expected: undefined },
    { name: 'paid public', data: publicData(), price: 100n, value: 100n, expected: undefined },
    { name: 'exact wallet limit', data: publicData(5), expected: undefined },
    { name: 'above wallet limit', data: publicData(6), expected: 'QUANTITY_EXCEEDS_DROP_LIMIT' },
    { name: 'wallet-bound recipient', data: publicData().slice(0, 138) + wallet.slice(2).padStart(64, '0') + publicData().slice(202), expected: 'WALLET_BOUND_ARGUMENT' },
    { name: 'borrowed Merkle calldata', data: merkle, expected: 'UNKNOWN_SELECTOR' },
    { name: 'signed mint selector', data: '0x4b61cd3a', expected: 'UNKNOWN_SELECTOR' },
    { name: 'unknown selector', data: '0xdeadbeef', expected: 'UNKNOWN_SELECTOR' },
    { name: 'wrong target', data: publicData(), to: nft, expected: 'TARGET_NOT_SEADROP' },
    { name: 'wrong NFT', data: buildSeaDropPublicMintCalldata(fee, fee, 1), expected: 'CONTRACT_MISMATCH' },
    { name: 'wrong fee', data: buildSeaDropPublicMintCalldata(nft, nft, 1), expected: 'FEE_RECIPIENT_MISMATCH' },
    { name: 'wrong value', data: publicData(), value: 1n, expected: 'VALUE_MISMATCH' },
    { name: 'empty fleet', data: publicData(), empty: true, expected: 'NO_TARGET_WALLETS' },
  ];
  it.each(cases)('$name', (fixture) => {
    const plan = buildReplicationPlan({ observed: { chainId: 1, from: wallet, to: fixture.to ?? SEADROP_V1_ADDRESS, data: fixture.data as Hex, value: fixture.value ?? 0n }, drop: { ...drop, mintPrice: fixture.price ?? 0n }, targetWallets: fixture.empty ? [] : [wallet] });
    expect(plan.verdict).toBe(fixture.expected ? 'not_replicable' : 'replicable');
    if (fixture.expected) { expect(plan.reasons.map((reason) => reason.code)).toContain(fixture.expected); expect(plan.targets).toEqual([]); }
    else expect(plan.targets).toHaveLength(1);
    expect(plan.simulationRequired).toBe(true);
  });
});
