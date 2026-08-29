import type { ChainConfig } from './types.js';

export type RobinhoodGateEvidence = {
  readonly ownerAccepted: boolean;
  readonly positiveSeaDropMint: boolean;
  readonly archiveForkReplay: boolean;
  readonly negativeCaseSuite: boolean;
  readonly sequencerFeedCorrelation: boolean;
  readonly duplicateTimeoutLagReplacement: boolean;
  readonly startupReconciliation: boolean;
  readonly signerBroadcastFinality: boolean;
};

export type RobinhoodGateResult = {
  readonly verified: boolean;
  readonly missing: readonly (keyof RobinhoodGateEvidence)[];
};

/**
 * Single explicit gate for 4663. Product Owner approval is necessary but never
 * substitutes for executable evidence. This function is pure and cannot access
 * secrets or change the chain registry by itself.
 */
export function evaluateRobinhoodVerification(evidence: RobinhoodGateEvidence): RobinhoodGateResult {
  const missing = (Object.keys(evidence) as (keyof RobinhoodGateEvidence)[]).filter((key) => !evidence[key]);
  return { verified: missing.length === 0, missing };
}

/**
 * Produce an executable profile only from complete evidence. The registry's
 * default 4663 profile remains unverified; callers must explicitly supply the
 * accepted evidence snapshot to this function.
 */
export function applyRobinhoodVerification(
  config: ChainConfig,
  evidence: RobinhoodGateEvidence,
): ChainConfig {
  const result = evaluateRobinhoodVerification(evidence);
  if (!result.verified) {
    throw new Error(`Robinhood verification incomplete: ${result.missing.join(', ')}`);
  }
  return {
    ...config,
    verificationStatus: 'verified',
    executionEnabled: true,
    characterization: {
      ...config.characterization,
      status: 'verified',
    },
  };
}
