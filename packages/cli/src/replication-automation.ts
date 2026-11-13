import { createHash, randomUUID } from 'node:crypto';
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
  autoFunding?: {ensure(source:QualifiedSource,wallets:readonly Address[],sourceEvent:EventRecord,score:EventRecord):Promise<Array<{campaign:Campaign;wallets:string[];maxFeeGwei:number}>|undefined>};
  /** Production checks current balances before consuming the one-shot claim. */
  fundedWallets?(source: QualifiedSource, wallets: readonly Address[]): Promise<Address[]>;
  fire: FireDeps;
  fireAutonomous(campaignId: string, wallets: readonly string[], maxFeeGwei: number, eventId: string): Promise<FireResult>;
  assertUnattendedReady(): Promise<void>;
  /** Current signed protocol/source authority, rechecked after balances/funding awaits and before the one-shot claim. */
  assertSourceAuthority?(source:QualifiedSource,wallets:readonly Address[]):Promise<void>;
  assertScoringAuthority?(score: EventRecord): void | Promise<void>;
  notify(text: string, dedupe: string): Promise<void>;
  now?: () => Date;
  /** Read-only qualification can time out; no signing or claim starts in this timeout. */
  qualificationTimeoutMs?: number;
}

/** Serial, restart-safe claims precede preparation. An ambiguous run is never retried automatically. */
export function createReplicationAutomation(deps: ReplicationAutomationDeps): { tick(): Promise<void>; assertReady(eventId: string, campaign: Campaign, wallets?: readonly string[], maxFeeGwei?: number): Promise<void> } {
  const now = deps.now ?? (() => new Date());
  let busy = false;
  const assertScore = async(score:EventRecord):Promise<void> => {
    if(score.data.modelEpochId&&!deps.assertScoringAuthority)throw new Error('ADAPTIVE_DECISION_AUTHORITY_REQUIRED');
    await deps.assertScoringAuthority?.(score);
  };
  const retryAfter = new Map<string, number>();
  const qualify = async (source: EventRecord, wallets: readonly Address[]): Promise<QualifiedSource> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([deps.qualify(source, wallets), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('REPLICATION_SOURCE_READ_TIMEOUT')), deps.qualificationTimeoutMs ?? 20_000); timer.unref?.(); })]);
    } finally { if (timer !== undefined) clearTimeout(timer); }
  };
  const safeCode = (error: unknown): string => {
    const code = error instanceof Error ? error.message.split(':')[0]! : '';
    return /^[A-Z][A-Z0-9_]{2,90}$/.test(code) ? code : 'REPLICATION_SOURCE_UNAVAILABLE';
  };
  const explain = async (score: EventRecord, source: EventRecord | undefined, stage: string, code: string, known: Set<string>): Promise<void> => {
    const identity = `${score.data.chainId}:${score.data.contract}:${source?.id ?? 'no-source'}:${stage}:${code}`;
    const id = `replication_decision_${createHash('sha256').update(identity).digest('hex')}`;
    if (known.has(id)) return;
    await deps.store.transaction(state => {
      if (!state.events.some(event => event.id === id)) state.events.push({ id, type: 'replication_decision', at: now().toISOString(), data: { chainId: score.data.chainId, contract: score.data.contract, scoreEventId: score.id, ...(source ? { sourceEventId: source.id } : {}), stage, code, score: score.data.score, sent: false } });
    });
    known.add(id);
    const action = code === 'SIGNED_MINT_OWN_SIGNATURE_AND_CUSTODY_REQUIRED'
      ? 'This drop uses a wallet-specific server signature. It needs the signed-mint adapter and an owner-approved signing policy; public/allowlist policies cannot authorize it.'
      : code === 'OPENSEA_MINT_FUNDING_REQUIRED' || code === 'FUNDING_NOT_ARRIVED' ? 'No selected wallet passed the funding check. Check /funding for this chain. Fund only within the approved wallet balance ceilings; do not exceed a cap to satisfy a platform estimate.'
      : code === 'WATCHED_MINT_REQUIRED' ? 'A high score alone is not execution permission; a verified watched-wallet self-mint is required.'
      : 'Check /runs and /requests for the retained outcome. Mint, funding, custody, source freshness and spend guards still apply.';
    await deps.notify(`Automatic mint not requested on chain ${score.data.chainId} for ${score.data.contract}: ${code}. ${action}`, `replication-decision:${score.data.chainId}:${score.data.contract}:${code}`).catch(() => undefined);
  };
  const assertReady = async (eventId: string, campaign: Campaign, wallets?: readonly string[], maxFeeGwei?: number): Promise<void> => {
    await deps.assertUnattendedReady();
    const state = deps.store.snapshot();
    const event = state.events.find((e) => e.id === eventId && e.type === 'replication_prepared');
    if (!event || event.data.policyVersion !== 'free-watched-v1' || event.data.campaignId !== campaign.id || event.data.campaignDigest !== campaignInputDigest(campaign) || campaign.mintPriceWei !== 0n || campaign.feePolicy.kind !== 'free' || deps.fire.killSwitchOn()) throw new Error('AUTOMATION_AUTHORITY_INVALID');
    if (wallets && (!wallets.length || new Set(wallets.map((w) => w.toLowerCase())).size !== wallets.length || !Array.isArray(event.data.wallets) || wallets.some((wallet) => !(event.data.wallets as string[]).includes(wallet.toLowerCase()))) || maxFeeGwei !== undefined && (!Number.isFinite(maxFeeGwei) || maxFeeGwei > Number(event.data.maxFeeGwei))) throw new Error('AUTOMATION_REQUEST_SCOPE_INVALID');
    const score = [...state.events].reverse().find((e) => e.type.startsWith('opportunity_') && e.data.contract === campaign.contract.toLowerCase() && e.data.chainId === campaign.chainId);
    if (!score || !Number.isFinite(Number(score.data.score)) || Number(score.data.score) < 70 || Number(score.data.score) > 100 || score.data.blocked === true || Date.parse(String(score.data.expiresAt)) <= now().getTime() || !Number.isFinite(Date.parse(String(score.data.expiresAt)))) throw new Error('AUTOMATION_SIGNAL_STALE');
    await assertScore(score);
    const sourceEvent = state.events.find((e) => e.id === event.data.sourceEventId && e.type === 'watched_wallet_mint');
    if (!sourceEvent) throw new Error('WATCHED_MINT_NOT_VERIFIED');
    const qualified = await qualify(sourceEvent, (event.data.wallets as string[]).map((wallet) => wallet as Address));
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
        const decisions = new Set(events.filter(event => event.type === 'replication_decision').map(event => event.id));
        // Always use the newest score, including a downgrade or blocking risk.
        const scores = new Map<string, EventRecord>();
        for (const event of events) if (event.type.startsWith('opportunity_') && typeof event.data.contract === 'string') scores.set(`${event.data.chainId}:${event.data.contract}`, event);
        for (const score of [...scores.values()].slice(-20)) {
          const scoreAge = now().getTime() - Date.parse(score.at);
          if (!Number.isFinite(scoreAge) || scoreAge < 0 || scoreAge > 15 * 60_000 || score.data.blocked === true || typeof score.data.score !== 'number' || score.data.score < 70 || score.data.score > 100) continue;
          const source = [...events].reverse().find((e) => e.type === 'watched_wallet_mint' && e.data.chainId === score.data.chainId && e.data.contract === score.data.contract && deps.watchedWallets(Number(e.data.chainId)).some((wallet) => wallet.toLowerCase() === String(e.data.wallet).toLowerCase()));
          if (!source) { await explain(score, undefined, 'source', 'WATCHED_MINT_REQUIRED', decisions); continue; }
          const key = `replication_claim:${score.data.chainId}:${score.data.contract}`;
          if (claims.has(key)) continue;
          const retryKey = `${key}:${source.id}`;
          if ((retryAfter.get(retryKey) ?? 0) > now().getTime()) continue;
          retryAfter.set(retryKey, now().getTime() + 30_000);
          if (retryAfter.size > 256) retryAfter.delete(retryAfter.keys().next().value!);
          let claimed = false;
          try {
            const candidates = await deps.wallets();
            const qualified = await qualify(source, candidates);
            if (qualified.plan.verdict !== 'replicable') {
              await explain(score, source, 'qualification', qualified.plan.reasons[0]?.code ?? 'REPLICATION_NOT_QUALIFIED', decisions);
              continue;
            }
            await assertScore(score);
            const fundedPreparation=deps.autoFunding&&qualified.drop.mintPrice===0n?await deps.autoFunding.ensure(qualified,candidates,source,score):undefined;
            if(deps.autoFunding&&qualified.drop.mintPrice===0n&&!fundedPreparation)throw new Error('FUNDING_PENDING');
            // Funding may take minutes; re-read current source/own proof before consuming the claim.
            if(fundedPreparation){const current=await qualify(source,candidates);if(current.plan.verdict!=='replicable'||current.drop.mintPrice!==0n||current.drop.strategyName!==qualified.drop.strategyName)throw new Error('REPLICATION_CHANGED');}
            const wallets = fundedPreparation?[...new Set(fundedPreparation.flatMap(row=>row.wallets))] as Address[]:deps.fundedWallets ? await deps.fundedWallets(qualified, candidates) : candidates;
            if (!wallets.length) throw new Error('FUNDING_NOT_ARRIVED');
            if (wallets.some(wallet => !candidates.some(candidate => candidate.toLowerCase() === wallet.toLowerCase()))) throw new Error('REPLICATION_FUNDING_SCOPE_INVALID');
            await deps.assertSourceAuthority?.(qualified,wallets);
            await assertScore(score);
            // Persist before any campaign/request is created; crash recovery never repeats it.
            await deps.store.transaction((state) => { if (!state.events.some((e) => e.id === key)) { state.events.push({ id: key, type: 'replication_claim', at: now().toISOString(), data: { sourceEventId: source.id, scoreEventId: score.id, policyVersion: 'free-watched-v1' } }); claimed = true; } });
            if (!claimed) continue;
            claims.add(key);
            const preparedResult = fundedPreparation??await deps.prepare(qualified, wallets);
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
            const code = safeCode(error);
            await explain(score, source, claimed ? 'preparation' : 'qualification', code, decisions);
            if (claimed) await deps.notify(`Replication stopped: ${code}. Check /runs and /requests before retrying.`, `replication-blocked:${key}`).catch(() => undefined);
          }
        }
      } finally { busy = false; }
    },
  };
}
