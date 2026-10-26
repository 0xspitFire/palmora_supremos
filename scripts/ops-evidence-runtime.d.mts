export interface OpsEvidenceReport {
  status: 'configured' | 'blocked';
  humanEvidenceComplete: boolean;
  references: Record<string, 'configured' | 'missing'>;
  missing: string[];
  acceptance: 'accepted' | 'not_accepted';
  acceptanceProblems: string[];
  note: string;
}
export function evaluateOpsEvidence(options?: Record<string, unknown>): Promise<OpsEvidenceReport>;
export function assertOpsEvidenceAccepted(options?: Record<string, unknown>): Promise<OpsEvidenceReport>;
