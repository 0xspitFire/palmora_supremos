import { describe, expect, it, vi } from 'vitest';
import type { Address, PublicClient } from 'viem';
import { registerStrategy, type DropConfig } from '@mint-bot/engine';
import { EngineIntelligencePort } from './intelligence-adapter.js';

describe('simulation is bound to the campaign method', () => {
  it('never records an allowlist simulation for a public campaign when the collection has both phases', async () => {
    const nft = '0x1111111111111111111111111111111111111111' as Address;
    const fee = '0x2222222222222222222222222222222222222222' as Address;
    const wl: DropConfig = { chainId: 1, nftContract: nft, feePayer: fee, mintPrice: 999n, maxTotalMintableByWallet: 1, maxTokenSupply: 100n, totalMinted: 0n, startTime: 1, endTime: 2_000_000_000, strategyName: 'seadrop-v1-allowlist' };
    registerStrategy({ name: 'seadrop-v1-allowlist', readDrop: async () => wl, buildCalldata: () => '0xdeadbeef', estimateGas: async () => 100_000n, validateDrop: () => ({ valid: true, errors: [], warnings: [] }) });
    const client = { readContract: vi.fn(async (args: { functionName: string }) => args.functionName === 'getPublicDrop' ? { mintPrice: 0n, startTime: 1, endTime: 2_000_000_000, maxTotalMintableByWallet: 1, restrictFeeRecipients: false, feeBps: 0 } : 100n), getBlockNumber: async () => 100n, call: vi.fn(async () => ({})) };
    const auto = new EngineIntelligencePort(client as unknown as PublicClient);
    expect((await auto.readDrop(nft))?.priceWei).toBe(999n);
    const publicPort = new EngineIntelligencePort(client as unknown as PublicClient, { publicOnly: true });
    expect((await publicPort.readDrop(nft))?.priceWei).toBe(0n);
    await expect(publicPort.simulateMint(fee, nft, 1, 0n)).resolves.toEqual({ outcome: 'pass' });
    expect(client.call).toHaveBeenCalledWith(expect.objectContaining({ data: expect.stringMatching(/^0x161ac21f/) }));
  });
});
