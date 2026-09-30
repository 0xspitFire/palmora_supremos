import { describe, expect, it } from 'vitest';
import { formatGwei, planFreeQuantity } from './quantity-plan.js';

const ALLOWANCE = 400_000_000_000_000n;
const GWEI = 10n ** 9n;
/** Measured SeaDrop gas (T-007): about 101,101 base plus 69,131 per NFT (1 NFT 170,232; 5 NFTs 446,756). */
const measuredGas = async (quantity: number): Promise<bigint> => 101_101n + 69_131n * BigInt(quantity);

describe('fee-aware free-mint quantity planning (T-012, D-037)', () => {
  it('keeps the full quantity when it fits, and explains it', async () => {
    const plan = await planFreeQuantity({ desired: 5, allowanceWei: ALLOWANCE, maxFeePerGasWei: GWEI / 2n, gasForQuantity: measuredGas });
    expect(plan).toMatchObject({ planned: 5, reduced: false, reason: 'full', maxFeeGwei: '0.5' });
    expect(plan.message).toContain('All 5 NFT(s) per wallet fit');
  });

  it('reduces to the largest quantity that fits and says why, matching the measured break-even points', async () => {
    const at1 = await planFreeQuantity({ desired: 5, allowanceWei: ALLOWANCE, maxFeePerGasWei: GWEI, gasForQuantity: measuredGas });
    expect(at1).toMatchObject({ planned: 3, reduced: true, reason: 'reduced_for_fees' });
    expect(at1.message).toBe('Planned 3 of 5 NFTs per wallet: at 1 gwei the 0.0004 ETH fee allowance only covers 3. More will be minted when fees are lower.');
    const at1_4 = await planFreeQuantity({ desired: 5, allowanceWei: ALLOWANCE, maxFeePerGasWei: 14n * GWEI / 10n, gasForQuantity: measuredGas });
    expect(at1_4.planned).toBe(1);
    const at0_72 = await planFreeQuantity({ desired: 5, allowanceWei: ALLOWANCE, maxFeePerGasWei: 719n * GWEI / 1000n, gasForQuantity: measuredGas });
    expect(at0_72.planned).toBe(5);
    const at0_75 = await planFreeQuantity({ desired: 5, allowanceWei: ALLOWANCE, maxFeePerGasWei: 750n * GWEI / 1000n, gasForQuantity: measuredGas });
    expect(at0_75.planned).toBeLessThan(5);
    expect(at0_75.planned).toBeGreaterThanOrEqual(1);
  });

  it('never plans a quantity whose padded worst case exceeds the allowance, for any fee', async () => {
    for (let gwei = 1n; gwei <= 3_000n; gwei += 37n) {
      const maxFee = gwei * GWEI / 1000n;
      const plan = await planFreeQuantity({ desired: 5, allowanceWei: ALLOWANCE, maxFeePerGasWei: maxFee, gasForQuantity: measuredGas });
      if (plan.planned > 0) {
        const gas = await measuredGas(plan.planned);
        expect(((gas * 12n + 9n) / 10n) * maxFee).toBeLessThanOrEqual(ALLOWANCE);
        if (plan.planned < 5) expect(((await measuredGas(plan.planned + 1) * 12n + 9n) / 10n) * maxFee).toBeGreaterThan(ALLOWANCE);
      }
    }
  });

  it('skips with a reason when not even one NFT fits', async () => {
    const plan = await planFreeQuantity({ desired: 5, allowanceWei: ALLOWANCE, maxFeePerGasWei: 5n * GWEI, gasForQuantity: measuredGas });
    expect(plan).toMatchObject({ planned: 0, reduced: true, reason: 'cannot_fit_one' });
    expect(plan.message).toContain('even 1 NFT would cost more than the 0.0004 ETH fee allowance');
  });

  it('does not reduce anything it cannot estimate, and refuses invalid input', async () => {
    const unknown = await planFreeQuantity({ desired: 3, allowanceWei: ALLOWANCE, maxFeePerGasWei: GWEI, gasForQuantity: async () => null });
    expect(unknown).toMatchObject({ planned: 3, reduced: false, reason: 'unknown', plannedWorstCaseWei: null });
    const partial = await planFreeQuantity({ desired: 5, allowanceWei: ALLOWANCE, maxFeePerGasWei: 14n * GWEI / 10n, gasForQuantity: async (q) => (q === 5 ? measuredGas(q) : null) });
    expect(partial.reason).toBe('unknown');
    await expect(planFreeQuantity({ desired: 0, allowanceWei: ALLOWANCE, maxFeePerGasWei: GWEI, gasForQuantity: measuredGas })).rejects.toThrow('QUANTITY_PLAN_INPUT_INVALID');
    await expect(planFreeQuantity({ desired: 2, allowanceWei: 0n, maxFeePerGasWei: GWEI, gasForQuantity: measuredGas })).rejects.toThrow('QUANTITY_PLAN_INPUT_INVALID');
    await expect(planFreeQuantity({ desired: 2, allowanceWei: ALLOWANCE, maxFeePerGasWei: -1n, gasForQuantity: measuredGas })).rejects.toThrow('QUANTITY_PLAN_INPUT_INVALID');
    expect(formatGwei(1_868_000_000n)).toBe('1.868');
    expect(formatGwei(GWEI)).toBe('1');
  });

  it('never plans more NFTs than one transaction can carry, and says so when fees alone would allow more (live finding: 1000 per wallet)', async () => {
    const plan = await planFreeQuantity({ desired: 1_000, allowanceWei: ALLOWANCE, maxFeePerGasWei: 1_000_000n, gasForQuantity: measuredGas });
    expect(plan.reason).toBe('reduced_for_gas_limit');
    expect(plan.planned).toBeLessThan(1_000);
    expect(((await measuredGas(plan.planned)) * 12n + 9n) / 10n).toBeLessThanOrEqual(15_000_000n);
    expect(((await measuredGas(plan.planned + 1)) * 12n + 9n) / 10n).toBeGreaterThan(15_000_000n);
    expect(plan.message).toContain('network gas limit per transaction');
    const fee = await planFreeQuantity({ desired: 1_000, allowanceWei: ALLOWANCE, maxFeePerGasWei: 10n * GWEI, gasForQuantity: measuredGas });
    expect(fee.reason).toBe('cannot_fit_one');
  });
});
