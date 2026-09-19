/** Product Owner approved Phase 2 operating defaults. */
export const PHASE2_DEFAULTS = Object.freeze({
  readinessFreshnessMs: 5 * 60 * 1_000,
  discoveryFreshnessMs: 15 * 60 * 1_000,
  calendarFreshnessMs: 15 * 60 * 1_000,
  immediateAlertTypes: Object.freeze(['kill', 'cap', 'failed', 'blocked'] as const),
  readModelRetentionMs: 30 * 24 * 60 * 60 * 1_000,
  alertRetentionMs: 30 * 24 * 60 * 60 * 1_000,
  auditRetentionMs: 90 * 24 * 60 * 60 * 1_000,
  maxConcurrency: 10,
  jobLeaseMs: 60_000,
  schedulerPollMs: 250,
});

export type ImmediateAlertType = (typeof PHASE2_DEFAULTS.immediateAlertTypes)[number];
