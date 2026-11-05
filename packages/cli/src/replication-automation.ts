import { randomUUID } from 'node:crypto';
import { campaignInputDigest, evaluateQualifiedAutomationGate, readEventSnapshot, type BackendStore, type Campaign, type EventRecord } from '@mint-bot/backend';
import type { Address } from 'viem';
import type { FireDeps } from './fire.js';
import type { FireResult } from './fire.js';
import type { QualifiedSource } from './replication-source.js';
import { replicationWithinCaps } from './replication-prepare.js';

export interface ReplicationAutomationDeps {
  store: BackendStore;
  watchedWallets(chainId: number): readonly string[];
  wallets(): Promise<Address[]>;
  qualify(event: EventRecord, wallets: readonly Address[]): Promise<QualifiedSource>;
  prepare(source: QualifiedSource, wallets: readonly Address[]): Promise<{ campaign: Campaign; wallets: string[]; maxFeeGwei: number } | Array<{ campaign: Campaign; wallets: string[]; maxFeeGwei: number }>>;
  fire: FireDeps;
  fireAutonomous(campaignId: string, wallets: readonly string[], maxFeeGwei: number, eventId: string): Promise<FireResult>;
  assertUnattendedReady(): Promise<void>;
  notify(text: string, dedupe: string): Promise<void>;
  now?: () => Date;
}

/** Serial, restart-safe claims precede preparation. An ambiguous run is never retried automatically. */
export function createReplicationAutomation(deps: ReplicationAutomationDeps): { tick(): Promise<void>; assertReady(eventId: string, campaign: Campaign, wallets?: readonly string[], maxFeeGwei?: number): Promise<void> } {
  const now = deps.now ?? (() => new Date());
  let busy = false;
  const assertReady = async (eventId: string, campaign: Campaign, wallets?: readonly string[], maxFeeGwei?: number): Promise<void> => {
    await deps.assertUnattendedReady();
    const state = deps.store.snapshot();
    const event = state.events.find((e) => e.id === eventId && e.type === 'replication_prepared');
    if (!event || event.data.policyVersion !== 'free-watched-v1' || event.data.campaignId !== campaign.id || event.data.campaignDigest !== campaignInputDigest(campaign) || campaign.mintPriceWei !== 0n || campaign.feePolicy.kind !== 'free' || deps.fire.killSwitchOn()) throw new Error('AUTOMATION_AUTHORITY_INVALID');
    if (wallets && (!wallets.length || new Set(wallets.map((w) => w.toLowerCase())).size !== wallets.length || !Array.isArray(event.data.wallets) || wallets.some((wallet) => !(event.data.wallets as string[]).includes(wallet.toLowerCase()))) || maxFeeGwei !== undefined && (!Number.isFinite(maxFeeGwei) || maxFeeGwei > Number(event.data.maxFeeGwei))) throw new Error('AUTOMATION_REQUEST_SCOPE_INVALID');
    const score = [...state.events].reverse().find((e) => e.type.startsWith('opportunity_') && e.data.contract === campaign.contract.toLowerCase() && e.data.chainId === campaign.chainId);
    if (!score || !Number.isFinite(Number(score.data.score)) || Number(score.data.score) < 70 || Number(score.data.score) > 100 || score.data.blocked === true || Date.parse(String(score.data.expiresAt)) <= now().getTime() || !Number.isFinite(Date.parse(String(score.data.expiresAt)))) throw new Error('AUTOMATION_SIGNAL_STALE');
    const sourceEvent = state.events.find((e) => e.id === event.data.sourceEventId && e.type === 'watched_wallet_mint');
    if (!sourceEvent) throw new Error('WATCHED_MINT_NOT_VERIFIED');
    const qualified = await deps.qualify(sourceEvent, (event.data.wallets as string[]).map((wallet) => wallet as Address));
    if (qualified.plan.verdict !== 'replicable' || qualified.drop.mintPrice !== 0n || qualified.drop.nftContract.toLowerCase() !== campaign.contract.toLowerCase() || qualified.drop.chainId !== campaign.chainId || qualified.drop.strategyName !== campaign.strategy) throw new Error('REPLICATION_CHANGED');
  };
  return {
    assertReady,
    async tick() {
      if (busy) return;
      busy = true;
      try {
        const events = readEventSnapshot(deps.store);
        const claims = new Set(events.filter((event) => event.type === 'replication_claim').map((event) => event.id));
        // Always use the newest score, including a downgrade or blocking risk.
        const scores = new Map<string, EventRecord>();
        for (const event of events) if (event.type.startsWith('opportunity_') && typeof event.data.contract === 'string') scores.set(`${event.data.chainId}:${event.data.contract}`, event);
        for (const score of [...scores.values()].slice(-20)) {
          const scoreAge = now().getTime() - Date.parse(score.at);
          if (!Number.isFinite(scoreAge) || scoreAge < 0 || scoreAge > 15 * 60_000 || score.data.blocked === true || typeof score.data.score !== 'number' || score.data.score < 70 || score.data.score > 100) continue;
          const source = [...events].reverse().find((e) => e.type === 'watched_wallet_mint' && e.data.chainId === score.data.chainId && e.data.contract === score.data.contract && deps.watchedWallets(Number(e.data.chainId)).some((wallet) => wallet.toLowerCase() === String(e.data.wallet).toLowerCase()));
          if (!source) continue;
          const key = `replication_claim:${score.data.chainId}:${score.data.contract}`;
          if (claims.has(key)) continue;
          let claimed = false;
          try {
            const wallets = await deps.wallets();
            const qualified = await deps.qualify(source, wallets);
            if (qualified.plan.verdict !== 'replicable') continue;
            // Persist before any campaign/request is created; crash recovery never repeats it.
            await deps.store.transaction((state) => { if (!state.events.some((e) => e.id === key)) { state.events.push({ id: key, type: 'replication_claim', at: now().toISOString(), data: { sourceEventId: source.id, scoreEventId: score.id, policyVersion: 'free-watched-v1' } }); claimed = true; } });
            if (!claimed) continue;
            claims.add(key);
            const preparedResult = await deps.prepare(qualified, wallets);
            for (const prepared of Array.isArray(preparedResult) ? preparedResult : [preparedResult]) {
            const simulations = await deps.fire.recordSimulations(prepared.campaign, prepared.wallets);
            if (!simulations.recorded.length) throw new Error('SIMULATION_NOT_PASSED');
            const id = `replication_prepared_${randomUUID()}`;
            await deps.store.transaction((state) => state.events.push({ id, type: 'replication_prepared', at: now().toISOString(), data: { policyVersion: 'free-watched-v1', campaignId: prepared.campaign.id, campaignDigest: campaignInputDigest(prepared.campaign), sourceEventId: source.id, sourceTxHash: qualified.observed.hash, sourceWallet: qualified.observed.from, scoreEventId: score.id, score: score.data.score, maxFeeGwei: prepared.maxFeeGwei, mintPriceWei: prepared.campaign.mintPriceWei.toString(), wallets: simulations.recorded } }));
            if (prepared.campaign.mintPriceWei > 0n) {
              await deps.notify(`Paid mint prepared: ${prepared.campaign.id}. ${simulations.recorded.length} wallet(s) passed simulation. Final approval is required: use /fire and review the price and total exposure.`, `replication-paid:${id}`);
              continue;
            }
            await assertReady(id, prepared.campaign);
            const gate = evaluateQualifiedAutomationGate({ score: Number(score.data.score), confidence: 0, watchedWalletMintVerified: true, mintPriceWei: 0n, replicationVerdict: qualified.plan.verdict, simulationPassed: true, chainVerified: prepared.campaign.chainVerification.status === 'verified', spendWithinCaps: replicationWithinCaps(deps.store, prepared.campaign, simulations.recorded, now()), killSwitchClear: !deps.fire.killSwitchOn(), operatorApproved: false, unattendedReady: true });
            if (!gate.allowed) throw new Error(gate.blockers[0]);
            const result = await deps.fireAutonomous(prepared.campaign.id, simulations.recorded, prepared.maxFeeGwei, id);
            await deps.store.transaction((state) => state.events.push({ id: `replication_requested_${randomUUID()}`, type: 'replication_requested', at: now().toISOString(), data: { campaignId: prepared.campaign.id, requestId: result.requestId, authorityEventId: id } }));
            }
          } catch (error) {
            const code = error instanceof Error && /^[A-Z][A-Z0-9_]{2,90}$/.test(error.message) ? error.message : 'REPLICATION_PREPARATION_BLOCKED';
            if (claimed) await deps.notify(`Replication stopped: ${code}. Check /runs and /requests before retrying.`, `replication-blocked:${key}`).catch(() => undefined);
          }
        }
      } finally { busy = false; }
    },
  };
}
