import { describe, it, expect } from 'vitest';

import {
  nextRetryAction,
  applyTipBump,
  PRIVATE_ATTEMPTS,
  ESCALATION_ATTEMPTS,
  MAX_LADDER_ATTEMPTS,
} from './gas-strategy.js';

describe('gas-strategy retry ladder', () => {
  it('keeps the bundle private for the first 3 blocks at base priority', () => {
    for (let attempt = 1; attempt <= PRIVATE_ATTEMPTS; attempt++) {
      const action = nextRetryAction({ attempt, landed: false, hasHardCap: true, fundsCoverEscalation: true, relayChain: true });
      expect(action.kind).toBe('private-retry');
      if (action.kind === 'private-retry') {
        expect(action.escalate).toBe(false);
        expect(action.bumpTip).toBe(false);
        expect(action.blockOffset).toBe(attempt);
      }
    }
  });

  it('stops once the transaction lands', () => {
    const action = nextRetryAction({ attempt: 2, landed: true, hasHardCap: true, fundsCoverEscalation: true, relayChain: true });
    expect(action).toEqual({ kind: 'stop' });
  });

  it('escalates inside Flashbots for a hard-cap mint with coverage', () => {
    for (let attempt = PRIVATE_ATTEMPTS + 1; attempt <= PRIVATE_ATTEMPTS + ESCALATION_ATTEMPTS; attempt++) {
      const action = nextRetryAction({ attempt, landed: false, hasHardCap: true, fundsCoverEscalation: true, relayChain: true });
      expect(action.kind).toBe('private-retry');
      if (action.kind === 'private-retry') {
        expect(action.escalate).toBe(true);
      }
    }
  });

  it('falls back to public broadcast with a fresh nonce check after exhaustion without coverage', () => {
    const action = nextRetryAction({ attempt: PRIVATE_ATTEMPTS + 1, landed: false, hasHardCap: true, fundsCoverEscalation: false, relayChain: true });
    expect(action.kind).toBe('public-fallback');
    if (action.kind === 'public-fallback') {
      expect(action.requireNonceRecheck).toBe(true);
    }
  });

  it('falls back to public broadcast once the maximum ladder is exhausted even with coverage', () => {
    const action = nextRetryAction({ attempt: PRIVATE_ATTEMPTS + ESCALATION_ATTEMPTS + 1, landed: false, hasHardCap: true, fundsCoverEscalation: true, relayChain: true });
    expect(action.kind).toBe('public-fallback');
  });

  it('stays private-only with tip bumps for mints without a hard cap', () => {
    const action = nextRetryAction({ attempt: PRIVATE_ATTEMPTS + 1, landed: false, hasHardCap: false, fundsCoverEscalation: false, relayChain: true });
    expect(action.kind).toBe('private-retry');
    if (action.kind === 'private-retry') {
      expect(action.escalate).toBe(false);
      expect(action.bumpTip).toBe(true);
    }
  });

  it('stops immediately on a non-relay chain (policy applies to Flashbots-relay chains only)', () => {
    const action = nextRetryAction({ attempt: 1, landed: false, hasHardCap: true, fundsCoverEscalation: true, relayChain: false });
    expect(action).toEqual({ kind: 'stop' });
  });

  it('caps the ladder at the documented attempt bound', () => {
    expect(MAX_LADDER_ATTEMPTS).toBe(PRIVATE_ATTEMPTS + ESCALATION_ATTEMPTS);
  });
});

describe('applyTipBump', () => {
  it('adds a fraction of the fee as a slight tip bump', () => {
    expect(applyTipBump(1_000_000n)).toBe(1_050_000n);
    expect(applyTipBump(1_000_000n, 2n)).toBe(1_020_000n);
  });

  it('never reduces the priority fee', () => {
    expect(applyTipBump(0n)).toBe(0n);
  });
});