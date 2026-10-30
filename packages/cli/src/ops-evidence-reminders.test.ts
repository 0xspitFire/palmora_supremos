import { describe, expect, it, vi } from 'vitest';
import { buildOpsEvidenceReminders, startOpsEvidenceReminders } from './ops-evidence-reminders.js';

const NOW = new Date('2026-10-30T12:00:00.000Z');
const report = (overrides: Record<string, unknown> = {}) => ({
  humanEvidenceComplete: true,
  missing: [],
  acceptance: 'accepted',
  acceptanceProblems: [],
  acceptanceExpiresAt: '2026-11-29T12:00:00.000Z',
  artifactExpiry: {
    recovery: { completedAt: '2026-10-29T12:00:00.000Z', expiresAt: '2026-11-05T12:00:00.000Z' },
    backup_restore: { completedAt: '2026-10-29T12:00:00.000Z', expiresAt: '2026-11-05T12:00:00.000Z' },
  },
  ...overrides,
});

describe('D-017 evidence reminders', () => {
  it('does not message when all evidence is accepted and outside the reminder window', () => {
    expect(buildOpsEvidenceReminders(report(), NOW)).toEqual([]);
  });

  it('sends a three-day reminder with the next action for a short-lived artifact', () => {
    const reminders = buildOpsEvidenceReminders(report({ artifactExpiry: { recovery: { completedAt: '2026-10-23T12:00:00.000Z', expiresAt: '2026-11-02T12:00:00.000Z' } } }), NOW);
    expect(reminders).toHaveLength(1);
    expect(reminders[0]!).toMatchObject({ severity: 'three_day', dedupe: 'ops-evidence:three-day:recovery:2026-11-02T12:00:00.000Z' });
    expect(reminders[0]!.text).toContain('Next action: re-run the recovery drill');
  });

  it('sends a D-day reminder and a periodic summary when acceptance is stale', () => {
    const reminders = buildOpsEvidenceReminders(report({ acceptance: 'not_accepted', acceptanceProblems: ['ACCEPTANCE_NOT_RECORDED'], acceptanceExpiresAt: '2026-10-30T12:00:00.000Z' }), NOW);
    expect(reminders.map((item) => item.severity)).toEqual(expect.arrayContaining(['periodic', 'expiry']));
    expect(reminders.find((item) => item.severity === 'expiry')?.text).toContain('expires today');
  });

  it('runs periodically and relies on durable alert deduplication', async () => {
    const alert = vi.fn(async () => true);
    const service = startOpsEvidenceReminders({ evaluate: async () => report({ acceptance: 'not_accepted', acceptanceProblems: ['EVIDENCE_STALE'] }), alert, intervalMs: 60_000, now: () => NOW });
    await service.checkNow();
    service.stop();
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ kind: 'status', priority: 'immediate', text: expect.stringContaining('D-017 evidence needs action') }));
  });
});
