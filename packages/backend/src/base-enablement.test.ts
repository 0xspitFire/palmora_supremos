import { describe, expect, it } from 'vitest';
import { assertBaseFirstRehearsal, assertBaseLiveAllowed, validBaseEnablement } from './base-enablement.js';

const now = new Date('2026-10-20T12:00:00.000Z');
const evidence = { reviewedCode: true, forkRehearsal: true, finality: true, endpointAgreement: true, feeObservation: true, liveSimulation: true, custodyReadiness: true } as const;
const record = { recordId: 'base-1', approvedBy: 'owner-cli', approvedAt: '2026-10-20T11:00:00.000Z', expiresAt: '2026-10-21T11:00:00.000Z', freeAllowed: true, paidAllowed: false, evidence, evidenceDigest: 'a'.repeat(64), strategyVersion: 'seadrop-v1-public', feePolicyVersion: 'base-free-d057-v1', primaryEndpointReference: 'BASE_RPC_URL', fallbackEndpointReference: 'BASE_RPC_FBACK', custodyMode: 'local-personal-live' } as const;

describe('Base owner enablement', () => {
  it('accepts only a current, complete, free-only record', () => {
    expect(validBaseEnablement(record, now)).toEqual(record);
    expect(validBaseEnablement({ ...record, paidAllowed: true }, now)).toBeUndefined();
    expect(validBaseEnablement({ ...record, fallbackEndpointReference: 'BASE_RPC_URL' }, now)).toBeUndefined();
    expect(validBaseEnablement({ ...record, expiresAt: now.toISOString() }, now)).toBeUndefined();
  });

  it('never lets the free record activate paid Base', () => {
    expect(() => assertBaseLiveAllowed('free', record, now)).not.toThrow();
    expect(() => assertBaseLiveAllowed('paid', record, now)).toThrow('BASE_PAID_MINTS_DISABLED');
    expect(() => assertBaseLiveAllowed('free', undefined, now)).toThrow('BASE_EXECUTION_DISABLED');
  });

  it('keeps the first proof to one wallet and one NFT and serializes retries until finalization', () => {
    expect(() => assertBaseFirstRehearsal({ completed: false, outstanding: false, walletCount: 1, quantity: 1 })).not.toThrow();
    expect(() => assertBaseFirstRehearsal({ completed: false, outstanding: false, walletCount: 2, quantity: 1 })).toThrow('BASE_FIRST_REHEARSAL_REQUIRES_ONE_WALLET');
    expect(() => assertBaseFirstRehearsal({ completed: false, outstanding: false, walletCount: 1, quantity: 2 })).toThrow('BASE_FIRST_REHEARSAL_REQUIRES_ONE_NFT');
    expect(() => assertBaseFirstRehearsal({ completed: false, outstanding: true, walletCount: 1, quantity: 1 })).toThrow('BASE_FIRST_REHEARSAL_PENDING_FINALIZATION');
    expect(() => assertBaseFirstRehearsal({ completed: true, outstanding: true, walletCount: 6, quantity: 4 })).not.toThrow();
  });
});
