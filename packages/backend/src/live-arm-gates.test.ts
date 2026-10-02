import { describe, expect, it } from 'vitest';
import { ETHEREUM, WALLET_ONE, campaign, close, fixture } from './canonical-fixtures.js';
import type { OperationalReadiness } from './types.js';

/**
 * The gates a live `arm` walks through today (T-026 rehearsal finding). Each step supplies exactly what the
 * previous refusal asked for, as the production host's probes would, and stops at the first refusal that no probe
 * can fix. This pins the current behaviour; when the custody decision changes, this test changes with it.
 */
const NOW = new Date('2026-09-14T14:00:00.000Z');
const operational = (provider: 'local' | 'turnkey'): OperationalReadiness => ({
  secretStoreReference: 'secret-store-ref', storePath: '/tmp/state.sqlite', signerReady: true, killSwitchEngaged: false, notificationReady: true, chainVerification: 'verified',
  observedAt: '2026-09-14T13:59:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', lastReconciliationAt: '2026-09-14T13:58:00.000Z',
  custody: { provider, providerIdentity: 'keystore-1', policyReference: `${provider}:policy-1`, policyDigest: `0x${'ab'.repeat(32)}`, policyStatus: 'approved', healthStatus: 'healthy', attestationStatus: 'verified', evidenceId: 'evidence-1', observedAt: '2026-09-14T13:59:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z' },
} as OperationalReadiness);

describe('live arm gate ladder (what a Personal Live arm needs today)', () => {
  it('walks startup, dependency and readiness gates, then refuses a local keystore as custody', async () => {
    const value = await fixture(ETHEREUM);
    try {
      const created = await campaign(value, ETHEREUM);
      const validated = { campaign: created, wallets: [WALLET_ONE], simulationIds: [] as string[], evidenceAt: NOW.toISOString() };
      await value.application.command('approve', { validated });
      const seen: string[] = [];
      for (let step = 0; step < 8; step += 1) {
        try { await value.application.command('arm', { validated, mode: 'live' }); seen.push('ARMED'); break; }
        catch (error) {
          const code = (error as Error).message.split(':')[0]!;
          seen.push(code);
          if (code === 'STARTUP_RECONCILIATION_REQUIRED') await value.store.transaction((state) => { state.runtime.startupState = 'Ready'; });
          else if (code === 'DEPLOYMENT_DEPENDENCIES_NOT_READY') await value.store.transaction((state) => { state.runtime.dependencies = { engine: true, chain: true, backup: true, notifications: true }; });
          else if (code === 'RUNTIME_READINESS_REQUIRED') await value.store.transaction((state) => { state.runtime.operational = operational('local'); });
          else break; // a refusal no probe can fix
        }
      }
      // Nothing in the CLI supplies these facts, and a local keystore is refused outright.
      expect(seen).toEqual(['STARTUP_RECONCILIATION_REQUIRED', 'DEPLOYMENT_DEPENDENCIES_NOT_READY', 'RUNTIME_READINESS_REQUIRED', 'CUSTODY_PROVIDER_UNAPPROVED']);
    } finally { await close(value); }
  });

  it('with approved custody the next wall is the per-wallet simulation and chain evidence records', async () => {
    const value = await fixture(ETHEREUM);
    try {
      const created = await campaign(value, ETHEREUM);
      const validated = { campaign: created, wallets: [WALLET_ONE], simulationIds: [] as string[], evidenceAt: NOW.toISOString() };
      await value.application.command('approve', { validated });
      await value.store.transaction((state) => { state.runtime.startupState = 'Ready'; state.runtime.dependencies = { engine: true, chain: true, backup: true, notifications: true }; state.runtime.operational = operational('turnkey'); });
      await expect(value.application.command('arm', { validated, mode: 'live' })).rejects.toThrow('PER_WALLET_SIMULATION_REQUIRED');
    } finally { await close(value); }
  });
});
