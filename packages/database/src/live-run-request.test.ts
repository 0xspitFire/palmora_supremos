import { describe, expect, it } from 'vitest';
import { openDatabase } from './database.js';
import { DurableRepository, type LiveRunRequestRecord } from './repositories.js';

/** T-058: the owner's live request is complete, short-lived, immutable, and claimed at most once. */
function fixture() {
  const db = openDatabase();
  db.prepare("INSERT INTO chain_profile (id, chain_id, name, rpc_endpoints_json, confirmation_depth, created_at) VALUES ('chain', 1, 'Ethereum', '[]', 2, '2026-01-01T00:00:00.000Z')").run();
  db.prepare("INSERT INTO contract (id, chain_profile_id, address, kind) VALUES ('contract', 'chain', '0xc', 'nft')").run();
  db.prepare("INSERT INTO collection (id, contract_id, name) VALUES ('collection', 'contract', 'c')").run();
  db.prepare("INSERT INTO \"drop\" (id, collection_id, strategy, mint_price_wei, observed_at) VALUES ('drop', 'collection', 'test', '0', '2026-01-01T00:00:00.000Z')").run();
  db.prepare("INSERT INTO campaign (id, drop_id, state, created_at) VALUES ('campaign', 'drop', 'draft', '2026-01-01T00:00:00.000Z')").run();
  return { db, repository: new DurableRepository(db) };
}

const request = (overrides: Partial<LiveRunRequestRecord> = {}): LiveRunRequestRecord => ({
  id: 'request-1',
  campaignId: 'campaign',
  wallets: ['0x1111111111111111111111111111111111111111'],
  simulationIds: ['sim-1'],
  approvalId: 'approval-1',
  evidenceAt: '2026-10-24T10:00:00.000Z',
  maxFeeGwei: '5',
  confirmationDigest: 'a'.repeat(64),
  requestedAt: '2026-10-24T10:00:00.000Z',
  expiresAt: '2026-10-24T10:30:00.000Z',
  ...overrides,
});

describe('live run requests (T-058)', () => {
  it('records a complete request and lists it until it is claimed, which happens once', () => {
    const { repository } = fixture();
    repository.recordLiveRunRequest(request());
    expect(repository.unclaimedLiveRunRequests().map((item) => item.id)).toEqual(['request-1']);
    expect(repository.unclaimedLiveRunRequests()[0]!.wallets).toEqual(['0x1111111111111111111111111111111111111111']);
    expect(repository.claimLiveRunRequest('request-1', 'started', '2026-10-24T10:00:05.000Z')).toBe(true);
    expect(repository.claimLiveRunRequest('request-1', 'started', '2026-10-24T10:00:10.000Z')).toBe(false);
    expect(repository.claimLiveRunRequest('request-1', 'expired', '2026-10-24T10:00:10.000Z')).toBe(false);
    expect(repository.unclaimedLiveRunRequests()).toEqual([]);
  });

  it('refuses a request that lives longer than 30 minutes, has mismatched lists, or no fee ceiling (fail closed)', () => {
    const { repository } = fixture();
    expect(() => repository.recordLiveRunRequest(request({ expiresAt: '2026-10-24T10:31:00.000Z' }))).toThrow(/incomplete/);
    expect(() => repository.recordLiveRunRequest(request({ expiresAt: '2026-10-24T09:59:00.000Z' }))).toThrow(/incomplete/);
    expect(() => repository.recordLiveRunRequest(request({ wallets: [] , simulationIds: [] }))).toThrow(/incomplete/);
    expect(() => repository.recordLiveRunRequest(request({ simulationIds: ['a', 'b'] }))).toThrow(/incomplete/);
    expect(() => repository.recordLiveRunRequest(request({ maxFeeGwei: '0' }))).toThrow(/incomplete/);
    expect(() => repository.recordLiveRunRequest(request({ maxFeeGwei: '501' }))).toThrow(/incomplete/);
    expect(() => repository.recordLiveRunRequest(request({ maxFeeGwei: '5e2' }))).toThrow(/incomplete/);
    expect(() => repository.recordLiveRunRequest(request({ approvalId: '' }))).toThrow(/incomplete/);
    expect(() => repository.recordLiveRunRequest(request({ confirmationDigest: 'not-a-digest' }))).toThrow();
    expect(() => repository.recordLiveRunRequest(request({ campaignId: 'no-such-campaign' }))).toThrow();
    expect(repository.unclaimedLiveRunRequests()).toEqual([]);
  });

  it('a request and its outcome can never be changed or deleted', () => {
    const { db, repository } = fixture();
    repository.recordLiveRunRequest(request());
    expect(() => db.prepare("UPDATE live_run_request SET max_fee_gwei = '400'").run()).toThrow(/immutable/);
    expect(() => db.prepare('DELETE FROM live_run_request').run()).toThrow(/immutable/);
    repository.claimLiveRunRequest('request-1', 'started', '2026-10-24T10:00:05.000Z');
    expect(() => db.prepare("UPDATE live_run_request_outcome SET outcome = 'expired'").run()).toThrow(/immutable/);
    expect(() => db.prepare('DELETE FROM live_run_request_outcome').run()).toThrow(/immutable/);
  });
});
