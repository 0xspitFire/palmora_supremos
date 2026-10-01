import { describe, expect, it } from 'vitest';
import { assertWithinAdmittedExposure, preSignReservationGate } from './engine-adapter.js';
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
