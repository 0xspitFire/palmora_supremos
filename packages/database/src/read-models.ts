import type { SqliteDatabase } from './database.js';

export interface ReadinessRow {
  campaignId: string;
  walletId: string;
  eligibilityStatus: 'eligible' | 'ineligible' | 'unknown' | null;
  simulationOutcome: 'pass' | 'fail' | 'unknown' | null;
  simulationCheckedAt: string | null;
  nextAction: 'ready' | 'refresh_simulation' | 'resolve_eligibility' | 'blocked';
}

export interface ActiveExecutionRow {
  executionId: string;
  campaignId: string;
  walletId: string;
  state: string;
  updatedAt: string;
  intentId: string;
}

export interface OpportunityEvidenceRow {
  opportunityId: string;
  fingerprint: string;
  disposition: string;
  score: number | null;
  freshnessAt: string | null;
  signalCount: number;
}

export class ReadModels {
  public constructor(private readonly db: SqliteDatabase) {}

  public readiness(campaignId: string, asOf = new Date()): ReadinessRow[] {
    const rows = this.db.prepare(`
      SELECT c.id AS campaign_id, w.id AS wallet_id,
        (SELECT status FROM eligibility e WHERE e.campaign_id = c.id AND e.wallet_id = w.id ORDER BY e.expires_at DESC LIMIT 1) AS eligibility_status,
        (SELECT outcome FROM simulation s WHERE s.campaign_id = c.id AND s.wallet_id = w.id ORDER BY s.checked_at DESC LIMIT 1) AS simulation_outcome,
        (SELECT checked_at FROM simulation s WHERE s.campaign_id = c.id AND s.wallet_id = w.id ORDER BY s.checked_at DESC LIMIT 1) AS simulation_checked_at,
        (SELECT freshness_seconds FROM simulation s WHERE s.campaign_id = c.id AND s.wallet_id = w.id ORDER BY s.checked_at DESC LIMIT 1) AS freshness_seconds
      FROM campaign c CROSS JOIN wallet w WHERE c.id = ? ORDER BY w.id
    `).all(campaignId) as Array<{ campaign_id: string; wallet_id: string; eligibility_status: ReadinessRow['eligibilityStatus']; simulation_outcome: ReadinessRow['simulationOutcome']; simulation_checked_at: string | null; freshness_seconds: number | null }>;
    return rows.map((row) => ({
      campaignId: row.campaign_id,
      walletId: row.wallet_id,
      eligibilityStatus: row.eligibility_status,
      simulationOutcome: row.simulation_outcome,
      simulationCheckedAt: row.simulation_checked_at,
      nextAction: row.eligibility_status !== 'eligible' ? (row.eligibility_status === null || row.eligibility_status === 'unknown' ? 'resolve_eligibility' : 'blocked') : row.simulation_outcome !== 'pass' || row.simulation_checked_at === null || row.freshness_seconds === null || asOf.getTime() - Date.parse(row.simulation_checked_at) > row.freshness_seconds * 1000 ? (row.simulation_outcome === 'fail' ? 'blocked' : 'refresh_simulation') : 'ready',
    }));
  }

  public activeExecutions(): ActiveExecutionRow[] {
    const rows = this.db.prepare("SELECT id AS execution_id, campaign_id, wallet_id, state, updated_at, transaction_intent_id AS intent_id FROM execution WHERE state NOT IN ('confirmed', 'failed', 'skipped', 'killed') ORDER BY updated_at").all() as Array<{ execution_id: string; campaign_id: string; wallet_id: string; state: string; updated_at: string; intent_id: string }>;
    return rows.map((row) => ({ executionId: row.execution_id, campaignId: row.campaign_id, walletId: row.wallet_id, state: row.state, updatedAt: row.updated_at, intentId: row.intent_id }));
  }

  public opportunityEvidence(limit = 100): OpportunityEvidenceRow[] {
    return this.db.prepare('SELECT o.id AS opportunity_id, o.fingerprint, o.disposition, o.score, o.freshness_at, COUNT(s.id) AS signal_count FROM opportunity o LEFT JOIN signal s ON s.opportunity_id = o.id GROUP BY o.id ORDER BY o.score DESC LIMIT ?').all(limit) as OpportunityEvidenceRow[];
  }
}
