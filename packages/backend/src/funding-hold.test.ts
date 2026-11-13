import { captureFundingCosts, fundingCostSummary } from './native-funding-analytics.js';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initializeMintFundingHolds, initializeNativeFundingRepository, NativeFundingRepository, FireScheduleRepository, type NativeFundingPolicy, type NativeFundingPreparation, type NativeFundingRequest } from '@mint-bot/database';
import { ETHEREUM, NOW, WALLET_ONE, WALLET_TWO, fixture, campaign, campaignInput, armed, close, OPEN_FLEET_POLICY, noopEngine } from './canonical-fixtures.js';
import type { Campaign, IntentRecord, RunRecord } from './types.js';
import { fundingCampaignDigest, type FundingHoldQualification, type FundingPendingHold } from './funding-hold.js';
import { ExecutionCoordinator } from './coordinator.js';
import { FundingCoordinatorService, type NativeFundingEnginePort } from './native-funding.js';
import { BackendApplication } from './application.js';
import { campaignInputDigest } from './evidence.js';

afterEach(() => vi.useRealTimers());
const at = new Date(NOW);
const expiresAt = new Date(at.getTime() + 600_000).toISOString();
const HUB = `0x${'4'.repeat(40)}`;
const DIGEST = `sha256:${'a'.repeat(64)}`;
const HASH = `0x${'b'.repeat(64)}`;
function proof(value: Campaign, wallets: readonly string[], kind: 'watched-free' | 'owner-paid' = 'watched-free'): FundingHoldQualification {
  return { kind, reference: 'source:verified', campaignDigest: fundingCampaignDigest(value), wallets, observedAt: NOW, expiresAt, score: 70, watchedSelfMintVerified: true, sourceMintedAt: NOW, sourceDepth: 2, ...(kind === 'owner-paid' ? { ownerApprovedIntentId: 'owner:paid-exact' } : {}) };
}
async function reserve(value: Awaited<ReturnType<typeof fixture>>, selected: Campaign, wallets = [WALLET_ONE], key = 'hold') {
  initializeMintFundingHolds(value.db); initializeNativeFundingRepository(value.db);
  return value.store.createFundingHold({ campaignId: selected.id, wallets, idempotencyKey: key, expiresAt }, proof(selected, wallets));
}
function armInput(hold: FundingPendingHold) {
  const run: RunRecord = { id: 'held-run', intentId: 'held-intent', campaignId: hold.campaign.id, mode: 'live', requestDigest: 'held-request', state: 'Armed', createdAt: NOW, updatedAt: NOW };
  const intent: IntentRecord = { id: run.intentId, runId: run.id, campaignId: hold.campaign.id, campaignSnapshot: hold.campaign, wallets: [...hold.wallets], policy: hold.campaign.spendPolicy, feePolicy: hold.campaign.feePolicy, chainVerification: hold.campaign.chainVerification, simulationIds: [], evidenceAt: NOW, createdAt: NOW };
  return { run, intent };
}
function nativePolicy(): NativeFundingPolicy {
  return { kind: 'native-fleet-topup-v1', active: true, chainId: 1, hub: HUB, recipients: [WALLET_ONE, WALLET_TWO], walletSetDigest: DIGEST, recordDigest: DIGEST, budgetProfileDigest: DIGEST, policyReference: 'turnkey:hub-only', expiresAt: '2099-01-01T00:00:00.000Z', maxTransferWei: 1000n, rollingPrincipalCapWei: 1000n, rollingFeeCapWei: 100n, maxTransferFeeWei: 100n, hubMaxBalanceWei: 10_000n, hubReserveWei: 0n, recipientMaxBalanceWei: 1000n, fleetMaxBalanceWei: 2000n, gasLimitMax: 2n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n };
}
function nativePreparation(): NativeFundingPreparation { return { hub: HUB, valueWei: 34n, recipientBalanceWei: 0n, fleetBalanceWei: 0n, hubBalanceWei: 1000n, gasLimit: 2n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, l1DataFeeBoundWei: 0n, operatorFeeBoundWei: 0n, nonce: 0, observedAt: NOW, blockNumber: 1n, blockHash: HASH, recipientCode: '0x' }; }

describe('canonical FundingPending mint holds', () => {
  it('reserves real cap exposure before arm/signing, keeps pending holds counted across midnight and never fabricates an Armed run', async () => {
    let now = new Date('2026-09-14T23:59:40.000Z');
    const value = await fixture(ETHEREUM, false, true, undefined, true, { ...OPEN_FLEET_POLICY, freeDailyCapWei: 34n }, () => now);
    try {
      const selected = await campaign(value, ETHEREUM);
      initializeMintFundingHolds(value.db); initializeNativeFundingRepository(value.db);
      const localProof = { ...proof(selected, [WALLET_ONE]), observedAt: now.toISOString(), sourceMintedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 600_000).toISOString() };
      const hold = await value.store.createFundingHold({ campaignId: selected.id, wallets: [WALLET_ONE], idempotencyKey: 'midnight', expiresAt: localProof.expiresAt }, localProof);
      expect(hold.state).toBe('FundingPending'); expect(value.store.snapshot().runs).toHaveLength(0); expect(value.store.snapshot().reservations).toHaveLength(0);
      now = new Date(now.getTime() + 30_000);
      const next = await armed(value, await campaign(value, ETHEREUM), [WALLET_TWO]);
      await expect(value.store.admitExecution(next.input)).rejects.toThrow('FLEET_DAILY_CAP_EXCEEDED');
      expect(value.store.fundingHold(hold.id)?.state).toBe('FundingPending');
    } finally { await close(value); }
  });

  it('counts held wallet exposure in normal admission and does not permit an unbound run to steal the same hold', async () => {
    const value = await fixture(ETHEREUM);
    try {
      const selected = await value.application.createCampaign({ ...campaignInput(ETHEREUM), dailyCapWei: 34n });
      const hold = await reserve(value, selected);
      const other = await armed(value, await value.application.createCampaign({ ...campaignInput(ETHEREUM), dailyCapWei: 34n }));
      await expect(value.store.admitExecution(other.input)).rejects.toThrow('DAILY_SPEND_CAP_EXCEEDED');
      const stealing = await armed(value, selected);
      await expect(value.store.admitExecution(stealing.input)).rejects.toThrow('FUNDING_HOLD_REQUIRES_BOUND_RUN');
      expect(value.store.fundingHold(hold.id)?.state).toBe('FundingPending');
    } finally { await close(value); }
  });

  it('atomically converts the exact complete held fleet into normal reservations without double-counting its cap', async () => {
    const value = await fixture(ETHEREUM, false, true, undefined, true, { ...OPEN_FLEET_POLICY, freeDailyCapWei: 68n });
    try {
      const selected = await value.application.createCampaign({ ...campaignInput(ETHEREUM), maxRunWei: 68n, dailyCapWei: 34n });
      const hold = await reserve(value, selected, [WALLET_ONE, WALLET_TWO]);
      const input = armInput(hold);
      await value.store.armFundingHold(hold.id, input.run, input.intent);
      const run = value.store.snapshot().runs.find(row => row.id === input.run.id)!;
      const admission = await value.store.admitExecution({ run, intent: input.intent, campaign: selected, wallets: hold.wallets });
      expect(admission.reservations.map(row => row.amountWei)).toEqual([34n, 34n]);
      expect(value.store.fundingHold(hold.id)?.state).toBe('Converted');
      expect(value.db.prepare("SELECT count(*) AS count FROM mint_funding_hold WHERE state='reserved'").get()).toEqual({ count: 0 });
      expect(value.store.snapshot().reservations.reduce((sum, row) => sum + row.amountWei, 0n)).toBe(68n);
    } finally { await close(value); }
  });

  it('rolls back every conversion and reservation if a later wallet fails', async () => {
    const value = await fixture(ETHEREUM);
    try {
      const selected = await campaign(value, ETHEREUM); const hold = await reserve(value, selected, [WALLET_ONE, WALLET_TWO]);
      const input = armInput(hold); await value.store.armFundingHold(hold.id, input.run, input.intent);
      value.db.exec("CREATE TRIGGER native_hold_test_failure BEFORE INSERT ON spend_reservation WHEN (SELECT count(*) FROM spend_reservation)>0 BEGIN SELECT RAISE(ABORT,'TEST_SECOND_WALLET_FAILURE'); END");
      const run = value.store.snapshot().runs.find(row => row.id === input.run.id)!;
      await expect(value.store.admitExecution({ run, intent: input.intent, campaign: selected, wallets: hold.wallets })).rejects.toThrow('TEST_SECOND_WALLET_FAILURE');
      expect(value.store.snapshot().reservations).toHaveLength(0);
      expect(value.store.fundingHold(hold.id)?.state).toBe('FundingPending');
    } finally { await close(value); }
  });

  it('requires free watched qualification or an exact paid owner intent and rejects changed snapshots/replay', async () => {
    const value = await fixture(ETHEREUM, true);
    try {
      const created = await campaign(value, ETHEREUM, true);
      const selected = value.store.snapshot().campaigns.find(row => row.id === created.id)!;
      initializeMintFundingHolds(value.db); initializeNativeFundingRepository(value.db);
      const input = { campaignId: selected.id, wallets: [WALLET_ONE], idempotencyKey: 'paid', expiresAt };
      await expect(value.store.createFundingHold(input, proof(selected, input.wallets))).rejects.toThrow('PAID_OWNER_INTENT_REQUIRED');
      const hold = await value.store.createFundingHold(input, proof(selected, input.wallets, 'owner-paid'));
      expect(hold.requiredPerWalletWei).toBe(134n);
      await expect(value.store.createFundingHold({ ...input, wallets: [WALLET_TWO] }, proof(selected, [WALLET_TWO], 'owner-paid'))).rejects.toThrow('IDEMPOTENCY_KEY_CONFLICT');
    } finally { await close(value); }
  });

  it('keeps both the mint hold and funding reservation when broadcast is unknown, blocking arm/cancel/kill-release', async () => {
    const value = await fixture(ETHEREUM);
    try {
      const selected = await campaign(value, ETHEREUM); const hold = await reserve(value, selected);
      const repo = new NativeFundingRepository(value.db, { assertCurrent: (request, policy, prep) => value.store.assertFundingParent(request, policy, prep) });
      const request: NativeFundingRequest = { id: 'fund:one', idempotencyKey: 'fund:one', parentRunId: hold.id, parentHoldId: hold.id, parentHoldDigest: hold.digest, chainId: 1, recipient: WALLET_ONE, requiredBalanceWei: 34n, expiresAt };
      repo.admit(request, nativePreparation(), nativePolicy(), at); repo.claimForSigning(request.id, at); repo.markSigned(request.id, HASH, at); repo.markBroadcasting(request.id, at);
      const input = armInput(hold);
      await expect(value.store.armFundingHold(hold.id, input.run, input.intent)).rejects.toThrow('FUNDING_OUTCOME_UNRESOLVED');
      await expect(value.store.releaseFundingHold(hold.id)).rejects.toThrow('FUNDING_OUTCOME_UNRESOLVED');
      await expect(value.store.releaseKillSwitch('owner', 'test')).rejects.toThrow('KILL_RELEASE_BLOCKED');
      expect(value.store.fundingHold(hold.id)?.state).toBe('FundingPending');
      expect(repo.get(request.id)?.state).toBe('unknown');
    } finally { await close(value); }
  });

  it('releases only an unstarted mint hold after funding is settled or proven unstarted', async () => {
    const value = await fixture(ETHEREUM);
    try {
      const selected = await campaign(value, ETHEREUM); const hold = await reserve(value, selected);
      const repo = new NativeFundingRepository(value.db, { assertCurrent: (request, policy, prep) => value.store.assertFundingParent(request, policy, prep) });
      repo.admit({ id: 'fund:one', idempotencyKey: 'fund:one', parentRunId: hold.id, parentHoldId: hold.id, parentHoldDigest: hold.digest, chainId: 1, recipient: WALLET_ONE, requiredBalanceWei: 34n, expiresAt }, nativePreparation(), nativePolicy(), at);
      await value.store.releaseFundingHold(hold.id);
      expect(repo.get('fund:one')?.state).toBe('released');
      expect(value.store.fundingExpenseSnapshot()).toEqual([expect.objectContaining({status:'known',feeWei:0n,principalWei:0n})]);
      expect(() => repo.reconfirm('fund:one', at)).toThrow();
      expect(() => repo.claimForSigning('fund:one', at)).toThrow();
      expect(value.store.fundingHold(hold.id)?.state).toBe('Released');
    } finally { await close(value); }
  });

  it('applies the existing admission-clock watermark and global stale-pending blocker to holds', async () => {
    let now = new Date(NOW);
    const value = await fixture(ETHEREUM, false, true, undefined, true, OPEN_FLEET_POLICY, () => now);
    try {
      const selected = await campaign(value, ETHEREUM); await reserve(value, selected);
      now = new Date(at.getTime() + 86_400_001);
      const next = await armed(value, await campaign(value, ETHEREUM), [WALLET_TWO]);
      await expect(value.store.admitExecution(next.input)).rejects.toThrow('STALE_PENDING_RESERVATION');
      now = new Date(at.getTime() - 10_000);
      await expect(value.store.admitExecution(next.input)).rejects.toThrow('ADMISSION_CLOCK_ROLLBACK');
    } finally { await close(value); }
  });

  it('composes application fund prepare/execute through the coordinator and real canonical parent authority', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(at);
    const value = await fixture(ETHEREUM);
    try {
      initializeMintFundingHolds(value.db); initializeNativeFundingRepository(value.db);
      const selected = await campaign(value, ETHEREUM);
      await value.store.transaction(state => { state.runtime.startupState = 'Ready'; state.runtime.dependencies = { engine: true, chain: true, backup: true, notifications: true }; });
      const repo = new NativeFundingRepository(value.db, { assertCurrent: (request, policy, prep) => value.store.assertFundingParent(request, policy, prep) });
      const engine: NativeFundingEnginePort = { prepare: async () => nativePreparation(), execute: vi.fn(async (_record, hooks) => { await hooks.assertCurrent(); await hooks.claimForSigning(); await hooks.persistSigned(HASH); await hooks.markBroadcasting(); await hooks.markSubmitted(HASH); return { hash: HASH }; }) };
      const service = new FundingCoordinatorService({ repository: repo, policy: nativePolicy, assertReady: async () => undefined, engine, receipts: async () => [], now: () => at });
      const coordinator = new ExecutionCoordinator(value.store, noopEngine, { funding: { service, qualify: async (campaign, wallets) => proof(campaign, wallets), assertReady: async () => undefined } });
      const app = new BackendApplication(value.store, coordinator);
      const pending = await app.command<FundingPendingHold>('fund', { action: 'prepare', campaignId: selected.id, wallets: [WALLET_ONE], idempotencyKey: 'application', expiresAt });
      expect(pending.state).toBe('FundingPending'); expect(value.store.snapshot().runs).toHaveLength(0);
      const result = await app.command('fund', { action: 'execute', holdId: pending.id });
      expect(result.state).toBe('FundingPending'); expect(engine.execute).toHaveBeenCalledOnce();
      expect(value.store.unresolvedFundingHoldIds()).toEqual([pending.id]);
    } finally { await close(value); }
  });

  it('keeps the ordinary funded-readiness and simulation gates before an actual held arm', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(at);
    const value = await fixture(ETHEREUM);
    try {
      initializeMintFundingHolds(value.db); initializeNativeFundingRepository(value.db);
      const created = await campaign(value, ETHEREUM);
      const selected = value.store.snapshot().campaigns.find(row => row.id === created.id)!;
      await value.store.transaction(state => {
        state.runtime = { startupState: 'Ready', blockingReasons: [], dependencies: { engine: true, chain: true, backup: true, notifications: true }, operational: { secretStoreReference: 'TEST_OPERATOR', storePath: 'state.sqlite', signerReady: true, custody: { provider: 'turnkey', providerIdentity: 'turnkey-test-org', policyReference: 'turnkey-test-policy', policyDigest: `0x${'1'.repeat(64)}`, policyStatus: 'approved', healthStatus: 'healthy', attestationStatus: 'verified', evidenceId: 'custody-evidence-1', observedAt: NOW, expiresAt: '2099-01-01T00:00:00.000Z' }, killSwitchEngaged: false, notificationReady: true, chainVerification: 'verified', lastReconciliationAt: NOW, observedAt: NOW, expiresAt: '2099-01-01T00:00:00.000Z' } };
      });
      const repo = new NativeFundingRepository(value.db, { assertCurrent: (request, policy, prep) => value.store.assertFundingParent(request, policy, prep) });
      const service = new FundingCoordinatorService({ repository: repo, policy: nativePolicy, assertReady: async () => undefined, engine: { prepare: async () => nativePreparation(), execute: async () => { throw new Error('UNEXPECTED_SIGN'); } }, receipts: async () => [], now: () => at });
      let funded = false;
      const coordinator = new ExecutionCoordinator(value.store, noopEngine, { funding: { service, qualify: async (campaign, wallets) => proof(campaign, wallets), assertReady: async () => undefined }, refreshReadiness: async () => { if (!funded) throw new Error('FUNDING_NOT_ARRIVED'); } });
      const hold = await coordinator.prepareFunding({ campaignId: selected.id, wallets: [WALLET_ONE], idempotencyKey: 'arm-gates', expiresAt });
      const validated = { campaign: selected, wallets: [WALLET_ONE], simulationIds: ['funded-simulation'], evidenceAt: NOW };
      await expect(coordinator.arm(validated, 'live', 'held-arm', hold.id)).rejects.toThrow('FUNDING_NOT_ARRIVED');
      expect(value.store.snapshot().runs).toHaveLength(0);
      funded = true;
      await expect(coordinator.arm(validated, 'live', 'held-arm', hold.id)).rejects.toThrow('WALLET_SIMULATION_NOT_FOUND');
      await value.store.transaction(state => { state.simulations.push({ id: 'funded-simulation', campaignId: selected.id, wallet: WALLET_ONE, inputDigest: campaignInputDigest(selected), success: true, sourceBlock: 1n, sourceBlockHash: '0xblock', checkedAt: NOW, expiresAt, worstCaseFeeWei: 34n }); });
      const run = await coordinator.arm(validated, 'live', 'held-arm', hold.id);
      expect(run.state).toBe('Armed'); expect(value.store.fundingHold(hold.id)?.boundRunId).toBe(run.id);
      const persisted = value.store.snapshot();
      await value.store.admitExecution({ run: persisted.runs.find(row => row.id === run.id)!, intent: persisted.intents.find(row => row.runId === run.id)!, campaign: selected, wallets: [WALLET_ONE] });
      expect(value.store.fundingHold(hold.id)?.state).toBe('Converted');
    } finally { await close(value); }
  });
});

it('resumes one underfunded discovery through finality, fresh simulation and the actual live-request arm path',async()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(at);const value=await fixture(ETHEREUM,false,true,'2099-01-01T00:00:00Z',true,OPEN_FLEET_POLICY,()=>new Date());
 try{
  const fee=400000000000000n;initializeMintFundingHolds(value.db);initializeNativeFundingRepository(value.db);
  value.db.prepare('UPDATE fee_policy SET max_total_fee_wei=?,free_mint_total_fee_cap_wei=?,free_mint_priority_fee_component_wei=?').run(fee.toString(),fee.toString(),'100000000');
  const selected=await new BackendApplication(value.store,new ExecutionCoordinator(value.store,noopEngine),{fleetPolicy:{...OPEN_FLEET_POLICY,freeFeeAllowanceWei:fee}}).createCampaign({...campaignInput(ETHEREUM),maxRunWei:fee,dailyCapWei:fee,gasCeilingWei:fee,feePolicy:{kind:'free',configuredPriorityFeeWei:100000000n,freeTotalSpendCapWei:fee,l2ExecutionGasBudgetWei:fee-100000000n,l1DataGasBudgetWei:0n,totalFeeBudgetWei:fee}});
  for(const address of [WALLET_ONE,WALLET_TWO]){value.db.prepare('INSERT INTO wallet(id,chain_profile_id,address,key_reference,created_at) VALUES(?,?,?,?,?)').run(`w-${address}`,`profile-1`,address,'test-key',NOW);value.db.prepare('INSERT INTO campaign_wallet(campaign_id,wallet_id,enabled,selected_at) VALUES(?,?,1,?)').run(selected.id,`w-${address}`,NOW);}
  await value.store.transaction(state=>{state.runtime={startupState:'Ready',blockingReasons:[],dependencies:{engine:true,chain:true,backup:true,notifications:true},operational:{secretStoreReference:'TEST_OPERATOR',storePath:'state.sqlite',signerReady:true,custody:{provider:'turnkey',providerIdentity:'turnkey-test-org',policyReference:'turnkey-test-policy',policyDigest:`0x${'1'.repeat(64)}`,policyStatus:'approved',healthStatus:'healthy',attestationStatus:'verified',evidenceId:'custody-evidence-1',observedAt:NOW,expiresAt:'2099-01-01T00:00:00Z'},killSwitchEngaged:false,notificationReady:true,chainVerification:'verified',lastReconciliationAt:NOW,observedAt:NOW,expiresAt:'2099-01-01T00:00:00Z'}};});
  const policy=()=>({...nativePolicy(),maxTransferWei:4100000000000000n,rollingPrincipalCapWei:8500000000000000n,rollingFeeCapWei:200000000000000n,maxTransferFeeWei:20000000000000n,hubMaxBalanceWei:8700000000000000n,recipientMaxBalanceWei:4100000000000000n,fleetMaxBalanceWei:8500000000000000n,gasLimitMax:21000n,maxFeePerGas:200000000n,maxPriorityFeePerGas:100000000n});
  let finalized=false;let funded=false;let signs=0;const repository=value.store.createNativeFundingRepository(policy);
  const service=new FundingCoordinatorService({repository,policy,now:()=>new Date(),assertReady:async()=>undefined,engine:{prepare:async()=>({...nativePreparation(),valueWei:fee,gasLimit:21000n,maxFeePerGas:200000000n,maxPriorityFeePerGas:100000000n,hubBalanceWei:8000000000000000n,observedAt:new Date().toISOString()}),execute:async(_record,hooks)=>{await hooks.assertCurrent();await hooks.claimForSigning();signs++;await hooks.persistSigned(HASH);await hooks.markBroadcasting();await hooks.markSubmitted(HASH);return {hash:HASH};}},receipts:async _record=>finalized?['first.example','second.example'].map(readerHost=>({readerHost,observedAt:new Date().toISOString(),chainId:1,transactionHash:HASH,from:HUB,to:WALLET_ONE,valueWei:fee,data:'0x',nonce:0,blockNumber:1n,blockHash:HASH,gasUsed:21000n,effectiveGasPrice:200000000n,l1DataFeeWei:0n,operatorFeeWei:0n,success:true,finalityStage:'ethereum_final',finalityEvidenceReference:'test:independently-final'})):[]});
  const coordinator=new ExecutionCoordinator(value.store,noopEngine,{funding:{service,assertReady:async()=>undefined,qualify:async(campaign,wallets)=>({...proof(campaign,wallets),observedAt:new Date().toISOString(),expiresAt:new Date(at.getTime()+15*60000).toISOString()})},refreshReadiness:async()=>{if(!funded)throw new Error('FUNDING_NOT_ARRIVED');}});const application=new BackendApplication(value.store,coordinator);
  const {createReplicationAutomation}=await import(new URL('../../cli/dist/replication-automation.js',import.meta.url).href);
  const {createReplicationAutoFunding}=await import(new URL('../../cli/dist/replication-prepare.js',import.meta.url).href);
  const {createFireWiring}=await import(new URL('../../cli/dist/fire-wiring.js',import.meta.url).href);
  const {processLiveRunRequests}=await import(new URL('../../cli/dist/live-request.js',import.meta.url).href);
  const {buildReplicationPlan,buildSeaDropPublicMintCalldata,SEADROP_V1_ADDRESS}=await import(new URL('../../engine/dist/index.js',import.meta.url).href);
  const drop={chainId:1,nftContract:selected.contract,feePayer:WALLET_TWO,strategyName:selected.strategy,mintPrice:0n,maxTotalMintableByWallet:10,maxTokenSupply:100n,totalMinted:0n,startTime:Math.floor(at.getTime()/1000)-60,endTime:Math.floor(at.getTime()/1000)+3600};
  const observed={chainId:1,hash:`0x${'a'.repeat(64)}`,from:WALLET_TWO,to:SEADROP_V1_ADDRESS,data:buildSeaDropPublicMintCalldata(selected.contract,WALLET_TWO,1),value:0n,blockNumber:1n,observedAt:NOW};const qualified={drop,observed,mintedAt:NOW,plan:buildReplicationPlan({drop,observed,targetWallets:[WALLET_ONE]})};
  const port={chainId:1,hasCode:async()=>true,readDrop:async()=>({nftContract:selected.contract,priceWei:0n,startTime:drop.startTime,endTime:drop.endTime,maxPerWallet:10,maxSupply:100n,totalMinted:0n}),balance:async()=>funded?fee:0n,simulateMint:async()=>({outcome:'pass'})};
  const fire=createFireWiring({mode:'host',store:value.store,approve:(validated:never)=>application.command('approve',{validated}),killSwitchPath:join(value.directory,'absent-kill'),fireSchedules:()=>new FireScheduleRepository(value.db,()=>new Date()),unclaimedRequests:()=>value.store.unclaimedLiveRunRequests(),startedRequests:()=>[],walletList:async()=>[WALLET_ONE],evmPort:async()=>port,evmLatestBlock:async()=>({number:1n,hash:'0xblock'}),robinhoodDryRun:async()=>{throw new Error('unused');},robinhoodLatestBlock:async()=>({number:1n,hash:'0xblock'}),balanceOf:async()=>funded?fee:0n,kick:()=>undefined,now:()=>new Date(),assertUnattendedReady:async()=>undefined});
  const prepare=vi.fn(async()=>({campaign:selected,wallets:[WALLET_ONE],maxFeeGwei:0.2}));const qualify=vi.fn(async()=>qualified);const autoFunding=createReplicationAutoFunding({store:value.store,coordinator,prepare,funded:async()=>funded?[WALLET_ONE]:[],now:()=>new Date()});
  const source={id:'watched-source',type:'watched_wallet_mint',at:NOW,data:{chainId:1,contract:selected.contract,wallet:WALLET_TWO,txHash:observed.hash}};await value.store.transaction(state=>state.events.push(source,{id:'score-70',type:'opportunity_scored',at:NOW,data:{chainId:1,contract:selected.contract,score:70,expiresAt:new Date(at.getTime()+15*60000).toISOString(),blocked:false}}));
  const deps={store:value.store,watchedWallets:()=>[WALLET_TWO],wallets:async()=>[WALLET_ONE],qualify,prepare,autoFunding,fire:fire.fireDeps,fireAutonomous:fire.fireAutonomous,assertUnattendedReady:async()=>undefined,notify:async()=>undefined,now:()=>new Date()};
  await createReplicationAutomation(deps).tick();expect(signs).toBe(1);expect(value.store.snapshot().events.some(event=>event.type==='replication_claim')).toBe(false);expect(value.store.snapshot().runs).toHaveLength(0);expect(value.store.snapshot().simulations).toHaveLength(0);
  finalized=true;funded=true;vi.setSystemTime(new Date(at.getTime()+31000));const resumed=createReplicationAutomation(deps);await resumed.tick();expect(prepare).toHaveBeenCalledOnce();expect(signs).toBe(1);expect(value.store.snapshot().events.filter(event=>event.type==='replication_claim')).toHaveLength(1);expect(value.store.unclaimedLiveRunRequests(),JSON.stringify(value.store.snapshot().events.filter(event=>event.type==='replication_decision').map(event=>event.data))).toHaveLength(1);
  const outcomes:unknown[]=[];await processLiveRunRequests({unclaimed:()=>value.store.unclaimedLiveRunRequests(),claim:(id:string,outcome:'started'|'expired')=>value.store.claimLiveRunRequest(id,outcome),campaign:(id:string)=>value.store.snapshot().campaigns.find(row=>row.id===id),command:(name:'arm'|'run',input:Record<string,unknown>)=>application.command(name,input),setFeeCeiling:()=>undefined,record:async(event:unknown)=>{outcomes.push(event);},now:()=>new Date(),assertUnattendedReady:async()=>undefined,assertAutomationReady:resumed.assertReady});
  expect(value.db.prepare("SELECT count(*) AS total FROM mint_funding_hold WHERE state='converted'").get()).toEqual({total:1});expect(value.store.snapshot().runs).toHaveLength(1);expect(signs).toBe(1);expect(outcomes).toHaveLength(1);
 }finally{await close(value);vi.useRealTimers();}
},20000);

it.each(['reserved','signing'] as const)('expires only positively unstarted funding holds while retaining %s ambiguity',async state=>{
 let clock=at;const value=await fixture(ETHEREUM,false,true,'2099-01-01T00:00:00Z',true,OPEN_FLEET_POLICY,()=>clock);try{
 const selected=await campaign(value,ETHEREUM);const hold=await reserve(value,selected);const repository=value.store.createNativeFundingRepository(nativePolicy);const request:NativeFundingRequest={id:'fund:expiry',idempotencyKey:'fund:expiry',parentRunId:hold.id,parentHoldId:hold.id,parentHoldDigest:hold.digest,chainId:1,recipient:WALLET_ONE,requiredBalanceWei:34n,expiresAt};repository.admit(request,nativePreparation(),nativePolicy(),clock);if(state==='signing')repository.claimForSigning(request.id,clock);clock=new Date(at.getTime()+11*60000);expect(value.store.expiredFundingHoldIds(clock)).toContain(hold.id);
 if(state==='reserved'){await value.store.releaseFundingHold(hold.id);expect(value.store.fundingHold(hold.id)?.state).toBe('Released');expect(repository.get(request.id)?.state).toBe('released');expect(()=>repository.claimForSigning(request.id,clock)).toThrow();}else{await expect(value.store.releaseFundingHold(hold.id)).rejects.toThrow('FUNDING_OUTCOME_UNRESOLVED');expect(repository.get(request.id)?.state).toBe('signing');expect(value.store.fundingHold(hold.id)?.state).toBe('FundingPending');}
 }finally{await close(value);}
});


describe('readonly canonical funding cost accounting', () => {
  it.each([true,false])('uses actual independent final receipts and keeps no-NFT funding expense separate (transfer success=%s)', async success => {
    const value=await fixture(ETHEREUM);
    try {
      const selected=await campaign(value,ETHEREUM); const hold=await reserve(value,selected);
      expect(value.store.fundingFeeForRunWallet('unfunded-run',WALLET_ONE)).toMatchObject({status:'known',feeWei:0n});
      const repo=new NativeFundingRepository(value.db,{assertCurrent:(request,policy,prep)=>value.store.assertFundingParent(request,policy,prep)});
      const request:NativeFundingRequest={id:'cost:one',idempotencyKey:'cost:one',parentRunId:hold.id,parentHoldId:hold.id,parentHoldDigest:hold.digest,chainId:1,recipient:WALLET_ONE,requiredBalanceWei:34n,expiresAt};
      repo.admit(request,nativePreparation(),nativePolicy(),at);repo.claimForSigning(request.id,at);repo.markSigned(request.id,HASH,at);repo.markBroadcasting(request.id,at);
      await captureFundingCosts(value.store);
      expect(fundingCostSummary(value.store.eventSnapshot())).toMatchObject({unknownOperations:1,gasExpenseWei:0n});
      const receipt={readerHost:'first.example',observedAt:NOW,chainId:1,transactionHash:HASH,from:HUB,to:WALLET_ONE,valueWei:34n,data:'0x' as const,nonce:0,blockNumber:1n,blockHash:HASH,gasUsed:2n,effectiveGasPrice:1n,l1DataFeeWei:0n,operatorFeeWei:0n,success,finalityStage:'ethereum_final' as const,finalityEvidenceReference:'final:one'};
      repo.settle(request.id,[receipt,{...receipt,readerHost:'second.example',finalityEvidenceReference:'final:two'}],at);
      await captureFundingCosts(value.store);await captureFundingCosts(value.store);
      expect(value.store.eventSnapshot().filter(row=>row.type==='analytics_funding_cost')).toHaveLength(2);
      expect(fundingCostSummary(value.store.eventSnapshot())).toMatchObject({principalWei:success?34n:0n,gasExpenseWei:2n,allocatedGasWei:0n,unallocatedGasWei:2n,unknownOperations:0,principalIsExpense:false});
      if (!success) { expect(value.store.snapshot().attempts).toHaveLength(0); return; }
      const input=armInput(hold);await value.store.armFundingHold(hold.id,input.run,input.intent);
      expect(value.store.fundingFeeForRunWallet(input.run.id,WALLET_ONE)).toMatchObject({status:'known',feeWei:2n,principalWei:34n});
      await captureFundingCosts(value.store);
      expect(fundingCostSummary(value.store.eventSnapshot(),[{runId:input.run.id,wallet:WALLET_ONE,status:'known',feeWei:'2'},{runId:input.run.id,wallet:WALLET_ONE,status:'known',feeWei:'2'}])).toMatchObject({gasExpenseWei:2n,allocatedGasWei:2n,unallocatedGasWei:0n});
      repo.reopenAfterReorg(request.id,[{readerHost:'first.example',observedAt:NOW,chainId:1,blockNumber:1n,blockHash:`0x${'c'.repeat(64)}`},{readerHost:'second.example',observedAt:NOW,chainId:1,blockNumber:1n,blockHash:`0x${'c'.repeat(64)}`}],at);
      expect(value.store.fundingFeeForRunWallet(input.run.id,WALLET_ONE).status).toBe('unknown');
      await captureFundingCosts(value.store);expect(fundingCostSummary(value.store.eventSnapshot()).unknownOperations).toBe(1);
    } finally {await close(value);}
  });
});
