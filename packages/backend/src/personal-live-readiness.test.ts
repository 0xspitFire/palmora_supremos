import { describe, expect, it } from 'vitest';
import { assertCustodyReadiness, type CustodyReadiness } from './custody.js';
import { BackendApplication } from './application.js';
import { ExecutionCoordinator } from './coordinator.js';
import { ETHEREUM, WALLET_ONE, WALLET_TWO, campaign, close, fixture, noopEngine } from './canonical-fixtures.js';
import { PersonalLiveReadinessService, acceptEthereumChainEvidence, buildEthereumChainEvidence, ethereumChainEvidencePhrase, recordWalletSimulations, type PersonalLiveProbes } from './personal-live-readiness.js';
import { DurableStore } from './store.js';

const NOW = new Date('2026-09-14T14:00:00.000Z');
const DIGEST = `0x${'cd'.repeat(32)}`;
const goodProbes = (overrides: Partial<PersonalLiveProbes> = {}): PersonalLiveProbes => ({
  chain: async () => ({ chainId: 1, headAgeSeconds: 5 }),
  keystore: async () => ({ digest: DIGEST, addresses: [WALLET_ONE] }),
  notifications: async () => true,
  backup: async () => ({ ok: true, ageMs: 60_000 }),
  killSwitchEngaged: async () => false,
  ...overrides,
});
const custody = (overrides: Partial<CustodyReadiness> = {}): CustodyReadiness => ({
  provider: 'local-personal-live', providerIdentity: 'local-encrypted-keystore', policyReference: 'personal-live:ethereum-v1', policyDigest: DIGEST, policyStatus: 'approved', healthStatus: 'healthy', attestationStatus: 'verified',
  evidenceId: 'evidence-1', observedAt: '2026-09-14T13:59:00.000Z', expiresAt: '2026-09-15T13:59:00.000Z', keystoreDigest: DIGEST, wallets: [WALLET_ONE], confirmedBy: 'owner-cli', ...overrides,
} as CustodyReadiness);
const context = { chainId: 1, wallets: [WALLET_ONE] };

describe('a local keystore for Ethereum Personal Live (D-043)', () => {
  it('is accepted with owner-recorded evidence for Ethereum and the named wallets', () => {
    expect(() => assertCustodyReadiness(custody(), NOW, undefined, context)).not.toThrow();
  });

  it('is refused without a Personal Live context, when a Turnkey or cloud-key binding is expected, and for any chain but Ethereum', () => {
    expect(() => assertCustodyReadiness(custody(), NOW)).toThrow('CUSTODY_PROVIDER_UNAPPROVED');
    expect(() => assertCustodyReadiness(custody(), NOW, { provider: 'turnkey', providerIdentity: 'x', policyReference: 'turnkey:p', policyDigest: DIGEST }, context)).toThrow('CUSTODY_PROVIDER_UNAPPROVED');
    expect(() => assertCustodyReadiness(custody(), NOW, undefined, { chainId: 4663, wallets: [WALLET_ONE] })).toThrow('CUSTODY_PERSONAL_LIVE_ETHEREUM_ONLY');
    expect(() => assertCustodyReadiness(custody(), NOW, undefined, { chainId: 8453, wallets: [WALLET_ONE] })).toThrow('CUSTODY_PERSONAL_LIVE_ETHEREUM_ONLY');
  });

  it('is refused for a wallet it does not name, an expired or over-long record, a missing digest or confirmation, and a wrong policy', () => {
    expect(() => assertCustodyReadiness(custody(), NOW, undefined, { chainId: 1, wallets: [WALLET_ONE, WALLET_TWO] })).toThrow('CUSTODY_WALLET_NOT_COVERED');
    expect(() => assertCustodyReadiness(custody({ wallets: [] }), NOW, undefined, context)).toThrow('CUSTODY_WALLET_NOT_COVERED');
    expect(() => assertCustodyReadiness(custody(), NOW, undefined, { chainId: 1, wallets: [] })).toThrow('CUSTODY_WALLET_NOT_COVERED');
    expect(() => assertCustodyReadiness(custody({ expiresAt: '2026-09-14T13:59:30.000Z' }), NOW, undefined, context)).toThrow('CUSTODY_EVIDENCE_STALE');
    expect(() => assertCustodyReadiness(custody({ observedAt: '2026-09-14T13:00:00.000Z', expiresAt: '2026-09-15T14:00:01.000Z' }), new Date('2026-09-14T14:00:00.000Z'), undefined, context)).toThrow('CUSTODY_EVIDENCE_TOO_LONG');
    expect(() => assertCustodyReadiness(custody({ keystoreDigest: undefined }), NOW, undefined, context)).toThrow('CUSTODY_POLICY_DIGEST_REQUIRED');
    expect(() => assertCustodyReadiness(custody({ keystoreDigest: '0x12' }), NOW, undefined, context)).toThrow('CUSTODY_POLICY_DIGEST_REQUIRED');
    expect(() => assertCustodyReadiness(custody({ confirmedBy: '' }), NOW, undefined, context)).toThrow('CUSTODY_OWNER_CONFIRMATION_REQUIRED');
    expect(() => assertCustodyReadiness(custody({ policyReference: 'turnkey:p' }), NOW, undefined, context)).toThrow('CUSTODY_POLICY_PROVIDER_MISMATCH');
    expect(() => assertCustodyReadiness(custody({ policyStatus: 'unknown' }), NOW, undefined, context)).toThrow('CUSTODY_POLICY_NOT_APPROVED');
    expect(() => assertCustodyReadiness(custody({ healthStatus: 'unhealthy' }), NOW, undefined, context)).toThrow('CUSTODY_HEALTH_NOT_READY');
    expect(() => assertCustodyReadiness(custody({ attestationStatus: 'failed' }), NOW, undefined, context)).toThrow('CUSTODY_ATTESTATION_REQUIRED');
  });

  it('still refuses the old plain local provider', () => {
    expect(() => assertCustodyReadiness(custody({ provider: 'local' }), NOW, undefined, context)).toThrow('CUSTODY_PROVIDER_UNAPPROVED');
  });
});

describe('recording readiness (live-readiness record)', () => {
  async function ready() {
    const value = await fixture(ETHEREUM);
    const coordinator = new ExecutionCoordinator(value.store, noopEngine, { acceptPersonalLiveLocalCustody: true });
    await coordinator.start();
    return { value, coordinator, app: new BackendApplication(value.store, coordinator) };
  }
  const args = { wallets: [WALLET_ONE], confirmedBy: 'owner-cli', storePath: '/tmp/state.sqlite', secretStoreReference: 'secret-store-ref' };

  it('records nothing and says why when any check fails', async () => {
    const { value } = await ready();
    try {
      const cases: Array<[Partial<PersonalLiveProbes>, string]> = [
        [{ chain: async () => ({ chainId: 4663, headAgeSeconds: 1 }) }, 'chain'],
        [{ chain: async () => ({ chainId: 1, headAgeSeconds: 600 }) }, 'chain'],
        [{ chain: async () => { throw new Error('ETIMEDOUT: x'); } }, 'chain'],
        [{ keystore: async () => ({ digest: '0x12', addresses: [WALLET_ONE] }) }, 'keystore'],
        [{ keystore: async () => ({ digest: DIGEST, addresses: [WALLET_ONE, WALLET_TWO] }) }, 'wallets'],
        [{ keystore: async () => ({ digest: DIGEST, addresses: [WALLET_TWO] }) }, 'wallets'],
        [{ notifications: async () => false }, 'notifications'],
        [{ backup: async () => ({ ok: false, ageMs: 1 }) }, 'backup'],
        [{ backup: async () => ({ ok: true, ageMs: 25 * 3_600_000 }) }, 'backup'],
        [{ killSwitchEngaged: async () => true }, 'kill_switch'],
      ];
      for (const [override, check] of cases) {
        const outcome = await new PersonalLiveReadinessService(value.store, goodProbes(override), () => NOW).record(args);
        expect(outcome.recorded).toBe(false);
        if (!outcome.recorded) expect(outcome.failures.map((failure) => failure.check)).toContain(check);
        expect(value.store.snapshot().runtime.operational).toBeUndefined();
        expect(value.store.snapshot().runtime.dependencies.chain).toBe(false);
      }
    } finally { await close(value); }
  });

  it('records the facts with a 15 minute probe and a 24 hour custody record when every check passes', async () => {
    const { value } = await ready();
    try {
      const outcome = await new PersonalLiveReadinessService(value.store, goodProbes(), () => new Date()).record(args);
      expect(outcome.recorded).toBe(true);
      const runtime = value.store.snapshot().runtime;
      expect(runtime.dependencies).toMatchObject({ engine: true, chain: true, backup: true });
      expect(runtime.operational?.custody).toMatchObject({ provider: 'local-personal-live', wallets: [WALLET_ONE.toLowerCase()], keystoreDigest: DIGEST, confirmedBy: 'owner-cli' });
      const probeMs = Date.parse(runtime.operational!.expiresAt) - Date.parse(runtime.operational!.observedAt);
      expect(probeMs).toBe(15 * 60 * 1000);
    } finally { await close(value); }
  });

  it('refuses when startup reconciliation has not completed', async () => {
    const value = await fixture(ETHEREUM);
    try {
      const outcome = await new PersonalLiveReadinessService(value.store, goodProbes(), () => NOW).record(args);
      expect(outcome.recorded).toBe(false);
      if (!outcome.recorded) expect(outcome.failures.map((failure) => failure.check)).toContain('reconciliation');
    } finally { await close(value); }
  });

  it('lets a live arm succeed once chain evidence, simulations and readiness are all recorded, and only for the owner CLI coordinator', async () => {
    const { value, app } = await ready();
    try {
      const created = await campaign(value, ETHEREUM);
      const outcome = await new PersonalLiveReadinessService(value.store, goodProbes(), () => new Date()).record(args);
      expect(outcome.recorded).toBe(true);
      const ids = await recordWalletSimulations(value.store, created, [{ wallet: WALLET_ONE, success: true }], { blockNumber: 100n, blockHash: `0x${'11'.repeat(32)}` });
      const validated = { campaign: created, wallets: [WALLET_ONE], simulationIds: ids, evidenceAt: new Date().toISOString() };
      await app.command('approve', { validated });
      const armed = await app.command('arm', { validated, mode: 'live' });
      expect(armed.state).toBeTruthy();
      // The same facts do not arm through a coordinator that is not the owner's CLI (the service never sets the option).
      const service = new BackendApplication(value.store, new ExecutionCoordinator(value.store, noopEngine));
      await expect(service.command('arm', { validated, mode: 'live', idempotencyKey: 'again' })).rejects.toThrow('CUSTODY_PROVIDER_UNAPPROVED');
    } finally { await close(value); }
  });
});

describe('owner-accepted chain evidence and simulation records', () => {
  it('accepts Ethereum evidence only with the exact typed phrase, and records a simulation bound to the campaign', async () => {
    const store = new DurableStore();
    await store.open();
    const record = buildEthereumChainEvidence({ now: NOW, sourceBlock: 123n, sourceBlockHash: `0x${'22'.repeat(32)}`, strategy: 'seadrop-v1-public' });
    expect(record).toMatchObject({ chainId: 1, status: 'pending', executionEnabled: false });
    const phrase = ethereumChainEvidencePhrase(123n);
    await acceptEthereumChainEvidence(store, record, phrase, () => NOW);
    expect(store.snapshot().chainEvidence[0]).toMatchObject({ status: 'accepted', executionEnabled: true, acceptedBy: 'owner-cli' });
    expect(Date.parse(store.snapshot().chainEvidence[0]!.expiresAt) - NOW.getTime()).toBe(7 * 24 * 3_600_000);
    // A second, different record cannot be accepted with another phrase.
    const other = { ...buildEthereumChainEvidence({ now: NOW, sourceBlock: 124n, sourceBlockHash: `0x${'33'.repeat(32)}`, strategy: 'seadrop-v1-public' }) };
    const { EvidenceService } = await import('./evidence.js');
    const { ownerTypedAuthority } = await import('./personal-live-readiness.js');
    const service = new EvidenceService(store, () => NOW, ownerTypedAuthority(ethereumChainEvidencePhrase(124n)));
    await service.recordChainEvidence(other);
    await expect(service.acceptChainEvidence(other.id, { verifierId: 'owner-cli', proof: 'not-the-proof', acceptedAt: NOW.toISOString() })).rejects.toThrow('EVIDENCE_APPROVAL_REJECTED');
    await expect(service.acceptChainEvidence(other.id, { verifierId: 'someone-else', proof: 'x', acceptedAt: NOW.toISOString() })).rejects.toThrow('EVIDENCE_APPROVAL_REJECTED');
  });
});
