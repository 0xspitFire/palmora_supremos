import { expect, it } from 'vitest';
import { automationStatus } from './automation-status.js';
it('projects bounded diagnostic metadata without promoting high alerts or leaking arbitrary payloads', () => {
  const at = '2026-11-07T10:00:00Z';
  const result = automationStatus([
    { id: 'x', type: 'opportunity_notified', at, data: { score: 99 } },
    { id: 'a', type: 'replication_decision', at, data: { code: 'https://secret.invalid', contract: 'credential', chainId: 999, stage: 'raw payload' } },
    { id: 'b', type: 'replication_requested', at: '2026-11-08T10:00:00Z', data: {} },
  ], new Date(at));
  expect(result.requested).toBe(0);
  expect(result.decisions[0]).toMatchObject({ code: 'REPLICATION_REASON_UNAVAILABLE', contract: null, chainId: null, stage: 'unknown' });
  expect(JSON.stringify(result)).not.toContain('secret.invalid');
});
