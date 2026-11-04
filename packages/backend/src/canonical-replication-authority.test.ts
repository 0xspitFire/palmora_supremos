import { describe, expect, it } from 'vitest';
import { campaign, close, ETHEREUM, fixture, NOW, WALLET_ONE, WALLET_TWO } from './canonical-fixtures.js';
import type { EventRecord } from './types.js';

describe('canonical replication authority and request boundary', () => {
  it('projects the authority transactionally so a valid automatic request can reference its real FK', async () => {
    const f = await fixture(ETHEREUM);
    try {
      const c = await campaign(f, ETHEREUM);
      const authority: EventRecord = { id: 'auto-authority', type: 'replication_prepared', at: NOW, data: { campaignId: c.id, mintPriceWei: '0', policyVersion: 'free-watched-v1', score: 70, maxFeeGwei: 0.2, wallets: [WALLET_ONE] } };
      await f.store.transaction((state) => state.events.push(authority));
      const stored = f.db.prepare('SELECT event_type, payload_json FROM event WHERE id = ?').get(authority.id) as { event_type: string; payload_json: string };
      expect(stored.event_type).toBe(authority.type);
      expect(JSON.parse(stored.payload_json)).toEqual(authority.data);
      expect(f.db.prepare('SELECT new_state FROM audit_event WHERE id = ?').get(authority.id)).toEqual({ new_state: authority.type });
      const request = { id: 'request', campaignId: c.id, wallets: [WALLET_ONE], simulationIds: ['sim'], approvalId: 'approval', evidenceAt: NOW, maxFeeGwei: '0.1', confirmationDigest: 'c'.repeat(64), requestedAt: NOW, expiresAt: '2026-09-14T14:10:00.000Z', provenance: { kind: 'automation' as const, eventId: authority.id } };
      f.store.recordLiveRunRequest(request);
      expect(f.db.prepare('SELECT automation_event_id FROM live_run_request WHERE id = ?').get('request')).toEqual({ automation_event_id: authority.id });
      expect(() => f.store.recordLiveRunRequest({ ...request, id: 'second', provenance: { kind: 'automation', eventId: 'missing' } })).toThrow();
      expect(() => f.store.recordLiveRunRequest({ ...request, id: 'extra-wallet', wallets: [WALLET_TWO] })).toThrow();
      expect(() => f.store.recordLiveRunRequest({ ...request, id: 'expensive', maxFeeGwei: '0.3' })).toThrow();
      expect(() => f.store.recordLiveRunRequest({ ...request, id: 'duplicate-authority' })).toThrow();
    } finally { await close(f); }
  });

  it('rolls back the audit and domain projection together if the authority names a missing campaign', async () => {
    const f = await fixture(ETHEREUM);
    try {
      await expect(f.store.transaction((state) => state.events.push({ id: 'invalid-authority', type: 'replication_prepared', at: NOW, data: { campaignId: 'missing' } }))).rejects.toThrow();
      expect(f.db.prepare('SELECT id FROM audit_event WHERE id = ?').get('invalid-authority')).toBeUndefined();
      expect(f.db.prepare('SELECT id FROM event WHERE id = ?').get('invalid-authority')).toBeUndefined();
    } finally { await close(f); }
  });
});
