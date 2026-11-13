import { createHash } from 'node:crypto';
import type { SqliteDatabase } from '@mint-bot/database';
import type { Campaign } from './types.js';

export interface FundingHoldInput { campaignId: string; wallets: readonly string[]; idempotencyKey: string; expiresAt: string; }
/** Produced by the configured qualification verifier; user-supplied attestations are not an authority port. */
export interface FundingHoldQualification {
  kind: 'watched-free' | 'owner-paid'; reference: string; campaignDigest: string; wallets: readonly string[];
  observedAt: string; expiresAt: string; score?: number; watchedSelfMintVerified?: boolean;
  sourceMintedAt?: string; sourceDepth?: number; ownerApprovedIntentId?: string;
}
export interface FundingPendingHold {
  id: string; state: 'FundingPending' | 'Converted' | 'Released'; idempotencyKey: string;
  digest: string; campaignDigest: string; campaign: Campaign; wallets: readonly string[];
  requiredPerWalletWei: bigint; qualification: FundingHoldQualification; createdAt: string; expiresAt: string;
  boundRunId?: string;
}
export interface FundingHoldRow {
  hold_id: string; wallet_id: string; wallet_address: string; amount_wei: string; state: 'reserved' | 'converted' | 'released';
  campaign_id: string; chain_id: number; campaign_digest: string; hold_digest: string; payload_json: string;
  bound_run_id: string | null; created_at: string; expires_at: string;
}
export const fundingHoldEncode = (value: unknown) => JSON.stringify(value, (_key, item: unknown) => typeof item === 'bigint' ? `${item}n` : item);
export const fundingHoldDecode = <T>(value: string): T => JSON.parse(value, (_key, item: unknown) => typeof item === 'string' && /^\d+n$/.test(item) ? BigInt(item.slice(0, -1)) : item) as T;
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => typeof item === 'bigint' ? `${item}n` : item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
/** Lifecycle/report timestamps are not transaction policy; every execution/cap/custody field is bound. */
export const fundingCampaignDigest = ({ state: _state, createdAt: _created, updatedAt: _updated, ...campaign }: Campaign) => `sha256:${createHash('sha256').update(canonical(campaign)).digest('hex')}`;
export function fundingHoldDigest(value: unknown): string { return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`; }
export function assertFundingQualification(campaign: Campaign, wallets: readonly string[], proof: FundingHoldQualification, at: Date): void {
  const allowed = ['kind', 'reference', 'campaignDigest', 'wallets', 'observedAt', 'expiresAt', 'score', 'watchedSelfMintVerified', 'sourceMintedAt', 'sourceDepth', 'ownerApprovedIntentId'];
  if (Object.keys(proof).some(key => !allowed.includes(key))) throw new Error('FUNDING_QUALIFICATION_INVALID');
  const age = at.getTime() - Date.parse(proof.observedAt);
  if (!Number.isFinite(age) || age < 0 || age > 60_000 || !Number.isFinite(Date.parse(proof.expiresAt)) || Date.parse(proof.expiresAt) <= at.getTime() || !/^[A-Za-z0-9_.:-]{1,180}$/.test(proof.reference) || proof.campaignDigest !== fundingCampaignDigest(campaign) || [...proof.wallets].map(value => value.toLowerCase()).sort().join(',') !== [...wallets].map(value => value.toLowerCase()).sort().join(',')) throw new Error('FUNDING_QUALIFICATION_INVALID');
  if (campaign.mintPriceWei === 0n) {
    const sourceAge = at.getTime() - Date.parse(proof.sourceMintedAt ?? '');
    if (proof.kind !== 'watched-free' || proof.watchedSelfMintVerified !== true || typeof proof.score !== 'number' || !Number.isFinite(proof.score) || proof.score < 70 || proof.score > 100 || !Number.isFinite(sourceAge) || sourceAge < 0 || sourceAge > 15 * 60_000 || !Number.isSafeInteger(proof.sourceDepth) || proof.sourceDepth! < 2) throw new Error('FUNDING_WATCHED_SOURCE_REQUIRED');
  } else if (proof.kind !== 'owner-paid' || !proof.ownerApprovedIntentId || !/^[A-Za-z0-9_.:-]{1,180}$/.test(proof.ownerApprovedIntentId)) throw new Error('FUNDING_PAID_OWNER_INTENT_REQUIRED');
}
export function fundingHoldRows(db: SqliteDatabase, id: string): FundingHoldRow[] {
  return db.prepare('SELECT * FROM mint_funding_hold WHERE hold_id=? ORDER BY wallet_address').all(id) as FundingHoldRow[];
}
export function readFundingHold(db: SqliteDatabase, id: string): FundingPendingHold | undefined {
  const rows = fundingHoldRows(db, id); if (!rows.length) return undefined;
  if (rows.some(row => row.state !== rows[0]!.state || row.bound_run_id !== rows[0]!.bound_run_id || row.hold_digest !== rows[0]!.hold_digest)) throw new Error('FUNDING_HOLD_INCONSISTENT');
  const payload = fundingHoldDecode<FundingPendingHold>(rows[0]!.payload_json);
  return { ...payload, state: rows[0]!.state === 'reserved' ? 'FundingPending' : rows[0]!.state === 'converted' ? 'Converted' : 'Released', ...(rows[0]!.bound_run_id ? { boundRunId: rows[0]!.bound_run_id! } : {}) };
}
export function hasFundingHolds(db: SqliteDatabase): boolean { return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mint_funding_hold'").get()); }
export function pendingFundingHoldExposure(db: SqliteDatabase, filter: { walletId?: string; chainId?: number; mintClass?: 'free' | 'paid'; excludeHoldId?: string }): bigint {
  if (!hasFundingHolds(db)) return 0n;
  const rows = db.prepare("SELECT wallet_id,chain_id,mint_class,hold_id,amount_wei FROM mint_funding_hold WHERE state='reserved'").all() as Array<{ wallet_id: string; chain_id: number; mint_class: string; hold_id: string; amount_wei: string }>;
  return rows.filter(row => (!filter.walletId || row.wallet_id === filter.walletId) && (!filter.chainId || row.chain_id === filter.chainId) && (!filter.mintClass || row.mint_class === filter.mintClass) && row.hold_id !== filter.excludeHoldId).reduce((sum, row) => sum + BigInt(row.amount_wei), 0n);
}
export function assertNoStaleFundingHolds(db: SqliteDatabase, at: Date): void {
  if (!hasFundingHolds(db)) return;
  if (db.prepare("SELECT 1 FROM mint_funding_hold WHERE state='reserved' AND (julianday(created_at) IS NULL OR julianday(created_at)<=julianday(?)) LIMIT 1").get(new Date(at.getTime() - 86_400_000).toISOString())) throw new Error('STALE_PENDING_RESERVATION_REQUIRES_RECONCILIATION');
}
