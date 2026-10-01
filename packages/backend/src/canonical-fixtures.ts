import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase, type SqliteDatabase } from '@mint-bot/database';
import { BackendApplication } from './application.js';
import { CanonicalStoreBridge, type CanonicalAdmissionInput } from './canonical-store.js';
import { ExecutionCoordinator } from './coordinator.js';
import type { Campaign, EngineAdapter, FeePolicy, IntentRecord, RunRecord } from './types.js';
import type { FleetSpendPolicy } from './fleet-policy.js';

/** Shared setup for the canonical-store tests (extracted so the multi-process admission test can reuse it). */
export const ETHEREUM = 1 as const;
export const ROBINHOOD = 4663 as const;
export const NOW = '2026-09-14T14:00:00.000Z';
export const WALLET_ONE = '0x1111111111111111111111111111111111111111';
export const WALLET_TWO = '0x2222222222222222222222222222222222222222';
export const CONTRACT = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

export const noopEngine: EngineAdapter = {
  prepare: async () => ({ executionIds: [], attempts: [], receipts: [], state: 'Prepared' }),
  execute: async () => ({ executionIds: [], attempts: [], receipts: [], state: 'Confirmed' }),
  reconcile: async () => ({ result: 'unknown', attempts: [], receipts: [] }),
};

export interface Fixture {
  directory: string;
  db: SqliteDatabase;
  store: CanonicalStoreBridge;
  application: BackendApplication;
}

/** Generous limits so pre-existing tests exercise only the per-run and per-wallet caps. */
export const OPEN_FLEET_POLICY: FleetSpendPolicy = { freeDailyCapWei: 10n ** 18n, paidDailyCapWei: 10n ** 18n, paidHeadroomAlertWei: 10n ** 18n, paidMaxPricePerNftWei: 10n ** 18n, paidMaxWalletsPerMint: 50, freeFeeAllowanceWei: 10n ** 18n, paidFeeAllowanceWei: 10n ** 18n };

export async function fixture(chainId: typeof ETHEREUM | typeof ROBINHOOD, paid = false, executionEnabled = true, evidenceExpiresAt = '2099-01-01T00:00:00.000Z', includeVerification = true, fleetPolicy: FleetSpendPolicy | null = OPEN_FLEET_POLICY): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'mint-backend-'));
  const db = openDatabase(join(directory, 'state.sqlite'));
  const profileId = `profile-${chainId}`;
  db.prepare('INSERT INTO chain_profile (id, chain_id, name, rpc_endpoints_json, confirmation_depth, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(profileId, chainId, chainId === ETHEREUM ? 'Ethereum' : 'Robinhood', '[]', 2, NOW);
  const verificationStatus = chainId === ROBINHOOD ? 'execution_blocked' : 'verified';
  const verificationEvidence = JSON.stringify({ seaDropCompatible: true, positiveLivePath: true, archiveForkPassed: true, reconciliationPassed: true, finalityPassed: true, endpointIdentity: chainId === ROBINHOOD ? 'RH_SEQUENCER_REFERENCE' : 'ETH_FEED_REFERENCE', sourceBlock: 1, sourceBlockHash: '0xblock', expiresAt: evidenceExpiresAt, acceptedAt: NOW, acceptedBy: 'test-operator', approvalProof: 'test-proof', strategyVersion: 'seadrop-v1-public@1' });
  if (includeVerification) db.prepare('INSERT INTO chain_verification (id, chain_profile_id, status, chain_id, sequencer_endpoint_reference, archive_endpoint_reference, feed_endpoint_reference, evidence_json, checked_at, approved_by, approved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(`verification-${chainId}`, profileId, chainId === ROBINHOOD ? 'execution_blocked' : 'verified', chainId, chainId === ROBINHOOD ? 'RH_SEQUENCER_REFERENCE' : null, chainId === ROBINHOOD ? 'RH_ARCHIVE_REFERENCE' : 'ETH_ARCHIVE_REFERENCE', chainId === ETHEREUM ? 'ETH_FEED_REFERENCE' : null, JSON.stringify({ seaDropCompatible: true, positiveLivePath: true, archiveForkPassed: true, reconciliationPassed: true, finalityPassed: true, endpointIdentity: chainId === ROBINHOOD ? 'RH_SEQUENCER_REFERENCE' : 'ETH_FEED_REFERENCE', sourceBlock: 1, sourceBlockHash: '0xblock', expiresAt: evidenceExpiresAt, acceptedAt: NOW, acceptedBy: 'test-operator', approvalProof: 'test-proof', strategyVersion: 'seadrop-v1-public@1' }), NOW, 'test-operator', NOW);
  db.prepare('UPDATE chain_profile SET execution_enabled = ?, verification_status = ?, verification_evidence_json = ?, verification_approved_by = ?, verification_approved_at = ? WHERE id = ?').run(includeVerification && chainId === ETHEREUM && executionEnabled ? 1 : 0, includeVerification ? verificationStatus : 'unverified', includeVerification ? verificationEvidence : null, includeVerification ? 'test-operator' : null, includeVerification ? NOW : null, profileId);
  db.prepare('INSERT INTO fee_policy (id, chain_profile_id, version, priority_fee_semantics, max_total_fee_wei, free_mint_total_fee_cap_wei, free_mint_priority_fee_component_wei, free_mint_priority_fee_multiplier, paid_mints_enabled, active, created_at, zero_priority_fee_policy) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(`fee-${chainId}`, profileId, `test-${chainId}-${paid ? 'paid' : 'free'}`, chainId === ETHEREUM ? 'ordering' : 'fee_only', '34', '40', '20', 2, paid ? 1 : 0, 1, NOW, 'allowed');
  const store = new CanonicalStoreBridge(db, { now: () => new Date(NOW), ...(fleetPolicy ? { fleetPolicy } : {}) });
  await store.open();
  return { directory, db, store, application: new BackendApplication(store, new ExecutionCoordinator(store, noopEngine)) };
}

export async function close(fixtureValue: Fixture): Promise<void> {
  fixtureValue.store.close();
  await rm(fixtureValue.directory, { recursive: true, force: true });
}

export function campaignInput(chainId: typeof ETHEREUM | typeof ROBINHOOD, paid = false) {
  const fee: FeePolicy = paid ? { kind: 'paid', configuredPriorityFeeWei: 20n, l2ExecutionGasBudgetWei: 10n, l1DataGasBudgetWei: 4n, totalFeeBudgetWei: 34n } : { kind: 'free', configuredPriorityFeeWei: 20n, freeTotalSpendCapWei: 40n, l2ExecutionGasBudgetWei: 10n, l1DataGasBudgetWei: 4n, totalFeeBudgetWei: 34n };
  return { chainId, contract: CONTRACT, strategy: 'seadrop-v1-public', quantity: 1, dryRun: false, maxRunWei: 1_000n, dailyCapWei: 1_000n, gasCeilingWei: 100n, broadcastMode: chainId === ETHEREUM ? 'public' as const : 'sequencer' as const, chainVerification: { chainId, status: 'verified' as const, seaDropCompatible: true, evidenceId: `verification-${chainId}`, checkedAt: NOW, sourceBlock: 1n, endpointReference: chainId === ETHEREUM ? 'ETH_FEED_REFERENCE' : 'RH_SEQUENCER_REFERENCE' }, mintPriceWei: paid ? 100n : 0n, feePolicy: fee };
}

export async function campaign(fixtureValue: Fixture, chainId: typeof ETHEREUM | typeof ROBINHOOD, paid = false): Promise<Campaign> {
  const campaignValue = await fixtureValue.application.createCampaign(campaignInput(chainId, paid));
  for (const [index, address] of [WALLET_ONE, WALLET_TWO].entries()) {
    const walletId = `wallet-${chainId}-${index}`;
    fixtureValue.db.prepare('INSERT OR IGNORE INTO wallet (id, chain_profile_id, address, key_reference, created_at) VALUES (?, ?, ?, ?, ?)').run(walletId, `profile-${chainId}`, address, `test-key-${index}`, NOW);
    fixtureValue.db.prepare('INSERT OR IGNORE INTO campaign_wallet (campaign_id, wallet_id, enabled, selected_at) VALUES (?, ?, 1, ?)').run(campaignValue.id, walletId, NOW);
  }
  return campaignValue;
}

export async function armed(fixtureValue: Fixture, campaignValue: Campaign, wallets: readonly string[] = [WALLET_ONE], simulationIds: readonly string[] = [], runSuffix = ''): Promise<{ run: RunRecord; intent: IntentRecord; input: CanonicalAdmissionInput }> {
  const run: RunRecord = { id: `run-${campaignValue.id}${runSuffix}`, intentId: `intent-${campaignValue.id}${runSuffix}`, campaignId: campaignValue.id, mode: 'live', requestDigest: `fingerprint-${campaignValue.id}`, state: 'Armed', createdAt: NOW, updatedAt: NOW };
  const intent: IntentRecord = { id: run.intentId, runId: run.id, campaignId: campaignValue.id, campaignSnapshot: structuredClone(campaignValue), wallets: [...wallets], policy: structuredClone(campaignValue.spendPolicy), feePolicy: structuredClone(campaignValue.feePolicy), chainVerification: structuredClone(campaignValue.chainVerification), simulationIds: [...simulationIds], evidenceAt: NOW, createdAt: NOW };
  for (const [index, address] of wallets.entries()) {
    const walletId = `wallet-${campaignValue.chainId}-${index}`;
    fixtureValue.db.prepare('INSERT OR IGNORE INTO wallet (id, chain_profile_id, address, key_reference, created_at) VALUES (?, ?, ?, ?, ?)').run(walletId, `profile-${campaignValue.chainId}`, address, `test-key-${index}`, NOW);
    fixtureValue.db.prepare('INSERT OR IGNORE INTO campaign_wallet (campaign_id, wallet_id, enabled, selected_at) VALUES (?, ?, 1, ?)').run(campaignValue.id, walletId, NOW);
  }
  await fixtureValue.store.transaction((state) => { state.runs.push(run); state.intents.push(intent); });
  const persistedRun = fixtureValue.store.snapshot().runs.find((item) => item.id === run.id);
  if (!persistedRun) throw new Error('run missing');
  return { run: persistedRun, intent, input: { run: persistedRun, intent, campaign: campaignValue, wallets } };
}

