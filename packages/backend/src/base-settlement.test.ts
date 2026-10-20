import { describe, expect, it } from 'vitest';
import { receiptAuthorizesSettlement } from './coordinator.js';

describe('Base authoritative settlement', () => {
  it('keeps successful and reverted exposure pending until ethereum_final', () => {
    for (const state of ['Confirmed', 'Failed'] as const) {
      expect(receiptAuthorizesSettlement(8453, { state, finalityStage: 'soft' })).toBe(false);
      expect(receiptAuthorizesSettlement(8453, { state, finalityStage: 'posted' })).toBe(false);
      expect(receiptAuthorizesSettlement(8453, { state, finalityStage: 'ethereum_final' })).toBe(true);
    }
    expect(receiptAuthorizesSettlement(8453, { state: 'Reorged', finalityStage: 'ethereum_final' })).toBe(false);
  });
});
