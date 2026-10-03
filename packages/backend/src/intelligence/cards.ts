import { buildAlertCard, cleanText, type AlertCard, type AlertCardField, type AlertCardInput } from '../alert-card.js';
import { opportunityId, calendarId, shortAddress, type DropSnapshot } from './port.js';
import { formatEth, type ScoreResult } from './scoring.js';

/** Alert cards for the collection alerts (T-029). Wording only: nothing here reads the chain or changes scoring. */

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const count = (value: number | bigint): string => value.toLocaleString('en-US');

export function priceText(priceWei: bigint | null): string {
  return priceWei === null ? 'unknown' : priceWei === 0n ? 'free' : `${formatEth(priceWei)} ETH each`;
}

export function mintKind(priceWei: bigint | null): AlertCard['mint'] {
  return priceWei === null ? 'unknown' : priceWei === 0n ? 'free' : 'paid';
}

export function durationText(milliseconds: number): string {
  const minutes = Math.max(1, Math.round(milliseconds / 60_000));
  if (minutes < 90) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} days`;
}

/** `Sun 5 Oct 14:00 UTC, in 3 h`, `live now`, or `unknown` when the opening time is not known. */
export function opensText(startMs: number | null, now: number): string {
  if (startMs === null || startMs <= 0) return 'unknown';
  if (startMs <= now) return 'live now';
  const at = new Date(startMs);
  return `${WEEKDAYS[at.getUTCDay()]} ${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.toISOString().slice(11, 16)} UTC, in ${durationText(startMs - now)}`;
}

export function limitText(maxPerWallet: number | null): string {
  if (maxPerWallet === null) return 'unknown';
  return maxPerWallet > 0 ? `${maxPerWallet} per wallet` : 'no allowance (0 per wallet)';
}

export function walletName(address: string, labels: ReadonlyMap<string, string | null | undefined>): string {
  const label = cleanText(labels.get(address.toLowerCase()) ?? '', 24);
  return label || shortAddress(address);
}

export interface OpportunityCardInput {
  chainId: number;
  contract: string;
  collectionName: string | null;
  score: number;
  priceWei: bigint | null;
  watchingConfigured: boolean;
  /** Watched wallets that paid for their own mint, and wallets that only received an NFT. */
  minters: readonly string[];
  receivers: number;
  labels: ReadonlyMap<string, string | null | undefined>;
  drop: DropSnapshot | null;
  /** Mints the bot has seen on this contract, and in the last hour. */
  seenMinted: number;
  mintsLastHour: number;
  scored: ScoreResult;
  spottedAt: number;
  now: number;
}

function trackingStatus(input: OpportunityCardInput): string {
  if (!input.watchingConfigured) return 'no watched wallets are set up';
  const received = input.receivers > 0 ? ` · ${input.receivers} more received an NFT from it` : '';
  if (input.minters.length === 0) return `none of your watched wallets have minted this${received}`;
  const names = input.minters.slice(0, 5).map((address) => walletName(address, input.labels));
  const more = input.minters.length > 5 ? ` +${input.minters.length - 5} more` : '';
  return `${input.minters.length} of your watched wallets minted (${names.join(', ')}${more})${received}`;
}

function supplyText(input: OpportunityCardInput): string {
  const { drop } = input;
  if (drop && drop.maxSupply !== null && drop.totalMinted !== null) return `${count(drop.totalMinted)} minted of ${count(drop.maxSupply)}`;
  const seen = `${count(input.seenMinted)} seen minted by the bot, total supply unknown`;
  return drop && drop.maxSupply !== null ? `${seen} (maximum ${count(drop.maxSupply)})` : seen;
}

export function opportunityCard(input: OpportunityCardInput): AlertCard {
  const why = input.scored.factors.filter((factor) => factor.status === 'available' && factor.points > 0).sort((left, right) => right.points - left.points).slice(0, 3).map((factor) => factor.explanation);
  const watchOut = [...input.scored.risks.map((risk) => risk.message), ...input.scored.factors.filter((factor) => factor.status === 'unavailable' && (factor.code === 'price' || factor.code === 'contract_code')).map((factor) => factor.explanation)];
  const fields: AlertCardField[] = [
    { label: 'Tracking Status', value: trackingStatus(input) },
    { label: 'Price', value: priceText(input.priceWei) },
    { label: 'Opens', value: opensText(input.drop && input.drop.startTime > 0 ? input.drop.startTime * 1000 : null, input.now) },
    { label: 'Supply', value: supplyText(input) },
    { label: 'Limit', value: limitText(input.drop ? input.drop.maxPerWallet : null) },
    { label: 'Activity', value: `${count(input.mintsLastHour)} mint(s) in the last hour` },
  ];
  return buildAlertCard({
    title: `WORTH A LOOK · score ${input.score}/100`, chainId: input.chainId, contract: input.contract, collectionName: input.collectionName, mint: mintKind(input.priceWei),
    fields, notes: [...(why.length > 0 ? [{ label: 'Why', value: why.join(' ') }] : []), ...(watchOut.length > 0 ? [{ label: 'Watch out', value: watchOut.join(' ') }] : [])],
    summary: `Score ${input.score}/100 · ${priceText(input.priceWei)} · ${input.minters.length} watched wallet(s) minted`,
    record: { kind: 'opportunity', id: opportunityId(input.chainId, input.contract) }, spottedAt: input.spottedAt, spottedLabel: 'the latest mint',
  });
}

export interface DropCardInput { chainId: number; contract: string; collectionName: string | null; drop: DropSnapshot; now: number; }

function dropBase(input: DropCardInput): Omit<AlertCardInput, 'title'> {
  return { chainId: input.chainId, contract: input.contract, collectionName: input.collectionName, mint: mintKind(input.drop.priceWei), record: { kind: 'calendar', id: calendarId(input.chainId, input.contract) }, spottedAt: input.now, spottedLabel: 'this drop' };
}

const dropFields = (input: DropCardInput): AlertCardField[] => [
  { label: 'Opens', value: opensText(input.drop.startTime * 1000, input.now) },
  { label: 'Price', value: priceText(input.drop.priceWei) },
  { label: 'Limit', value: limitText(input.drop.maxPerWallet) },
];

export function openingSoonCard(input: DropCardInput): AlertCard {
  const minutes = Math.round((input.drop.startTime * 1000 - input.now) / 60_000);
  return buildAlertCard({ ...dropBase(input), title: 'OPENING SOON', fields: dropFields(input), notes: minutes <= 30 ? [{ label: 'Next', value: 'Check wallet readiness on the dashboard.' }] : [], summary: `opens in ${durationText(input.drop.startTime * 1000 - input.now)}, ${priceText(input.drop.priceWei)}, ${limitText(input.drop.maxPerWallet)}` });
}

export function priceAboveLimitCard(input: DropCardInput & { limitWei: bigint }): AlertCard {
  return buildAlertCard({ ...dropBase(input), title: 'OVER YOUR PRICE LIMIT', fields: [{ label: 'Price', value: priceText(input.drop.priceWei) }, { label: 'Your limit', value: `${formatEth(input.limitWei)} ETH per NFT` }, { label: 'Opens', value: opensText(input.drop.startTime * 1000, input.now) }], notes: [{ label: 'Bot', value: 'will not plan to mint it.' }], summary: `${priceText(input.drop.priceWei)}, above your ${formatEth(input.limitWei)} ETH limit; the bot will not plan to mint it` });
}

export interface ReadinessCardInput { chainId: number; contract: string; collectionName: string | null; startMs: number; priceWei: bigint; maxPerWallet: number; now: number; }

function readinessBase(input: ReadinessCardInput): Omit<AlertCardInput, 'title'> {
  return { chainId: input.chainId, contract: input.contract, collectionName: input.collectionName, mint: mintKind(input.priceWei), record: { kind: 'calendar', id: calendarId(input.chainId, input.contract) }, spottedAt: input.now, spottedLabel: 'this drop' };
}

export function quantityReducedCard(input: ReadinessCardInput & { message: string }): AlertCard {
  return buildAlertCard({ ...readinessBase(input), title: 'FEWER NFTS THAN PLANNED', fields: [{ label: 'Opens', value: opensText(input.startMs, input.now) }, { label: 'Price', value: priceText(input.priceWei) }], notes: [{ label: 'Why', value: input.message }], summary: input.message });
}

export function underfundedCard(input: ReadinessCardInput & { wallets: ReadonlyArray<{ wallet: string; topUpWei: bigint }>; requiredWei: bigint; plan: string }): AlertCard {
  const lines = input.wallets.slice(0, 8).map((row) => ({ label: 'Top up', value: `${formatEth(row.topUpWei)} ETH to ${row.wallet}` }));
  const more = input.wallets.length > 8 ? [{ label: 'More', value: `${input.wallets.length - 8} more wallet(s) need a top-up` }] : [];
  return buildAlertCard({ ...readinessBase(input), title: 'WALLETS NEED ETH', fields: [{ label: 'Opens', value: opensText(input.startMs, input.now) }, { label: 'Needs', value: `${formatEth(input.requiredWei)} ETH in total per wallet (${input.plan})` }, ...lines, ...more], summary: `${input.wallets.length} wallet(s) need more ETH before it opens` });
}

export function eligibleReadyCard(input: ReadinessCardInput & { ready: number; total: number; plan: string; note: string }): AlertCard {
  return buildAlertCard({ ...readinessBase(input), title: 'WALLETS READY', fields: [{ label: 'Ready', value: `${input.ready} of ${input.total} wallets` }, { label: 'Plan', value: input.plan }, { label: 'Opens', value: opensText(input.startMs, input.now) }], notes: [{ label: 'Approval', value: input.note }], summary: `${input.ready} of ${input.total} wallets ready; ${input.plan}` });
}
