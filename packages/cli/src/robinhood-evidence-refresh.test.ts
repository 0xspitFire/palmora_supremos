import { describe, expect, it } from 'vitest';
import { checkEvidenceFile } from './robinhood-enable.js';
import { finalityVerdict, refreshFinalityEvidence } from './robinhood-evidence-refresh.js';
import type { FinalityReport } from './robinhood-readonly.js';

const tracked = (overrides: Partial<FinalityReport['followed'][number]> = {}): FinalityReport['followed'][number] => ({ txHash: '0xabc', blockNumber: '1', firstSeenSecondsAfterBlock: 1, postedAfterSeconds: 120, finalAfterSeconds: 1000, lastStage: 'ethereum_final', ...overrides });
const report = (overrides: Partial<FinalityReport> = {}): FinalityReport => ({ followed: [tracked(), tracked(), tracked(), tracked(), tracked()], historical: null, stagesInOrder: true, medianPostedSeconds: 120, medianFinalSeconds: 1000, summary: 'x', ...overrides });
const TODAY = new Date('2026-10-26T09:30:00.000Z');
const old = JSON.stringify({
  E1: { passed: true, checkedOn: '2026-10-19', reference: 'survey 2026-10-19' }, E2: { passed: true, checkedOn: '2026-10-19', reference: 'replay 6/6' },
  E3: { passed: true, checkedOn: '2026-10-01', reference: 'old finality observation' }, E4: { passed: true, checkedOn: '2026-10-19', reference: 'feed 20/20' },
  E5: { passed: true, checkedOn: '2026-10-19', reference: 'fees fit caps' }, E6: { passed: true, checkedOn: '2026-10-19', reference: 'six wallets simulated' },
  E7: { passed: true, checkedOn: '2026-10-19', reference: 'L1 data-gas fixed' },
});

describe('E3 refresh of the Robinhood enablement evidence', () => {
  it('replaces only E3, with today\'s date and a reference built from the real observation', () => {
    const { text, reference } = refreshFinalityEvidence({ evidenceText: old, report: report(), today: TODAY });
    const next = JSON.parse(text) as Record<string, { checkedOn: string; reference: string; passed: boolean }>;
    expect(next.E3).toEqual({ passed: true, checkedOn: '2026-10-26', reference });
    expect(reference).toBe('observe-finality 2026-10-26: 5/5 posted (median 120s), 5 Ethereum-final (median 1000s), stages in order');
    const before = JSON.parse(old) as Record<string, unknown>;
    for (const step of ['E1', 'E2', 'E4', 'E5', 'E6', 'E7']) expect(next[step]).toEqual(before[step]);
  });

  it('the refreshed file is accepted by the same check the enable command uses, on a day the old file would have been too old', () => {
    const lateDay = new Date('2026-11-05T00:00:00.000Z');
    expect(checkEvidenceFile(old, lateDay).problems.join(' ')).toContain('E3 was checked more than 30 days ago');
    const { text } = refreshFinalityEvidence({ evidenceText: old, report: report(), today: new Date('2026-11-04T09:00:00.000Z') });
    expect(checkEvidenceFile(text, lateDay).problems.join(' ')).not.toContain('E3');
  });

  it('writes nothing when the observation does not prove finality, and says why', () => {
    const cases: Array<[string, FinalityReport]> = [
      ['only 2', report({ followed: [tracked(), tracked()] })],
      ['never posted', report({ followed: [tracked(), tracked(), tracked(), tracked({ postedAfterSeconds: null, finalAfterSeconds: null })] })],
      ['not final', report({ followed: [tracked({ finalAfterSeconds: null }), tracked({ finalAfterSeconds: null }), tracked({ finalAfterSeconds: null }), tracked()] })],
      ['out of order', report({ stagesInOrder: false })],
      ['nothing followed', report({ followed: [] })],
    ];
    for (const [name, bad] of cases) {
      expect(finalityVerdict(bad).passed, name).toBe(false);
      expect(() => refreshFinalityEvidence({ evidenceText: old, report: bad, today: TODAY }), name).toThrow('FINALITY_NOT_PROVEN');
    }
  });

  it('refuses an unusable old file instead of inventing one', () => {
    expect(() => refreshFinalityEvidence({ evidenceText: 'not json', report: report(), today: TODAY })).toThrow('EVIDENCE_FILE_NOT_JSON');
    expect(() => refreshFinalityEvidence({ evidenceText: '[]', report: report(), today: TODAY })).toThrow('EVIDENCE_FILE_SHAPE');
    const withoutE6 = JSON.stringify({ ...(JSON.parse(old) as object), E6: undefined });
    expect(() => refreshFinalityEvidence({ evidenceText: withoutE6, report: report(), today: TODAY })).toThrow('EVIDENCE_FILE_MISSING_E6');
  });
});
