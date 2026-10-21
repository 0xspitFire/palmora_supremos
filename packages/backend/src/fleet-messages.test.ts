import { describe, expect, it } from 'vitest';
import { excessBalanceCard, fleetWatchCard, fundingRequestCard } from './fleet-messages.js';

const W1 = '0x1111111111111111111111111111111111111111';
const W2 = '0x2222222222222222222222222222222222222222';
const TREASURY = '0x6AAcC4d916541F99477b2f31EfFf7B08a372A8Df';
const AT = new Date('2026-10-22T12:00:00.000Z');

describe('owner messages for funding, left-over balance and the watcher (D-059)', () => {
  it('the funding request names each wallet and amount, rounded UP so the owner never sends too little, and the treasury', () => {
    const card = fundingRequestCard({ chainId: 1, treasury: TREASURY, items: [{ wallet: W1, topUpWei: '500000000000001' }, { wallet: W2, topUpWei: '0' }], at: AT });
    expect(card.steps[0]).toBe(`Send 0.000501 ETH to ${W1}.`);
    expect(card.steps.join(' ')).not.toContain(W2);
    expect(card.code?.value).toBe(TREASURY.toLowerCase());
    expect(card.lines.find((line) => line.label === 'Total to send')?.value).toBe('0.000501 ETH');
    expect(card.summary).toContain('Funding needed');
    expect(JSON.stringify(card)).not.toMatch(/private|secret|token|password/i);
  });

  it('lists at most four wallets and points to the terminal for the rest', () => {
    const items = Array.from({ length: 6 }, (_, index) => ({ wallet: `0x${String(index + 1).repeat(40)}`, topUpWei: '1000000000000' }));
    const card = fundingRequestCard({ chainId: 1, treasury: TREASURY, items, at: AT });
    expect(card.steps.filter((step) => step.startsWith('Send 0.000001 ETH to 0x'))).toHaveLength(4);
    expect(card.steps.join(' ')).toContain('remaining 2 amounts');
  });

  it('refuses anything that is not a plain address', () => {
    expect(() => fundingRequestCard({ chainId: 1, treasury: 'nope', items: [], at: AT })).toThrow('FLEET_MESSAGE_ADDRESS_INVALID');
    expect(() => fundingRequestCard({ chainId: 1, treasury: TREASURY, items: [{ wallet: 'evil <b>', topUpWei: '1' }], at: AT })).toThrow('FLEET_MESSAGE_ADDRESS_INVALID');
    expect(() => fleetWatchCard({ finding: 'unknown_activity', chainId: 1, wallet: 'x', at: AT })).toThrow('FLEET_MESSAGE_ADDRESS_INVALID');
  });

  it('the left-over balance reminder is calm, says nothing is wrong and offers leaving it for the next run', () => {
    const card = excessBalanceCard({ chainId: 1, treasury: TREASURY, reminders: [{ wallet: W1, excessWei: '300000000000000', idleMs: 90_000_000 }], at: AT });
    expect(card.severity).toBe('attention');
    expect(card.lines.map((line) => line.value).join(' ')).toContain('nothing is wrong');
    expect(card.steps.at(-1)).toContain('leave it for the next run');
  });

  it('the watcher findings that stop signing are critical and say not to release the kill switch', () => {
    for (const finding of ['unknown_activity', 'unexplained_fall'] as const) {
      const card = fleetWatchCard({ finding, chainId: 8453, wallet: W1, at: AT });
      expect(card.severity).toBe('critical');
      expect(card.steps[0]).toBe('Do not release the kill switch.');
      expect(card.lines.some((line) => line.label === 'Chain' && line.value === 'BASE')).toBe(true);
    }
    expect(fleetWatchCard({ finding: 'rise_above_limit', chainId: 1, wallet: W1, at: AT }).severity).toBe('attention');
    expect(fleetWatchCard({ finding: 'watcher_blind', chainId: 1, at: AT }).steps.join(' ')).toContain('Do not start a run');
  });

  it('never says signing has stopped when the kill switch could not be engaged: it says the opposite and puts the manual step first', () => {
    const card = fleetWatchCard({ finding: 'unknown_activity', chainId: 1, wallet: W1, killFailed: true, at: AT });
    expect(card.lines.map((line) => line.value).join(' ')).toContain('could NOT engage the kill switch');
    expect(card.steps[0]).toContain('Engage the kill switch yourself now');
    expect(card.steps).not.toContain('Do not release the kill switch.');
    expect(card.summary).toContain('could not be engaged');
  });

  it('accepting or rejecting a wallet state is always reported, and a rejection says to treat it as a security problem', () => {
    expect(fleetWatchCard({ finding: 'baseline_accepted', chainId: 1, wallet: W1, at: AT }).steps[0]).toContain('did not accept this state yourself');
    const rejected = fleetWatchCard({ finding: 'accept_rejected', chainId: 1, wallet: W1, at: AT });
    expect(rejected.severity).toBe('attention');
    expect(rejected.steps.join(' ')).toContain('security problem');
  });
});
