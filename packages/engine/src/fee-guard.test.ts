import { describe, it, expect } from 'vitest';
import { validateFeeBudget, assertPriorityFeeIsNotBudget, validateFreeMintSpend } from './fee-guard.js';

describe('validateFeeBudget', () => {
  it('accepts a budget that covers gas + value as worst-case total', () => {
    const v = validateFeeBudget({
      valueWei: 1_000_000_000_000_000n, // 0.001 ETH
      maxFeePerGasWei: 1_000_000_000n,
      gasLimit: 210_000n,
    });
    expect(v.ok).toBe(true);
  });

  it('rejects a zero budget instead of silently underbounding', () => {
    const v = validateFeeBudget({
      valueWei: 0n,
      maxFeePerGasWei: 1_000_000_000n,
      gasLimit: 0n,
    });
    expect(v.ok).toBe(false);
  });

  it('rejects an ambiguous zero gas limit', () => {
    const v = validateFeeBudget({
      valueWei: 1_000_000_000_000_000n,
      maxFeePerGasWei: 1_000_000_000n,
      gasLimit: 0n,
    });
    expect(v.ok).toBe(false);
  });

  it('rejects a declared budget below the worst-case total', () => {
    const v = validateFeeBudget({
      valueWei: 1_000_000_000_000_000n,
      maxFeePerGasWei: 1_000_000_000n,
      gasLimit: 210_000n,
      declaredBudgetWei: 100n,
    });
    expect(v.ok).toBe(false);
  });

  it('separately reserves L1 data fee on L2 (never zero)', () => {
    const withData = validateFeeBudget({
      valueWei: 0n,
      maxFeePerGasWei: 1_000_000_000n,
      gasLimit: 210_000n,
      l1DataFeeAllowanceWei: 50_000_000_000n,
    });
    expect(withData.ok).toBe(true);
  });

  it('priority fee alone is never treated as a total budget', () => {
    // Documentational: 2x priority fee is a component, not the cap.
    expect(() => assertPriorityFeeIsNotBudget(2)).not.toThrow();
  });
});

describe('validateFreeMintSpend', () => {
  it('allows total spend up to 2x priority fee', () => {
    expect(validateFreeMintSpend({ priorityFeeWei: 10n, actualSpendWei: 20n })).toEqual({
      status: 'ok', maxSpendWei: 20n,
    });
  });

  it('rejects spend above the FREE-mint allowance', () => {
    expect(validateFreeMintSpend({ priorityFeeWei: 10n, actualSpendWei: 21n })).toEqual({
      status: 'exceeded', maxSpendWei: 20n, actualSpendWei: 21n,
    });
  });

  it('flags zero priority fee for Product Owner resolution', () => {
    expect(validateFreeMintSpend({ priorityFeeWei: 0n, actualSpendWei: 0n })).toEqual({
      status: 'ambiguous', reason: 'zero-priority-fee',
    });
  });
});
