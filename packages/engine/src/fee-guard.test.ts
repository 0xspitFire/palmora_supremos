import { describe, it, expect } from 'vitest';
import { DEFAULT_FREE_MINT_RESERVE_CAPS, effectiveFreeMintReserveCaps, exceedsRunReserveCap, freeMintReserveCapsForChain, FREE_MINT_ACTIVE_PERIOD_RESERVE_CAP_WEI, FREE_MINT_PER_WALLET_RESERVE_CAP_WEI, validateFeeBudget, assertPriorityFeeIsNotBudget, validateFreeMintReserve, validateFreeMintSpend, paidMintExecutionBlock, validatePaidQuantity, validatePaidGasExposure, replacementPriorityBudget } from './fee-guard.js';

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

describe('validateFreeMintReserve with per-chain caps (D-042)', () => {
  const ETHEREUM_CAPS = { perWalletCapWei: 400_000_000_000_000n, activePeriodCapWei: 2_400_000_000_000_000n }; // 0.0004 and 0.0024 ETH
  const one = (perWalletReserveWei: bigint, activePeriodReserveWei = perWalletReserveWei, caps?: { perWalletCapWei: bigint; activePeriodCapWei: bigint }) => validateFreeMintReserve({ perWalletReserveWei, activePeriodReserveWei }, caps);

  it('keeps the strict Robinhood default when no caps are supplied', () => {
    expect(DEFAULT_FREE_MINT_RESERVE_CAPS).toEqual({ perWalletCapWei: FREE_MINT_PER_WALLET_RESERVE_CAP_WEI, activePeriodCapWei: FREE_MINT_ACTIVE_PERIOD_RESERVE_CAP_WEI });
    expect(one(FREE_MINT_PER_WALLET_RESERVE_CAP_WEI).allowed).toBe(true);
    expect(one(FREE_MINT_PER_WALLET_RESERVE_CAP_WEI + 1n)).toMatchObject({ allowed: false, reason: 'FREE-mint per-wallet reserve exceeds 0.0002 ETH' });
    expect(one(1n, FREE_MINT_ACTIVE_PERIOD_RESERVE_CAP_WEI + 1n)).toMatchObject({ allowed: false, reason: 'FREE-mint active-period reserve exceeds 0.002 ETH' });
  });

  it('lets Ethereum use the approved 0.0004 per wallet and 0.0024 per run, and no more', () => {
    expect(one(ETHEREUM_CAPS.perWalletCapWei, ETHEREUM_CAPS.activePeriodCapWei, ETHEREUM_CAPS)).toMatchObject({ allowed: true, perWalletCapWei: ETHEREUM_CAPS.perWalletCapWei });
    expect(one(ETHEREUM_CAPS.perWalletCapWei + 1n, 1n, ETHEREUM_CAPS)).toMatchObject({ allowed: false, reason: 'FREE-mint per-wallet reserve exceeds 0.0004 ETH' });
    expect(one(1n, ETHEREUM_CAPS.activePeriodCapWei + 1n, ETHEREUM_CAPS)).toMatchObject({ allowed: false, reason: 'FREE-mint active-period reserve exceeds 0.0024 ETH' });
  });

  it('falls back to the strict default when supplied caps are nonsense, so a mistake only refuses more', () => {
    for (const caps of [{ perWalletCapWei: 0n, activePeriodCapWei: 10n ** 18n }, { perWalletCapWei: -1n, activePeriodCapWei: 10n ** 18n }, { perWalletCapWei: 10n ** 18n, activePeriodCapWei: 1n }]) {
      expect(one(FREE_MINT_PER_WALLET_RESERVE_CAP_WEI + 1n, 1n, caps).allowed).toBe(false);
    }
  });

  it('gives one effective pair, so the per-wallet and the per-run checks can never use different caps', () => {
    expect(effectiveFreeMintReserveCaps(undefined)).toBe(DEFAULT_FREE_MINT_RESERVE_CAPS);
    expect(effectiveFreeMintReserveCaps(ETHEREUM_CAPS)).toBe(ETHEREUM_CAPS);
    // A malformed pair (per-wallet 0, huge per-run) must not leave the per-run cap loose.
    expect(effectiveFreeMintReserveCaps({ perWalletCapWei: 0n, activePeriodCapWei: 10n ** 18n })).toBe(DEFAULT_FREE_MINT_RESERVE_CAPS);
    expect(effectiveFreeMintReserveCaps({ perWalletCapWei: 10n ** 18n, activePeriodCapWei: 1n })).toBe(DEFAULT_FREE_MINT_RESERVE_CAPS);
  });

  it('applies supplied caps on Ethereum only; Robinhood and Base stay strict whatever is passed (the gate the engine uses)', () => {
    expect(freeMintReserveCapsForChain('ethereum', ETHEREUM_CAPS)).toBe(ETHEREUM_CAPS);
    expect(freeMintReserveCapsForChain('ethereum', undefined)).toBe(DEFAULT_FREE_MINT_RESERVE_CAPS);
    expect(freeMintReserveCapsForChain('robinhood', ETHEREUM_CAPS)).toBe(DEFAULT_FREE_MINT_RESERVE_CAPS);
    expect(freeMintReserveCapsForChain('base', ETHEREUM_CAPS)).toBe(DEFAULT_FREE_MINT_RESERVE_CAPS);
  });

  it('refuses the wallet that would take the run past the run cap and allows the one that reaches it exactly', () => {
    const wallet = ETHEREUM_CAPS.perWalletCapWei; // 0.0004 ETH each, run cap 0.0024 ETH = six wallets
    expect(exceedsRunReserveCap(5n * wallet, wallet, ETHEREUM_CAPS)).toBe(false);
    expect(exceedsRunReserveCap(6n * wallet, 1n, ETHEREUM_CAPS)).toBe(true);
    // Robinhood's strict cap: five wallets of 0.0004 do not fit 0.002 ETH.
    const strict = freeMintReserveCapsForChain('robinhood', ETHEREUM_CAPS);
    expect(exceedsRunReserveCap(0n, wallet * 5n + 1n, strict)).toBe(true);
    expect(exceedsRunReserveCap(strict.activePeriodCapWei - 1n, 1n, strict)).toBe(false);
    expect(exceedsRunReserveCap(strict.activePeriodCapWei, 1n, strict)).toBe(true);
  });

  it('is wired into the engine: it calls the chain gate and the run-cap check, and no longer reads the fixed constants', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('./mint-engine.ts', import.meta.url), 'utf8');
    expect(source).toContain('freeMintReserveCapsForChain(this.config.target.chain, this.config.safety.freeMintReserveCaps)');
    expect(source).toContain('exceedsRunReserveCap(admittedFreeReserveWei, freeReserve, freeReserveCaps)');
    expect(source).toContain('validateFreeMintReserve({ perWalletReserveWei: reserve, activePeriodReserveWei: reserve }, freeReserveCaps)');
    expect(source).not.toContain('FREE_MINT_ACTIVE_PERIOD_RESERVE_CAP_WEI');
    expect(source).not.toContain('FREE_MINT_PER_WALLET_RESERVE_CAP_WEI');
  });
});
