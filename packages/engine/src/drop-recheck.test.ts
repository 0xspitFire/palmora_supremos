import { describe, expect, it, vi } from 'vitest';
import { CAMPAIGN_CHANGED_MID_RUN, createDropRecheck, describeDropChange } from './drop-recheck.js';
import type { DropConfig, DropValidation } from './types.js';

const NFT = '0x1111111111111111111111111111111111111111' as const;
const drop = (overrides: Partial<DropConfig> = {}): DropConfig => ({
  nftContract: NFT, mintPrice: 0n, maxTotalMintableByWallet: 5, maxTokenSupply: 1000n, totalMinted: 10n, startTime: 100, endTime: 9_999_999_999,
  feePayer: '0x2222222222222222222222222222222222222222', strategyName: 'seadrop-v1-public', chainId: 1, extra: { seaDropAddress: '0x3333333333333333333333333333333333333333', allowed: ['a'] }, ...overrides,
});
const valid: DropValidation = { valid: true, errors: [], warnings: [] };

describe('D-081 describeDropChange', () => {
  it('ignores the moving mint count and equal settings written in another key order', () => {
    expect(describeDropChange(drop(), drop({ totalMinted: 500n, extra: { allowed: ['a'], seaDropAddress: '0x3333333333333333333333333333333333333333' } }), valid)).toBeUndefined();
  });

  it('names what changed and never prints values', () => {
    const text = describeDropChange(drop(), drop({ mintPrice: 10n ** 15n, endTime: 5, feePayer: '0x4444444444444444444444444444444444444444', maxTotalMintableByWallet: 1 }), valid)!;
    expect(text).toBe('price, per-wallet limit, end time, fee recipient');
    expect(text).not.toMatch(/0x|\d{6,}/);
  });

  it('stops when the drop is no longer valid even if no field changed', () => {
    expect(describeDropChange(drop(), drop(), { valid: false, errors: ['sold out'], warnings: [] })).toMatch(/no longer valid/);
  });

  it('detects a change in the contract settings and the target contract', () => {
    expect(describeDropChange(drop(), drop({ extra: { seaDropAddress: '0x5555555555555555555555555555555555555555', allowed: ['a'] } }), valid)).toBe('contract settings');
    expect(describeDropChange(drop(), drop({ nftContract: '0x6666666666666666666666666666666666666666' }), valid)).toBe('contract');
  });
});

describe('D-081 createDropRecheck', () => {
  it('shares one read between wallets that ask at the same time, then reads again after the reuse window', async () => {
    let clock = 0;
    const read = vi.fn(async () => ({ drop: drop(), validation: valid }));
    const check = createDropRecheck({ initial: drop(), read, now: () => clock, reuseMs: 1_500 });
    expect(await Promise.all([check(), check(), check()])).toEqual([undefined, undefined, undefined]);
    expect(read).toHaveBeenCalledTimes(1);
    clock = 2_000;
    await check();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('reports a change to every concurrent wallet', async () => {
    const check = createDropRecheck({ initial: drop(), read: async () => ({ drop: drop({ mintPrice: 1n }), validation: valid }) });
    expect(await Promise.all([check(), check()])).toEqual(['price', 'price']);
  });

  it('reports unknown (and tells the caller) when the read fails or times out, never a change', async () => {
    const onUnavailable = vi.fn();
    const failing = createDropRecheck({ initial: drop(), read: async () => { throw new Error('rpc down https://secret.example/key'); }, onUnavailable });
    expect(await failing()).toBe('unknown');
    const hanging = createDropRecheck({ initial: drop(), read: () => new Promise(() => undefined), timeoutMs: 20, onUnavailable });
    expect(await hanging()).toBe('unknown');
    expect(onUnavailable).toHaveBeenCalledTimes(2);
  });
});

describe('D-081 engine wiring', () => {
  it('re-reads only on live runs, before the simulation lookup, the nonce and the reservation, and skips the wallet with the fixed code', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('./mint-engine.ts', import.meta.url), 'utf8');
    expect(source).toContain('this.config.safety.dryRun ? undefined : createDropRecheck(');
    const check = source.indexOf('await recheckDrop?.()');
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(source.indexOf('const simulation = simulations.get(walletIndex)'));
    expect(check).toBeLessThan(source.indexOf('await nonceManager.getNonce(walletAddress)'));
    expect(check).toBeLessThan(source.indexOf('reservationProvider.reserve(reserveRequest)'));
    expect(source).toContain('${CAMPAIGN_CHANGED_MID_RUN}: ${dropChange}');
    expect(CAMPAIGN_CHANGED_MID_RUN).toBe('CAMPAIGN_CHANGED_MID_RUN');
  });
});
