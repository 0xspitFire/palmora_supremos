import { describe, expect, it } from 'vitest';
import { evaluateQualifiedAutomationGate, type QualifiedAutomationGateInput } from './automation-gate.js';

const ready = (overrides: Partial<QualifiedAutomationGateInput> = {}): QualifiedAutomationGateInput => ({
  score: 82,
  confidence: 0.92,
  replicationVerdict: 'replicable',
  simulationPassed: true,
  chainVerified: true,
  spendWithinCaps: true,
  killSwitchClear: true,
  operatorApproved: true,
  ...overrides,
});

describe('qualified automation gate', () => {
  it('allows only a high-confidence, simulated and explicitly approved plan', () => {
    expect(evaluateQualifiedAutomationGate(ready())).toMatchObject({ allowed: true, blockers: [] });
  });

  it('keeps every safety and approval condition independent', () => {
    const result = evaluateQualifiedAutomationGate(ready({ score: 69, confidence: 0.4, replicationVerdict: 'not_replicable', simulationPassed: false, chainVerified: false, spendWithinCaps: false, killSwitchClear: false, operatorApproved: false }));
    expect(result.allowed).toBe(false);
    expect(result.blockers).toEqual(expect.arrayContaining([
      'SCORE_BELOW_THRESHOLD', 'REPLICATION_NOT_QUALIFIED',
      'SIMULATION_FAILED', 'CHAIN_NOT_VERIFIED', 'SPEND_CAP_NOT_AVAILABLE',
      'KILL_SWITCH_ENGAGED', 'OPERATOR_APPROVAL_REQUIRED',
    ]));
  });

  it('does not make approval implicit when all other checks pass', () => {
    expect(evaluateQualifiedAutomationGate(ready({ operatorApproved: false }))).toMatchObject({ allowed: false, blockers: ['OPERATOR_APPROVAL_REQUIRED'] });
  });

  it('auto-fires a free mint at exactly 70 with a verified watched self-mint and current production evidence', () => {
    expect(evaluateQualifiedAutomationGate(ready({ score: 70, confidence: 0.59, operatorApproved: false, mintPriceWei: 0n, watchedWalletMintVerified: true, unattendedReady: true }))).toMatchObject({ allowed: true, mode: 'autonomous-free' });
  });

  it('requires the watched mint, production evidence, and every existing gate independently', () => {
    const result = evaluateQualifiedAutomationGate(ready({ operatorApproved: false, mintPriceWei: 0n, watchedWalletMintVerified: false, unattendedReady: false, spendWithinCaps: false }));
    expect(result.blockers).toEqual(expect.arrayContaining(['WATCHED_WALLET_MINT_REQUIRED', 'UNATTENDED_EVIDENCE_REQUIRED', 'SPEND_CAP_NOT_AVAILABLE']));
  });

  it('paid mints and an unknown price always require final operator fire approval', () => {
    for (const mintPriceWei of [1n, undefined]) expect(evaluateQualifiedAutomationGate(ready({ operatorApproved: false, mintPriceWei, watchedWalletMintVerified: true, unattendedReady: true })).blockers).toContain('OPERATOR_APPROVAL_REQUIRED');
  });
});
