import { describe, it, expect } from 'vitest';
import { FREE_MINT_ACTIVE_PERIOD_RESERVE_CAP_WEI, FREE_MINT_PER_WALLET_RESERVE_CAP_WEI, validateFeeBudget, assertPriorityFeeIsNotBudget, validateFreeMintReserve, validateFreeMintSpend, paidMintExecutionBlock, validatePaidQuantity, validatePaidGasExposure, replacementPriorityBudget } from './fee-guard.js';

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
  const gas = { l2ExecutionGasReservationWei: 100n, l1DataGasReservationWei: 30n };

  it('applies 2x only to the priority component and reserves gas independently', () => {
    expect(validateFreeMintSpend({ configuredPriorityFeeWei: 10n, actualPriorityComponentWei: 20n, ...gas })).toEqual({
      status: 'ok', priorityComponentCapWei: 20n, ...gas, totalIndependentReservationWei: 150n,
    });
  });

  it('rejects spend above the FREE-mint allowance', () => {
    expect(validateFreeMintSpend({ configuredPriorityFeeWei: 10n, actualPriorityComponentWei: 21n, ...gas })).toEqual({
      status: 'exceeded', priorityComponentCapWei: 20n, actualPriorityComponentWei: 21n,
    });
  });

  it('allows zero priority while retaining independent gas reservations', () => {
    expect(validateFreeMintSpend({ configuredPriorityFeeWei: 0n, actualPriorityComponentWei: 0n, ...gas })).toEqual({
      status: 'ok', priorityComponentCapWei: 0n, ...gas, totalIndependentReservationWei: 130n,
    });
  });

  it('blocks paid execution pending an explicit value policy', () => {
    expect(paidMintExecutionBlock(1n).allowed).toBe(false);
    expect(paidMintExecutionBlock(0n)).toEqual({ allowed: true });
  });

  it('enforces the paid per-wallet default and contract limit', () => {
    expect(validatePaidQuantity({ requestedQuantity: 15, contractWalletLimit: 20 })).toEqual({ allowed: true, quantity: 15 });
    expect(validatePaidQuantity({ requestedQuantity: 16, contractWalletLimit: 20, configuredWalletLimit: 16 })).toEqual({ allowed: true, quantity: 16 });
    expect(validatePaidQuantity({ requestedQuantity: 16, contractWalletLimit: 15 })).toMatchObject({ allowed: false });
    expect(validatePaidQuantity({ requestedQuantity: 10, contractWalletLimit: 5 })).toMatchObject({ allowed: false });
  });

  it('keeps paid gas and replacement caps dimensionally separate', () => {
    expect(validatePaidGasExposure({ gasLimit: 100n, configuredPriorityFeeWei: 10n, actualPriorityComponentWei: 1500n, l1DataGasReservationWei: 25n })).toMatchObject({ allowed: true, priorityGasCapWei: 1500n });
    expect(replacementPriorityBudget(10n)).toBe(20n);
  });
});

describe('validateFreeMintReserve', () => {
  it('enforces the exact per-wallet and active-period caps', () => {
    expect(FREE_MINT_PER_WALLET_RESERVE_CAP_WEI).toBe(200_000_000_000_000n);
    expect(FREE_MINT_ACTIVE_PERIOD_RESERVE_CAP_WEI).toBe(2_000_000_000_000_000n);
    expect(validateFreeMintReserve({ perWalletReserveWei: FREE_MINT_PER_WALLET_RESERVE_CAP_WEI, activePeriodReserveWei: FREE_MINT_ACTIVE_PERIOD_RESERVE_CAP_WEI }).allowed).toBe(true);
    expect(validateFreeMintReserve({ perWalletReserveWei: FREE_MINT_PER_WALLET_RESERVE_CAP_WEI + 1n, activePeriodReserveWei: 0n }).allowed).toBe(false);
    expect(validateFreeMintReserve({ perWalletReserveWei: 0n, activePeriodReserveWei: FREE_MINT_ACTIVE_PERIOD_RESERVE_CAP_WEI + 1n }).allowed).toBe(false);
  });
});
