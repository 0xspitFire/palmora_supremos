import { describe, expect, it } from 'vitest';
import type { ChainScanOutcome, DropSnapshot, IntelligenceChainPort, SimulationOutcome } from '@mint-bot/backend';
import { checkDrop, planAutoQuantity } from './drop-check.js';

const NFT = '0x3333333333333333333333333333333333333333';
const W1 = '0x1111111111111111111111111111111111111111';
const W2 = '0x2222222222222222222222222222222222222222';
const W3 = '0x4444444444444444444444444444444444444444';
const NOW = new Date('2026-09-29T12:00:00.000Z');
const nowSeconds = Math.floor(NOW.getTime() / 1000);

class Port implements IntelligenceChainPort {
  public readonly chainId = 1 as const;
  public code: boolean | null = true;
  public drop: DropSnapshot | null = { nftContract: NFT, priceWei: 0n, startTime: nowSeconds - 60, endTime: 0, maxPerWallet: 5, maxSupply: null, totalMinted: null };
  public balances = new Map<string, bigint>();
  public simulation: SimulationOutcome = { outcome: 'pass' };
  public simulated: Array<[string, number, bigint]> = [];
  public async safeHead(): Promise<bigint | null> { return 1n; }
  public async scan(): Promise<ChainScanOutcome> { return { ok: false, reason: 'unused' }; }
  public async readDrop(): Promise<DropSnapshot | null> { return this.drop; }
  public async hasCode(): Promise<boolean | null> { return this.code; }
  public async balance(address: string): Promise<bigint | null> { return this.balances.get(address) ?? null; }
  public async simulateMint(wallet: string, _contract: string, quantity: number, value: bigint): Promise<SimulationOutcome> { this.simulated.push([wallet, quantity, value]); return this.simulation; }
}

describe('checkDrop (CLI validate/simulate)', () => {
  it('validates a free mint at the full per-wallet allowance and gives plain top-up guidance', async () => {
    const port = new Port();
    port.balances.set(W1, 500_000_000_000_000n);
    port.balances.set(W2, 100_000_000_000_000n);
    const report = await checkDrop(port, NFT, [W1, W2], { simulate: false, now: NOW });
    expect(report).toMatchObject({ verdict: 'unknown', quantity: 5, drop: { priceEth: '0', status: 'open' } });
    expect(report.wallets[0]).toMatchObject({ verdict: 'funded', requiredEth: '0.0004' });
    expect(report.wallets[1]).toMatchObject({ verdict: 'needs ETH', topUpEth: '0.0003', note: 'Send 0.0003 ETH to this wallet on Ethereum.' });
    expect(report.summary).toContain('You asked for at least 4 wallets');
    expect(port.simulated).toEqual([]);
  });

  it('simulates a paid mint with the real price for at most two wallets, planning quantity by score', async () => {
    const port = new Port();
    port.drop = { ...port.drop!, priceWei: 1_000_000_000_000_000n };
    for (const wallet of [W1, W2, W3]) port.balances.set(wallet, 10n ** 18n);
    const report = await checkDrop(port, NFT, [W1, W2, W3], { simulate: true, score: 75, now: NOW });
    expect(report).toMatchObject({ verdict: 'ok', quantity: 2 });
    expect(report.wallets.map((row) => row.verdict)).toEqual(['ready', 'ready']);
    expect(port.simulated).toEqual([[W1, 2, 2_000_000_000_000_000n], [W2, 2, 2_000_000_000_000_000n]]);
    expect(report.summary).toContain('1 wallet(s) left out: paid mints use at most 2');
  });

  it('blocks on a failed simulation, an over-limit price, an ended mint, no contract, or no SeaDrop drop', async () => {
    const failing = new Port();
    failing.balances.set(W1, 10n ** 18n);
    failing.simulation = { outcome: 'fail', reason: 'supply' };
    expect((await checkDrop(failing, NFT, [W1], { simulate: true, now: NOW })).wallets[0]).toMatchObject({ verdict: 'blocked', simulation: 'failed' });
    const pricey = new Port();
    pricey.drop = { ...pricey.drop!, priceWei: 3_700_000_000_000_001n };
    expect((await checkDrop(pricey, NFT, [W1], { simulate: true, now: NOW })).summary).toContain('above your 0.0037 ETH per-NFT limit');
    const ended = new Port();
    ended.drop = { ...ended.drop!, endTime: nowSeconds - 1 };
    expect((await checkDrop(ended, NFT, [W1], { simulate: true, now: NOW })).summary).toBe('This mint has ended.');
    const empty = new Port();
    empty.code = false;
    expect((await checkDrop(empty, NFT, [W1], { simulate: true, now: NOW })).verdict).toBe('blocked');
    const noDrop = new Port();
    noDrop.drop = null;
    expect((await checkDrop(noDrop, NFT, [W1], { simulate: true, now: NOW })).summary).toBe('This contract has no SeaDrop public mint the bot supports.');
    expect((await checkDrop(new Port(), '0x12', [W1], { simulate: true, now: NOW })).verdict).toBe('blocked');
  });

  it('never runs the test mint call before the mint opens', async () => {
    const port = new Port();
    port.drop = { ...port.drop!, startTime: nowSeconds + 3600 };
    port.balances.set(W1, 10n ** 18n);
    const report = await checkDrop(port, NFT, [W1], { simulate: true, now: NOW });
    expect(report.wallets[0]).toMatchObject({ verdict: 'funded', simulation: 'not run' });
    expect(port.simulated).toEqual([]);
  });

  it('plans fewer NFTs for a free mint when fees are high and explains it in the report (D-037)', async () => {
    const port = new Port() as Port & { estimateMintGas?: (w: string, c: string, q: number) => Promise<bigint | null>; baseFeePerGasWei?: () => Promise<bigint | null> };
    port.estimateMintGas = async (_wallet, _contract, quantity) => 101_101n + 69_131n * BigInt(quantity);
    port.baseFeePerGasWei = async () => 450_000_000n;
    port.balances.set(W1, 10n ** 18n);
    const report = await checkDrop(port, NFT, [W1], { simulate: false, now: NOW });
    expect(report.quantity).toBe(3);
    expect(report.quantityPlan).toMatchObject({ desired: 5, planned: 3, reduced: true, reason: 'reduced_for_fees' });
    expect(report.summary).toContain('Planned 3 of 5 NFTs per wallet: at 1 gwei');
  });

  it('blocks a free mint with the reason when even one NFT does not fit, and never reduces an explicit quantity', async () => {
    const port = new Port() as Port & { estimateMintGas?: (w: string, c: string, q: number) => Promise<bigint | null>; baseFeePerGasWei?: () => Promise<bigint | null> };
    port.estimateMintGas = async (_wallet, _contract, quantity) => 101_101n + 69_131n * BigInt(quantity);
    port.baseFeePerGasWei = async () => 3n * 10n ** 9n;
    port.balances.set(W1, 10n ** 18n);
    const blocked = await checkDrop(port, NFT, [W1], { simulate: false, now: NOW });
    expect(blocked).toMatchObject({ verdict: 'blocked', quantity: 0, quantityPlan: { reason: 'cannot_fit_one' } });
    const explicit = await checkDrop(port, NFT, [W1], { simulate: false, quantity: 2, now: NOW });
    expect(explicit.quantity).toBe(2);
    expect(explicit.quantityPlan).toBeUndefined();
  });

  it('plans `mint --auto-quantity` from the drop allowance, refuses a drop with no allowance, and refuses when 1 does not fit', async () => {
    const port = new Port() as Port & { estimateMintGas?: (w: string, c: string, q: number) => Promise<bigint | null>; baseFeePerGasWei?: () => Promise<bigint | null> };
    port.estimateMintGas = async (_wallet, _contract, quantity) => 101_101n + 69_131n * BigInt(quantity);
    port.baseFeePerGasWei = async () => 450_000_000n;
    const plan = await planAutoQuantity(port, { contract: NFT, wallet: W1, maxPerWallet: 5 });
    expect(plan).toMatchObject({ desired: 5, planned: 3, reduced: true });
    const asked = await planAutoQuantity(port, { contract: NFT, wallet: W1, maxPerWallet: 2 });
    expect(asked.planned).toBeLessThanOrEqual(2);
    await expect(planAutoQuantity(port, { contract: NFT, wallet: W1, maxPerWallet: 0 })).rejects.toThrow('NO_MINT_ALLOWANCE');
    port.baseFeePerGasWei = async () => 3n * 10n ** 9n;
    await expect(planAutoQuantity(port, { contract: NFT, wallet: W1, maxPerWallet: 5 })).rejects.toThrow('FEES_TOO_HIGH_FOR_FREE_MINT');
    port.baseFeePerGasWei = async () => null;
    await expect(planAutoQuantity(port, { contract: NFT, wallet: W1, maxPerWallet: 5 })).rejects.toThrow('BASE_FEE_UNAVAILABLE');
    await expect(planAutoQuantity(new Port(), { contract: NFT, wallet: W1, maxPerWallet: 5 })).rejects.toThrow('AUTO_QUANTITY_NEEDS_GAS_ESTIMATES');
  });
});
