import { describe, expect, it } from 'vitest';
import { fixture, close, ETHEREUM, NOW } from './canonical-fixtures.js';
import { DurableStore } from './store.js';
import { EvidenceService, SEADROP_PUBLIC_FREE_ALLOWLIST_SIGNED_BASELINE, validFreeSignedRehearsalReference } from './evidence.js';
import { PERMANENT_ENABLEMENT_EXPIRY } from './robinhood-enablement.js';
import { acceptEthereumChainEvidence, buildEthereumChainEvidence, ethereumChainEvidencePhrase, ethereumChainEvidenceRevokePhrase, revokeEthereumChainEvidence } from './personal-live-readiness.js';

const build = (now = new Date(NOW), validity: 'permanent' | '7-days' = 'permanent') => buildEthereumChainEvidence({ now, validity, sourceBlock: 123n, sourceBlockHash: `0x${'ab'.repeat(32)}`, strategy: 'seadrop-v1-public' });

describe('owner Ethereum acceptance lifecycle', () => {
  it('records permanent authority without extending an existing seven-day record implicitly', async () => {
    const value = await fixture(ETHEREUM);
    try {
      const legacy = build(new Date(NOW), '7-days');
      await acceptEthereumChainEvidence(value.store, legacy, ethereumChainEvidencePhrase('7-days'), () => new Date(NOW));
      expect(value.store.snapshot().chainEvidence.find(item => item.id === legacy.id)?.expiresAt).toBe('2026-09-21T14:00:00.000Z');
      const permanent = build(new Date(Date.parse(NOW) + 1_000));
      await expect(acceptEthereumChainEvidence(value.store, permanent, ethereumChainEvidencePhrase('7-days'), () => new Date(NOW))).rejects.toThrow('ETHEREUM_CHAIN_APPROVAL_SCOPE_INVALID');
      await acceptEthereumChainEvidence(value.store, permanent, ethereumChainEvidencePhrase(), () => new Date(Date.parse(NOW) + 1_000));
      expect(value.store.snapshot().chainEvidence.find(item => item.id === permanent.id)).toMatchObject({ expiresAt: PERMANENT_ENABLEMENT_EXPIRY, executionEnabled: true });
      expect(value.store.snapshot().chainEvidence.find(item => item.id === legacy.id)?.executionEnabled).toBe(false);
    } finally { await close(value); }
  });

  it('appends a revocation, refuses stale confirmation and never resurrects old evidence after reacceptance', async () => {
    const value = await fixture(ETHEREUM);
    try {
      const first = build();
      await acceptEthereumChainEvidence(value.store, first, ethereumChainEvidencePhrase(), () => new Date(NOW));
      await expect(revokeEthereumChainEvidence(value.store, first.id, 'wrong', () => new Date(NOW))).rejects.toThrow('CONFIRMATION_PHRASE_MISMATCH');
      await revokeEthereumChainEvidence(value.store, first.id, ethereumChainEvidenceRevokePhrase(first.id), () => new Date(Date.parse(NOW) + 1_000));
      expect(value.db.prepare('SELECT execution_enabled FROM chain_profile WHERE chain_id = 1').get()).toEqual({ execution_enabled: 0 });
      expect(value.store.snapshot().chainEvidence.filter(item => item.chainId === 1 && item.executionEnabled)).toEqual([]);
      const second = build(new Date(Date.parse(NOW) + 2_000));
      await acceptEthereumChainEvidence(value.store, second, ethereumChainEvidencePhrase(), () => new Date(Date.parse(NOW) + 2_000));
      expect(value.store.snapshot().chainEvidence.find(item => item.id === first.id)).toMatchObject({ status: 'accepted', executionEnabled: false });
      expect(value.store.snapshot().chainEvidence.filter(item => item.chainId === 1 && item.executionEnabled).map(item => item.id)).toEqual([second.id]);
      await expect(revokeEthereumChainEvidence(value.store, first.id, ethereumChainEvidenceRevokePhrase(first.id), () => new Date(Date.parse(NOW) + 3_000))).rejects.toThrow('ETHEREUM_CHAIN_EVIDENCE_CHANGED');
      expect(value.store.snapshot().chainEvidence.find(item => item.id === second.id)?.executionEnabled).toBe(true);
      expect(() => new EvidenceService(value.store).assertLiveEvidence({ campaign: { chainId: 1, strategy: 'seadrop-v1-public', chainVerification: { evidenceId: first.id } } } as never)).toThrow('CHAIN_VERIFICATION_NOT_ACCEPTED');
    } finally { await close(value); }
  });

  it('keeps immutable evidence history and disables old authority in the durable fallback store too', async () => {
    const store = new DurableStore(); await store.open();
    const first = build();
    await acceptEthereumChainEvidence(store, first, ethereumChainEvidencePhrase(), () => new Date(NOW));
    await revokeEthereumChainEvidence(store, first.id, ethereumChainEvidenceRevokePhrase(first.id), () => new Date(Date.parse(NOW) + 1_000));
    const second = build(new Date(Date.parse(NOW) + 2_000));
    await acceptEthereumChainEvidence(store, second, ethereumChainEvidencePhrase(), () => new Date(Date.parse(NOW) + 2_000));
    expect(store.snapshot().chainEvidence.find(item => item.id === first.id)).toMatchObject({ status: 'accepted', executionEnabled: false });
    expect(store.snapshot().chainEvidence.filter(item => item.executionEnabled).map(item => item.id)).toEqual([second.id]);
  });

  it('refuses Ethereum approval for another chain and does not reuse IDs within one block', async () => {
    const store = new DurableStore(); await store.open();
    await expect(acceptEthereumChainEvidence(store, { ...build(), chainId: 8453 }, ethereumChainEvidencePhrase(), () => new Date(NOW))).rejects.toThrow('ETHEREUM_CHAIN_APPROVAL_SCOPE_INVALID');
    expect(store.snapshot().chainEvidence).toEqual([]);
    expect(build().id).not.toBe(build().id);
  });
});

it('requires a distinct owner phrase to add free allowlist baseline scope and leaves old evidence unchanged', async () => {
  const store = new DurableStore(); await store.open();
  const legacy = build();
  await acceptEthereumChainEvidence(store, legacy, ethereumChainEvidencePhrase(), () => new Date(NOW));
  const scoped = buildEthereumChainEvidence({ now: new Date(NOW), sourceBlock: 123n, sourceBlockHash: 'anchor', strategy: 'seadrop-v1-public', includeFreeAllowlist: true });
  await expect(acceptEthereumChainEvidence(store, scoped, ethereumChainEvidencePhrase(), () => new Date(NOW))).rejects.toThrow('ETHEREUM_CHAIN_APPROVAL_SCOPE_INVALID');
  expect(ethereumChainEvidencePhrase('permanent', true)).toContain('CHAIN-1 PUBLIC+FREE-ALLOWLIST-V1');
  await acceptEthereumChainEvidence(store, scoped, ethereumChainEvidencePhrase('permanent', true), () => new Date(NOW));
  expect(store.snapshot().chainEvidence.find(item => item.id === legacy.id)?.strategyVersion).toBe('seadrop-v1-public-1');
  expect(store.snapshot().chainEvidence.find(item => item.id === scoped.id)?.strategyVersion).toBe('seadrop-v1-baseline-public-free-allowlist@1');
});


describe('explicit owner review of the free signed Ethereum baseline', () => {
  const reference = 'artifacts/ethereum-free-signed-replay-2026-11-07.json';
  const signedBuild = () => buildEthereumChainEvidence({ now: new Date(NOW), sourceBlock: 123n, sourceBlockHash: 'anchor', strategy: 'seadrop-v1-public', includeFreeSigned: true, freeSignedRehearsalReference: reference });

  it('requires a distinct scope, exact phrase and explicit rehearsal reference before accepting', async () => {
    const store = new DurableStore();
    const legacy = build();
    await acceptEthereumChainEvidence(store, legacy, ethereumChainEvidencePhrase(), () => new Date(NOW));
    const signed = signedBuild();
    expect(signed.strategyVersion).toBe(SEADROP_PUBLIC_FREE_ALLOWLIST_SIGNED_BASELINE);
    const phrase = ethereumChainEvidencePhrase('permanent', false, true);
    expect(phrase).toContain('CHAIN-1 PUBLIC+FREE-ALLOWLIST+FREE-SIGNED-V1');
    await expect(acceptEthereumChainEvidence(store, signed, phrase, () => new Date(NOW))).rejects.toThrow('FREE_SIGNED_REHEARSAL_REFERENCE_REQUIRED');
    await expect(acceptEthereumChainEvidence(store, signed, ethereumChainEvidencePhrase('permanent', true), () => new Date(NOW), reference)).rejects.toThrow('ETHEREUM_CHAIN_APPROVAL_SCOPE_INVALID');
    expect(store.snapshot().chainEvidence.find(item => item.id === legacy.id)?.executionEnabled).toBe(true);
    await acceptEthereumChainEvidence(store, signed, phrase, () => new Date(NOW), reference);
    expect(store.snapshot().chainEvidence.find(item => item.id === legacy.id)?.executionEnabled).toBe(false);
    expect(store.snapshot().chainEvidence.find(item => item.id === signed.id)).toMatchObject({ executionEnabled: true, strategyVersion: SEADROP_PUBLIC_FREE_ALLOWLIST_SIGNED_BASELINE });
    expect(store.snapshot().events.find(event => event.type === 'chain_signed_rehearsal_review')?.data).toMatchObject({ chainId: 1, evidenceId: signed.id, reference });
  });

  it.each([undefined, '', 'https://rpc.example/private', 'credentials.env', 'private-key-file', 'bad\nreference'])('rejects unsafe or absent signed rehearsal reference %s', reference => {
    expect(validFreeSignedRehearsalReference(reference)).toBe(false);
    expect(() => buildEthereumChainEvidence({ now: new Date(NOW), sourceBlock: 123n, sourceBlockHash: 'anchor', strategy: 'seadrop-v1-public', includeFreeSigned: true, freeSignedRehearsalReference: reference })).toThrow('FREE_SIGNED_REHEARSAL_REFERENCE_REQUIRED');
  });
});
