import { describe, expect, it } from 'vitest';
import { assertWithinAdmittedExposure, freeMintReserveCapsFor, preSignReservationGate, selectKeyListPrefix } from './engine-adapter.js';
import { canonicalExecutionIdentity } from '@mint-bot/engine';

const campaign = { mintPriceWei: 1_000n, quantity: 2 };

describe('pre-sign exposure guard (T-010)', () => {
  it('allows a transaction that exactly matches the admitted value and fits the reservation', () => {
    expect(() => assertWithinAdmittedExposure({ valueWei: 2_000n, maxGasCostWei: 400n, l1DataGasWei: 0n }, campaign, { amountWei: 2_400n })).not.toThrow();
  });

  it('refuses signing when the price changed after admission, up or down', () => {
    expect(() => assertWithinAdmittedExposure({ valueWei: 2_002n, maxGasCostWei: 0n, l1DataGasWei: 0n }, campaign, { amountWei: 10_000n })).toThrow('MINT_VALUE_CHANGED_SINCE_ADMISSION');
    expect(() => assertWithinAdmittedExposure({ valueWei: 1_998n, maxGasCostWei: 0n, l1DataGasWei: 0n }, campaign, { amountWei: 10_000n })).toThrow('MINT_VALUE_CHANGED_SINCE_ADMISSION');
  });

  it('refuses signing when worst-case gas pushes exposure one wei past the reservation', () => {
    expect(() => assertWithinAdmittedExposure({ valueWei: 2_000n, maxGasCostWei: 401n, l1DataGasWei: 0n }, campaign, { amountWei: 2_400n })).toThrow('EXPOSURE_EXCEEDS_RESERVATION');
    expect(() => assertWithinAdmittedExposure({ valueWei: 2_000n, maxGasCostWei: 400n, l1DataGasWei: 1n }, campaign, { amountWei: 2_400n })).toThrow('EXPOSURE_EXCEEDS_RESERVATION');
  });

  it('fails closed on negative gas figures and for free mints that suddenly carry value', () => {
    expect(() => assertWithinAdmittedExposure({ valueWei: 2_000n, maxGasCostWei: -1n, l1DataGasWei: 0n }, campaign, { amountWei: 10_000n })).toThrow('EXPOSURE_EXCEEDS_RESERVATION');
    expect(() => assertWithinAdmittedExposure({ valueWei: 1n, maxGasCostWei: 0n, l1DataGasWei: 0n }, { mintPriceWei: 0n, quantity: 5 }, { amountWei: 10_000n })).toThrow('MINT_VALUE_CHANGED_SINCE_ADMISSION');
  });
});

describe('complete pre-sign reservation gate used by the adapter reserve step (T-010)', () => {
  const address = '0x1111111111111111111111111111111111111111';
  const identity = canonicalExecutionIdentity('run-1', 'intent-1', 0, address);
  const reservation = { id: 'res-1', status: 'reserved', amountWei: 2_400n };
  const base = { killed: false, byWallet: new Map([[address, reservation]]), runId: 'run-1', intentId: 'intent-1', campaign: { id: 'cmp-1', mintPriceWei: 1_000n, quantity: 2 } };
  const input = { address, walletIndex: 0, runId: 'run-1', campaignId: 'cmp-1', executionId: identity.executionId, transactionIntentId: identity.transactionIntentId, valueWei: 2_000n, maxGasCostWei: 400n, l1DataGasWei: 0n };

  it('returns the reservation only when every check passes', () => {
    expect(preSignReservationGate({ ...base, input })).toBe(reservation);
  });

  it('refuses in order: kill switch, missing or used reservation, identity, value, exposure', () => {
    expect(() => preSignReservationGate({ ...base, killed: true, input })).toThrow('KILLED');
    expect(() => preSignReservationGate({ ...base, byWallet: new Map(), input })).toThrow('DURABLE_RESERVATION_REQUIRED');
    expect(() => preSignReservationGate({ ...base, byWallet: new Map([[address, { ...reservation, status: 'settled' }]]), input })).toThrow('DURABLE_RESERVATION_REQUIRED');
    expect(() => preSignReservationGate({ ...base, input: { ...input, executionId: 'forged' } })).toThrow('CANONICAL_IDENTITY_REQUIRED');
    expect(() => preSignReservationGate({ ...base, input: { ...input, valueWei: 2_001n } })).toThrow('MINT_VALUE_CHANGED_SINCE_ADMISSION');
    expect(() => preSignReservationGate({ ...base, input: { ...input, maxGasCostWei: 401n } })).toThrow('EXPOSURE_EXCEEDS_RESERVATION');
  });
});

describe('adapter wiring (T-010)', () => {
  it('routes the reserve step through the complete pre-sign gate', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('./engine-adapter.ts', import.meta.url), 'utf8');
    const reserveBody = source.slice(source.indexOf('reserve: async (input) => {'), source.indexOf('const settleTotal'));
    expect(reserveBody).toContain('preSignReservationGate(');
  });

  it('re-reads the reservations when reserve runs, never the copy taken when execute started (T-021)', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('./engine-adapter.ts', import.meta.url), 'utf8');
    const reserveBody = source.slice(source.indexOf('reserve: async (input) => {'), source.indexOf('const settleTotal'));
    expect(reserveBody).toContain('options.getState()');
    expect(reserveBody).toContain('byWallet: freshByWallet');
    expect(reserveBody).not.toMatch(/byWallet,\s*runId/);
  });

  it('refuses when a reservation was released or settled after execute began, with no signer involved', () => {
    const address = '0x1111111111111111111111111111111111111111';
    const identity = canonicalExecutionIdentity('run-1', 'intent-1', 0, address);
    const input = { address, walletIndex: 0, runId: 'run-1', campaignId: 'cmp-1', executionId: identity.executionId, transactionIntentId: identity.transactionIntentId, valueWei: 2_000n, maxGasCostWei: 400n, l1DataGasWei: 0n };
    const args = { killed: false, runId: 'run-1', intentId: 'intent-1', campaign: { id: 'cmp-1', mintPriceWei: 1_000n, quantity: 2 }, input };
    for (const status of ['released', 'settled', 'failed']) {
      expect(() => preSignReservationGate({ ...args, byWallet: new Map([[address, { id: 'res-1', status, amountWei: 2_400n }]]) })).toThrow('DURABLE_RESERVATION_REQUIRED');
    }
    // A reservation that vanished from the fresh state entirely is refused too.
    expect(() => preSignReservationGate({ ...args, byWallet: new Map() })).toThrow('DURABLE_RESERVATION_REQUIRED');
  });
});

describe('free-mint reserve caps per chain (D-042)', () => {
  it('follows the approved fleet policy on Ethereum and leaves every other chain on the strict engine default', () => {
    expect(freeMintReserveCapsFor(1)).toEqual({ perWalletCapWei: 400_000_000_000_000n, activePeriodCapWei: 2_400_000_000_000_000n });
    expect(freeMintReserveCapsFor(4663)).toBeUndefined();
    expect(freeMintReserveCapsFor(8453)).toBeUndefined();
    expect(freeMintReserveCapsFor(0)).toBeUndefined();
  });
});

describe('wallet selection ignores the order wallets arrive in (T-027 rehearsal finding)', () => {
  const list = [{ index: 0, address: '0xAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaa' }, { index: 1, address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }, { index: 2, address: '0xcccccccccccccccccccccccccccccccccccccccc' }];
  it('accepts the first N wallets in any order and returns their indexes in key-list order', () => {
    expect(selectKeyListPrefix(list, [list[0]!.address, list[1]!.address])).toEqual([0, 1]);
    expect(selectKeyListPrefix(list, [list[1]!.address.toUpperCase().replace('0X', '0x'), list[0]!.address.toLowerCase()])).toEqual([0, 1]);
    expect(selectKeyListPrefix(list, list.map((wallet) => wallet.address).reverse())).toEqual([0, 1, 2]);
  });
  it('still refuses a wallet outside the first N, a repeat, a stranger, an empty list and too many', () => {
    expect(() => selectKeyListPrefix(list, [list[1]!.address])).toThrow('WALLET_SELECTION_NOT_REPRESENTABLE'); // wallet 1 alone is not the first wallet
    expect(() => selectKeyListPrefix(list, [list[0]!.address, list[2]!.address])).toThrow('WALLET_SELECTION_NOT_REPRESENTABLE');
    expect(() => selectKeyListPrefix(list, [list[0]!.address, list[0]!.address])).toThrow('WALLET_SELECTION_NOT_REPRESENTABLE');
    expect(() => selectKeyListPrefix(list, [list[0]!.address, '0xdddddddddddddddddddddddddddddddddddddddd'])).toThrow('WALLET_SELECTION_NOT_REPRESENTABLE');
    expect(() => selectKeyListPrefix(list, [])).toThrow('EMPTY_EXECUTION_FLEET');
    // A key list with a repeated address among its first N is refused.
    expect(() => selectKeyListPrefix([list[0]!, { index: 1, address: list[0]!.address.toLowerCase() }], [list[0]!.address, list[1]!.address])).toThrow('WALLET_SELECTION_NOT_REPRESENTABLE');
    expect(() => selectKeyListPrefix(list.slice(0, 1), list.map((wallet) => wallet.address))).toThrow('WALLET_SELECTION_NOT_REPRESENTABLE');
  });
});
