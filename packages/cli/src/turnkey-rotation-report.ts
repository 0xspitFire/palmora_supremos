import { createHash } from 'node:crypto';

/**
 * D-078 (B): builds the redacted `mintbot-rotation-revocation-drill` result that the D-017 collector consumes, from real, current
 * facts instead of hand-typed text. It writes nothing itself: it returns the report only when every check passed, otherwise the
 * list of problems. Every observation is counts and short words only (no addresses, ids or URLs).
 */
export interface RotationWallet { index: number; address: string; signWith: string }
export interface RotationRecord { wallets: readonly RotationWallet[]; expiresAt: string; policyId: string }
export interface ProviderKeyFact { privateKeyId: string; curve: string; exported: boolean; address: string | undefined }
export interface ProviderPolicyFact { policyId: string; effect: string; text: string }
export interface BalanceFact { chainId: number; address: string; wei: bigint }
export interface Ceiling { walletMaxWei: bigint; fleetMaxWei: bigint }
export interface RehearsalFact { recordedAt: string; policyRecordDigest: string; broadcastAttempted: boolean; rawText: string }

export interface RotationInput {
  now: Date;
  activeDigest: string;
  active: RotationRecord;
  previous: RotationRecord;
  /** Unexpired records of the installed catalog (the active one included). */
  catalog: readonly RotationRecord[];
  installedMap: readonly RotationWallet[];
  /** Raw text of the exact files whose digests the report cites. */
  activeRecordText: string;
  walletMapText: string;
  providerKeys: readonly ProviderKeyFact[];
  providerPolicies: readonly ProviderPolicyFact[];
  balances: readonly BalanceFact[];
  /** One entry per chain that must be checked; a chain without a ceiling or without balances cannot be proven bounded. */
  ceilings: Readonly<Record<number, Ceiling>>;
  rehearsal: RehearsalFact;
  /** Key ids of the references being retired in this drill. */
  retired: readonly string[];
}

export interface RotationReport {
  version: 1;
  type: 'mintbot-rotation-revocation-drill';
  environment: 'production';
  status: 'ok';
  completedAt: string;
  checks: Record<'fresh_wallet_inventory' | 'funding_profile_bounded' | 'old_references_excluded', { pass: true; observed: string }>;
  references: Array<{ name: string; sha256: string }>;
}

export type RotationResult = { ok: true; report: RotationReport } | { ok: false; problems: string[] };

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const DAY_MS = 24 * 60 * 60 * 1000;
const eth = (wei: bigint): string => `${(Number(wei / 10n ** 12n) / 1e6).toFixed(6)} ETH`;

export function buildRotationReport(input: RotationInput): RotationResult {
  const problems: string[] = [];

  // Rehearsal: must be for this exact record, recent, and non-broadcasting.
  const rehearsalAge = input.now.getTime() - Date.parse(input.rehearsal.recordedAt);
  if (input.rehearsal.policyRecordDigest !== input.activeDigest) problems.push('The no-broadcast rehearsal is for a different policy record than the installed one; rerun it.');
  if (input.rehearsal.broadcastAttempted !== false) problems.push('The rehearsal evidence does not say that nothing was broadcast.');
  if (!(rehearsalAge >= 0 && rehearsalAge <= DAY_MS)) problems.push('The no-broadcast rehearsal is missing a valid time or is older than 24 hours; rerun it.');

  // 1. Fresh inventory: the installed map equals the active record, every wallet is a live non-exported secp256k1 key with the same address, and at least one wallet is new.
  const sameList = input.installedMap.length === input.active.wallets.length
    && input.installedMap.every((wallet, index) => wallet.index === index && wallet.signWith === input.active.wallets[index]!.signWith && wallet.address.toLowerCase() === input.active.wallets[index]!.address.toLowerCase());
  const liveById = new Map(input.providerKeys.map((key) => [key.privateKeyId, key]));
  const notLive = input.active.wallets.filter((wallet) => {
    const key = liveById.get(wallet.signWith);
    return !key || key.curve !== 'CURVE_SECP256K1' || key.exported !== false || key.address?.toLowerCase() !== wallet.address.toLowerCase();
  });
  const previousIds = new Set(input.previous.wallets.map((wallet) => wallet.signWith));
  const fresh = input.active.wallets.filter((wallet) => !previousIds.has(wallet.signWith));
  if (!sameList) problems.push('The installed wallet map does not match the installed policy record.');
  if (notLive.length > 0) problems.push(`${notLive.length} wallet(s) in the record are not live, unexported secp256k1 keys at the provider with the same address.`);
  if (fresh.length === 0) problems.push('No wallet in the installed record is new compared with the previous record, so nothing was rotated in.');
  const freshOk = sameList && notLive.length === 0 && fresh.length > 0;

  // 2. Funding stays bounded on every chain, per wallet and for the fleet.
  let highest = 0n;
  let fundingOk = Object.keys(input.ceilings).length > 0;
  if (!fundingOk) problems.push('No balance ceilings were supplied, so funding cannot be proven bounded.');
  for (const [chain, ceiling] of Object.entries(input.ceilings)) {
    const chainId = Number(chain);
    const rows = input.balances.filter((row) => row.chainId === chainId);
    const seen = new Set(rows.map((row) => row.address.toLowerCase()));
    if (input.active.wallets.some((wallet) => !seen.has(wallet.address.toLowerCase()))) { fundingOk = false; problems.push(`Chain ${chainId}: a balance could not be read for every wallet, so funding is not proven bounded.`); continue; }
    const total = rows.reduce((sum, row) => sum + row.wei, 0n);
    const max = rows.reduce((top, row) => (row.wei > top ? row.wei : top), 0n);
    if (max > highest) highest = max;
    if (max > ceiling.walletMaxWei) { fundingOk = false; problems.push(`Chain ${chainId}: a wallet holds more than the per-wallet ceiling.`); }
    if (total > ceiling.fleetMaxWei) { fundingOk = false; problems.push(`Chain ${chainId}: the fleet holds more than the fleet ceiling.`); }
  }

  // 3. Retired references are really gone: not in the active record, the map, any unexpired catalog record, or any live provider allow policy.
  let exclusionOk = input.retired.length > 0;
  if (!exclusionOk) problems.push('No retired reference was named; the drill must retire at least one wallet.');
  // Every wallet dropped since the previous record must be named and checked, not only the ones the owner remembered to list.
  const dropped = input.previous.wallets.filter((wallet) => !input.active.wallets.some((current) => current.signWith === wallet.signWith)).map((wallet) => wallet.signWith);
  if (dropped.some((id) => !input.retired.includes(id))) { exclusionOk = false; problems.push('A wallet was dropped since the previous record but is not named as retired, so its removal was not checked.'); }
  const stillAuthorizing: string[] = [];
  for (const id of input.retired) {
    if (!previousIds.has(id)) { exclusionOk = false; problems.push('A named retired reference was not in the previous record, so retiring it proves nothing.'); continue; }
    const places: string[] = [];
    if (input.active.wallets.some((wallet) => wallet.signWith === id)) places.push('the installed record');
    if (input.installedMap.some((wallet) => wallet.signWith === id)) places.push('the installed wallet map');
    if (input.catalog.some((record) => record.wallets.some((wallet) => wallet.signWith === id))) places.push('an unexpired catalog record');
    const address = input.previous.wallets.find((wallet) => wallet.signWith === id)?.address.toLowerCase();
    const policy = input.providerPolicies.find((candidate) => candidate.effect === 'EFFECT_ALLOW' && (candidate.text.includes(id) || (address !== undefined && candidate.text.toLowerCase().includes(address))));
    if (policy) places.push('a live provider allow policy');
    if (places.length > 0) { exclusionOk = false; stillAuthorizing.push(id); problems.push(`A retired reference is still present in ${places.join(', ')}; remove it and rebuild the bundle first.`); }
  }

  if (problems.length > 0 || !freshOk || !fundingOk || !exclusionOk) return { ok: false, problems };

  const exclusionProof = JSON.stringify({ retiredCount: input.retired.length, checkedRecords: input.catalog.length + 1, checkedPolicies: input.providerPolicies.length, stillAuthorizing: stillAuthorizing.length });
  const fundingProfile = JSON.stringify({ chains: Object.keys(input.ceilings).sort(), wallets: input.active.wallets.length, highestWei: highest.toString() });
  return {
    ok: true,
    report: {
      version: 1,
      type: 'mintbot-rotation-revocation-drill',
      environment: 'production',
      status: 'ok',
      completedAt: input.now.toISOString(),
      checks: {
        fresh_wallet_inventory: { pass: true, observed: `${input.active.wallets.length} live wallets match the installed record; ${fresh.length} new since the previous record` },
        funding_profile_bounded: { pass: true, observed: `${Object.keys(input.ceilings).length} chains within ceilings; highest single balance ${eth(highest)}` },
        old_references_excluded: { pass: true, observed: `${input.retired.length} retired reference(s) not named in the record, map, any unexpired catalog record or any live allow policy` },
      },
      references: [
        { name: 'canonical-policy-record', sha256: sha256(input.activeRecordText) },
        { name: 'production-wallet-map', sha256: sha256(input.walletMapText) },
        { name: 'bounded-funding-profile', sha256: sha256(fundingProfile) },
        { name: 'no-broadcast-rehearsal', sha256: sha256(input.rehearsal.rawText) },
        { name: 'old-reference-exclusion', sha256: sha256(exclusionProof) },
      ],
    },
  };
}
