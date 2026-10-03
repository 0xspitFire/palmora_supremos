import { redactText } from './observability.js';

/**
 * Owner alert cards (T-029, D-044). A card is the structured form of one collection alert. It is stored
 * with the alert event and rendered by the Telegram sender at the moment of sending, so the "seconds since
 * spotted" line is true at delivery (retries and digests included). Everything that comes from the chain,
 * the collection name above all, is untrusted text: it is cleaned, capped and escaped, and it never
 * decides where a link points.
 */
export interface AlertCardField { label: string; value: string; }

export interface AlertCard {
  v: 1;
  /** Headline, for example `WORTH A LOOK · score 72/100`. */
  title: string;
  chainId: number;
  /** Lower-case 0x address of the collection contract. */
  contract: string;
  /** Collection name read from the contract; null when it has none (the chain label then names it). */
  collectionName: string | null;
  mint: 'free' | 'paid' | 'unknown';
  fields: AlertCardField[];
  /** Why / Watch out lines, shown after the fields. */
  notes: AlertCardField[];
  /** One line for digests. */
  summary: string;
  /** The dashboard record this alert is about, for the deep link. */
  record?: DashboardRecord;
  /** When the bot spotted what this alert is about (ISO). */
  spottedAt: string;
  /** Finishes the sentence "... after the bot spotted ...". */
  spottedLabel: string;
}

export interface DashboardRecord { kind: 'opportunity' | 'calendar'; id: string; }
export interface DigestItem { text: string; card?: AlertCard; }
export interface AlertButton { text: string; url: string; }
export interface RenderContext { now: Date; dashboardUrl?: string; }
export interface RenderedAlert { html: string; plain: string; buttons: AlertButton[]; }

export interface AlertCardInput {
  title: string;
  chainId: number;
  contract: string;
  collectionName?: string | null;
  mint?: AlertCard['mint'];
  fields?: AlertCardField[];
  notes?: AlertCardField[];
  summary?: string;
  record?: DashboardRecord;
  spottedAt: Date | number | string;
  spottedLabel?: string;
}

/** Display facts per chain. Display only: the chain configuration is not read or changed here. */
interface ChainDisplay { name: string; short: string; explorer?: string; explorerName?: string; openSea?: string; }
const CHAIN_DISPLAY: Readonly<Record<string, ChainDisplay>> = {
  '1': { name: 'ETHEREUM', short: 'ETH', explorer: 'https://etherscan.io', explorerName: 'Etherscan', openSea: 'ethereum' },
  '4663': { name: 'ROBINHOOD', short: 'ROBIN', explorer: 'https://robinhoodchain.blockscout.com', explorerName: 'Blockscout' },
  '8453': { name: 'BASE', short: 'BASE', explorer: 'https://basescan.org', explorerName: 'Basescan', openSea: 'base' },
};

export function chainDisplay(chainId: number): ChainDisplay {
  const key = String(chainId);
  return Object.hasOwn(CHAIN_DISPLAY, key) ? CHAIN_DISPLAY[key]! : { name: `CHAIN ${chainId}`, short: `CHAIN ${chainId}` };
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const MAX_FIELDS = 12;
const MAX_NOTES = 4;
const MAX_DIGEST_ITEMS = 50;
/** Telegram allows 4096 characters; stay below it so a message is never cut inside a tag. */
export const HTML_BUDGET = 3_900;
/** The redaction filter cuts text at 2,000 characters, so the plain-text form is built to fit under that. */
export const PLAIN_BUDGET = 1_900;

const HIDDEN = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u115f\u1160\u17b4\u17b5\u034f\u180b-\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\u2800\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff9-\ufffb]/g;
const TAG_CHARS = /[\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu;

/**
 * Plain text from an untrusted source: one line, no hidden or direction-changing characters, capped by characters.
 * `fold` also folds look-alike forms (full-width letters, ligatures) to plain ones; it is used for names read from the chain.
 */
export function cleanText(value: unknown, max: number, fold = false): string {
  if (typeof value !== 'string') return '';
  const flat = (fold ? value.normalize('NFKC') : value).replace(/\s+/g, ' ').replace(HIDDEN, '').replace(TAG_CHARS, '').trim();
  const chars = Array.from(flat);
  return chars.length > max ? `${chars.slice(0, max - 1).join('').trimEnd()}…` : flat;
}

/**
 * A collection name as read from a contract: cleaned, capped at 40 characters, and defused so that Telegram has
 * nothing to turn into a live link, mention, hashtag, cashtag, command, e-mail address or phone number, in any
 * place the name is shown (the formatted message, the plain-text fallback, the stored text). A dot between two
 * letters or digits becomes a middle dot, so no word can read as a web address; `@`, `#` and `$` are removed; a
 * leading `/` is removed; a long run of digits is split. It can only ever be display text.
 */
export function cleanCollectionName(value: unknown): string | null {
  const grouped = (digits: string): string => (digits.match(/.{1,4}/g) ?? [digits]).join(' ');
  const name = cleanText(value, 40, true)
    .replace(/[@#$]/g, '')
    .replace(/(^|\s)\/+/g, '$1')
    .replace(/:\/\//g, ' ')
    .replace(/(?<=[\p{L}\p{N}])\.(?=[\p{L}\p{N}])/gu, '·')
    .replace(/\+(?=\d)/g, '')
    .replace(/\d{7,}/g, grouped);
  const capped = cleanText(name, 40);
  return capped === '' ? null : capped;
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Dynamic text is redacted value by value, then escaped. A whole formatted message is not passed through the filter,
// because it cuts text at 2,000 characters; links are generated from the fixed table and validated addresses, never from input.
export const safe = (value: string): string => escapeHtml(redactText(value));

export function explorerAddressUrl(chainId: number, contract: string): string | undefined {
  const chain = chainDisplay(chainId);
  return chain.explorer && ADDRESS.test(contract) ? `${chain.explorer}/address/${contract.toLowerCase()}` : undefined;
}

/** Explorer page of a transaction; the hash is validated, so a link can only ever point at a real hash. */
export function explorerTxUrl(chainId: number, hash: string): string | undefined {
  const chain = chainDisplay(chainId);
  return chain.explorer && /^0x[0-9a-fA-F]{64}$/.test(hash) ? `${chain.explorer}/tx/${hash.toLowerCase()}` : undefined;
}

/** OpenSea page for a contract, only on chains OpenSea supports. A brand-new mint may not be indexed there yet. */
export function openSeaUrl(chainId: number, contract: string): string | undefined {
  const chain = chainDisplay(chainId);
  return chain.openSea && ADDRESS.test(contract) ? `https://opensea.io/assets/${chain.openSea}/${contract.toLowerCase()}` : undefined;
}

/**
 * Anchor of a record on the dashboard home page: the page gives each card the id `home-<kind>-<record id>`,
 * lower-cased with every run of other characters turned into one dash (the web package's stateClass). A test in
 * the cli package checks this against the page that is really served.
 */
export function dashboardAnchor(record: DashboardRecord): string {
  return `home-${record.kind}-${record.id}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown';
}

/** Dashboard record link from one setting, so a live deployment changes the setting and nothing else. */
export function dashboardLink(base: string | undefined, record?: DashboardRecord): string | undefined {
  if (!base) return undefined;
  let url: URL;
  try { url = new URL(base); } catch { return undefined; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined;
  url.search = '';
  url.hash = record ? dashboardAnchor(record) : '';
  return url.toString();
}

function field(value: unknown, valueMax: number): AlertCardField | null {
  if (value === null || typeof value !== 'object') return null;
  const label = cleanText((value as Record<string, unknown>).label, 24);
  const text = cleanText((value as Record<string, unknown>).value, valueMax);
  return label && text ? { label, value: text } : null;
}

const present = <T>(value: T | null): value is T => value !== null;

/** Strict parse of a stored card. Returns null for anything malformed; the alert then goes out as plain text. */
export function parseAlertCard(raw: unknown): AlertCard | null {
  if (raw === null || typeof raw !== 'object') return null;
  const card = raw as Record<string, unknown>;
  if (card.v !== 1 || typeof card.contract !== 'string' || !ADDRESS.test(card.contract)) return null;
  if (typeof card.chainId !== 'number' || !Number.isSafeInteger(card.chainId) || card.chainId <= 0) return null;
  const spotted = typeof card.spottedAt === 'string' ? Date.parse(card.spottedAt) : Number.NaN;
  if (!Number.isFinite(spotted)) return null;
  const title = cleanText(card.title, 80);
  if (!title) return null;
  const rawRecord = card.record !== null && typeof card.record === 'object' ? card.record as Record<string, unknown> : undefined;
  const record: DashboardRecord | undefined = rawRecord && (rawRecord.kind === 'opportunity' || rawRecord.kind === 'calendar') && typeof rawRecord.id === 'string' && /^[A-Za-z0-9:._-]{1,120}$/.test(rawRecord.id) ? { kind: rawRecord.kind, id: rawRecord.id } : undefined;
  return {
    v: 1,
    title,
    chainId: card.chainId,
    contract: card.contract.toLowerCase(),
    collectionName: cleanCollectionName(card.collectionName),
    mint: card.mint === 'free' || card.mint === 'paid' ? card.mint : 'unknown',
    fields: (Array.isArray(card.fields) ? card.fields : []).slice(0, MAX_FIELDS).map((entry) => field(entry, 400)).filter(present),
    notes: (Array.isArray(card.notes) ? card.notes : []).slice(0, MAX_NOTES).map((entry) => field(entry, 400)).filter(present),
    summary: cleanText(card.summary, 300),
    ...(record ? { record } : {}),
    spottedAt: new Date(spotted).toISOString(),
    spottedLabel: cleanText(card.spottedLabel, 60) || 'this',
  };
}

/** Builds a card from producer data; throws when the contract or chain is not valid. */
export function buildAlertCard(input: AlertCardInput): AlertCard {
  const spotted = new Date(input.spottedAt);
  const card = parseAlertCard({ v: 1, ...input, spottedAt: Number.isFinite(spotted.getTime()) ? spotted.toISOString() : undefined });
  if (!card) throw new Error('ALERT_CARD_INVALID');
  return card;
}

export function parseDigestItems(raw: unknown): DigestItem[] | null {
  if (!Array.isArray(raw)) return null;
  const items: DigestItem[] = [];
  for (const entry of raw.slice(0, MAX_DIGEST_ITEMS)) {
    if (entry === null || typeof entry !== 'object') return null;
    const text = cleanText((entry as Record<string, unknown>).text, 600);
    const card = parseAlertCard((entry as Record<string, unknown>).card);
    if (!text && !card) return null;
    items.push({ text, ...(card ? { card } : {}) });
  }
  return items.length > 0 ? items : null;
}

export function clock(date: Date): string { return `${date.toISOString().slice(11, 19)} UTC`; }

export function secondsText(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1_000));
  return seconds >= 120 ? `${seconds} s (${Math.round(seconds / 60)} min)` : `${seconds} s`;
}

function heading(card: AlertCard): { name: string; kind: string; explorer?: string } {
  const chain = chainDisplay(card.chainId);
  const explorer = explorerAddressUrl(card.chainId, card.contract);
  return {
    name: card.collectionName ?? `${chain.short} MINT`,
    kind: [chain.name, ...(card.mint === 'free' ? ['FREE MINT'] : [])].join(' · '),
    ...(explorer ? { explorer } : {}),
  };
}

function sentLine(card: AlertCard, now: Date): string {
  return `Sent ${clock(now)}, ${secondsText(now.getTime() - Date.parse(card.spottedAt))} after the bot spotted ${card.spottedLabel}`;
}

function buttonsFor(card: AlertCard): AlertButton[] {
  const chain = chainDisplay(card.chainId);
  const explorer = explorerAddressUrl(card.chainId, card.contract);
  const openSea = openSeaUrl(card.chainId, card.contract);
  return [...(explorer ? [{ text: chain.explorerName ?? 'Explorer', url: explorer }] : []), ...(openSea ? [{ text: 'OpenSea', url: openSea }] : [])];
}

function htmlOf(card: AlertCard, ctx: RenderContext, fields: readonly AlertCardField[], notes: readonly AlertCardField[]): string {
  const { name, kind, explorer } = heading(card);
  const dashboard = dashboardLink(ctx.dashboardUrl, card.record);
  const line = (entry: AlertCardField): string => `<b>${safe(entry.label)}:</b> ${safe(entry.value)}`;
  return [
    `<b>${safe(card.title)}</b>`,
    explorer ? `<a href="${escapeHtml(explorer)}">${safe(name)}</a>` : safe(name),
    `<code>${card.contract}</code>`,
    escapeHtml(kind),
    ...(fields.length > 0 ? ['', ...fields.map(line)] : []),
    ...(notes.length > 0 ? ['', ...notes.map(line)] : []),
    '',
    `${dashboard ? `<a href="${escapeHtml(dashboard)}">Dashboard record</a> · ` : ''}Nothing is bought automatically.`,
    `<i>${safe(sentLine(card, ctx.now))}</i>`,
  ].join('\n');
}

function plainOf(card: AlertCard, ctx: Partial<RenderContext>): string {
  const { name, kind, explorer } = heading(card);
  const dashboard = dashboardLink(ctx.dashboardUrl, card.record);
  const line = (entry: AlertCardField): string => `${entry.label}: ${entry.value}`;
  return [
    card.title,
    name,
    ...(explorer ? [explorer] : []),
    card.contract,
    kind,
    ...(card.fields.length > 0 ? ['', ...card.fields.map(line)] : []),
    ...(card.notes.length > 0 ? ['', ...card.notes.map(line)] : []),
    '',
    ...(dashboard ? [`Dashboard record: ${dashboard}`] : []),
    'Nothing is bought automatically.',
    ...(ctx.now ? [sentLine(card, ctx.now)] : []),
  ].join('\n');
}

/** Plain text of a card without a send time: the stored fallback and what other sinks see. */
export function plainAlertText(card: AlertCard): string { return plainOf(card, {}); }

/** The formatted message, its plain-text fallback, and the link buttons, for the moment of sending. */
export function renderAlertCard(card: AlertCard, ctx: RenderContext): RenderedAlert {
  let fields = card.fields;
  let notes = card.notes;
  let html = htmlOf(card, ctx, fields, notes);
  let plain = plainOf(card, ctx);
  // Drop the least important lines (notes first, then the last fields) until both forms fit, so a message is never
  // cut in the middle of a tag or loses its closing lines.
  while ((html.length > HTML_BUDGET || plain.length > PLAIN_BUDGET) && (notes.length > 0 || fields.length > 0)) {
    if (notes.length > 0) notes = notes.slice(0, -1); else fields = fields.slice(0, -1);
    html = htmlOf(card, ctx, fields, notes);
    plain = plainOf({ ...card, fields, notes }, ctx);
  }
  return { html, plain, buttons: buttonsFor(card) };
}

/** A digest of grouped alerts: a compact entry per item, as many as fit, and the age of the oldest item. */
export function renderDigest(items: readonly DigestItem[], ctx: RenderContext): RenderedAlert {
  const dashboardFor = (card: AlertCard): string | undefined => dashboardLink(ctx.dashboardUrl, card.record);
  const entry = (item: DigestItem): { html: string; plain: string } => {
    if (!item.card) return { html: `• ${safe(item.text)}`, plain: `• ${item.text}` };
    const { name, kind, explorer } = heading(item.card);
    const summary = item.card.summary || item.card.title;
    const dashboard = dashboardFor(item.card);
    return {
      html: [`• ${explorer ? `<a href="${escapeHtml(explorer)}">${safe(name)}</a>` : safe(name)} · ${escapeHtml(kind)}`, `  ${safe(summary)}`, ...(dashboard ? [`  <a href="${escapeHtml(dashboard)}">Dashboard record</a>`] : [])].join('\n'),
      plain: [`• ${name} · ${kind}`, `  ${summary}`, ...(explorer ? [`  ${explorer}`] : []), ...(dashboard ? [`  ${dashboard}`] : [])].join('\n'),
    };
  };
  const spotted = items.flatMap((item) => (item.card ? [Date.parse(item.card.spottedAt)] : [])).filter(Number.isFinite);
  const footer = `Sent ${clock(ctx.now)}${spotted.length > 0 ? `, oldest item spotted ${secondsText(ctx.now.getTime() - Math.min(...spotted))} earlier` : ''}`;
  const head = `MintBot reminders (${items.length})`;
  const htmlLines = [`<b>${head}</b>`];
  const plainLines = [head];
  let shown = 0;
  for (const item of items) {
    const next = entry(item);
    const more = `… and ${items.length - shown - 1} more`;
    const htmlRoom = HTML_BUDGET - [...htmlLines, next.html, more, `<i>${footer}</i>`].join('\n').length;
    const plainRoom = PLAIN_BUDGET - [...plainLines, next.plain, more, footer].join('\n').length;
    if (htmlRoom < 0 || plainRoom < 0) break;
    htmlLines.push(next.html);
    plainLines.push(next.plain);
    shown += 1;
  }
  if (shown < items.length) {
    htmlLines.push(`… and ${items.length - shown} more`);
    plainLines.push(`… and ${items.length - shown} more`);
  }
  htmlLines.push(`<i>${safe(footer)}</i>`);
  plainLines.push(footer);
  return { html: htmlLines.join('\n'), plain: plainLines.join('\n'), buttons: [] };
}
