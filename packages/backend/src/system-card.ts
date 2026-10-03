import { HTML_BUDGET, PLAIN_BUDGET, clock, cleanText, dashboardLink, escapeHtml, explorerTxUrl, safe, secondsText, type AlertButton, type RenderContext, type RenderedAlert } from './alert-card.js';

/**
 * Owner system messages (T-030, D-045): start, daily check-in, kill switch, spend cap, health and the Telegram test.
 * Like the collection alert card, a system card is stored with its event and rendered by the Telegram sender at the
 * moment of sending, so "N s after it happened" is true at delivery. Every value is cleaned, capped and escaped; a link
 * is only ever built from a validated transaction hash or the configured dashboard address, never from message text.
 */
export type Severity = 'info' | 'attention' | 'critical';
export interface SystemLine { label: string; value: string; /** Shows the value in bold: the fact the owner should not miss. */ strong?: boolean; }
export interface SystemTxLink { text: string; chainId: number; hash: string; }
export interface SystemCard {
  v: 1;
  kind: 'system';
  /** Upper-case headline, for example `KILL SWITCH ENGAGED`. */
  title: string;
  severity: Severity;
  lines: SystemLine[];
  /** Numbered actions under "What to do". Empty when nothing is needed. */
  steps: string[];
  /** A value to copy as is, shown in a tap-to-copy block. */
  code?: { label: string; value: string };
  /** Adds a dashboard line when a dashboard address is configured. */
  dashboard?: boolean;
  txLinks?: SystemTxLink[];
  /** When the thing this message reports happened (ISO); the message then says how long after it was sent. */
  eventAt?: string;
  /** Finishes "... after <label>", for example `the kill`. */
  eventLabel?: string;
  /** One line for the plain-text fallback of other sinks. */
  summary: string;
}

export interface SystemCardInput {
  title: string;
  severity: Severity;
  lines?: SystemLine[];
  steps?: string[];
  code?: { label: string; value: string };
  dashboard?: boolean;
  txLinks?: SystemTxLink[];
  eventAt?: Date | number | string;
  eventLabel?: string;
  summary?: string;
}

const MAX_LINES = 14;
const MAX_STEPS = 6;
const MAX_LINKS = 3;
const SEVERITIES: readonly Severity[] = ['info', 'attention', 'critical'];

function line(value: unknown): SystemLine | null {
  if (value === null || typeof value !== 'object') return null;
  const entry = value as Record<string, unknown>;
  const label = cleanText(entry.label, 30);
  const text = cleanText(entry.value, 400);
  return label && text ? { label, value: text, ...(entry.strong === true ? { strong: true } : {}) } : null;
}

const present = <T>(value: T | null): value is T => value !== null;

/** Strict parse of a stored system card; null for anything malformed (the message then goes out as plain text). */
export function parseSystemCard(raw: unknown): SystemCard | null {
  if (raw === null || typeof raw !== 'object') return null;
  const card = raw as Record<string, unknown>;
  if (card.v !== 1 || card.kind !== 'system' || !SEVERITIES.includes(card.severity as Severity)) return null;
  const title = cleanText(card.title, 60);
  if (!title) return null;
  const eventAt = typeof card.eventAt === 'string' && Number.isFinite(Date.parse(card.eventAt)) ? new Date(card.eventAt).toISOString() : undefined;
  const code = card.code !== null && typeof card.code === 'object' ? card.code as Record<string, unknown> : undefined;
  const codeLabel = code ? cleanText(code.label, 30) : '';
  const codeValue = code ? cleanText(code.value, 120) : '';
  const links = (Array.isArray(card.txLinks) ? card.txLinks : []).slice(0, MAX_LINKS).flatMap((entry): SystemTxLink[] => {
    if (entry === null || typeof entry !== 'object') return [];
    const link = entry as Record<string, unknown>;
    const text = cleanText(link.text, 24);
    if (!text || typeof link.chainId !== 'number' || typeof link.hash !== 'string' || !explorerTxUrl(link.chainId, link.hash)) return [];
    return [{ text, chainId: link.chainId, hash: link.hash.toLowerCase() }];
  });
  return {
    v: 1,
    kind: 'system',
    title,
    severity: card.severity as Severity,
    lines: (Array.isArray(card.lines) ? card.lines : []).slice(0, MAX_LINES).map(line).filter(present),
    steps: (Array.isArray(card.steps) ? card.steps : []).slice(0, MAX_STEPS).map((step) => cleanText(step, 300)).filter((step) => step !== ''),
    ...(codeLabel && codeValue ? { code: { label: codeLabel, value: codeValue } } : {}),
    ...(card.dashboard === true ? { dashboard: true } : {}),
    ...(links.length > 0 ? { txLinks: links } : {}),
    ...(eventAt ? { eventAt } : {}),
    ...(eventAt ? { eventLabel: cleanText(card.eventLabel, 60) || 'it happened' } : {}),
    summary: cleanText(card.summary, 300),
  };
}

/** Builds a system card from producer data; throws when it is not valid. */
export function buildSystemCard(input: SystemCardInput): SystemCard {
  const at = input.eventAt === undefined ? undefined : new Date(input.eventAt);
  const card = parseSystemCard({ v: 1, kind: 'system', ...input, eventAt: at && Number.isFinite(at.getTime()) ? at.toISOString() : undefined });
  if (!card) throw new Error('SYSTEM_CARD_INVALID');
  return card;
}

const SEVERITY_WORD: Readonly<Record<Severity, string>> = { info: 'INFO', attention: 'ATTENTION', critical: 'CRITICAL' };

function sentLine(card: SystemCard, now: Date): string {
  const after = card.eventAt ? `, ${secondsText(now.getTime() - Date.parse(card.eventAt))} after ${card.eventLabel ?? 'it happened'}` : '';
  return `Sent ${clock(now)}${after}`;
}

function dashboardParts(card: SystemCard, ctx: Partial<RenderContext>): { url: string; note: string } | undefined {
  if (!card.dashboard) return undefined;
  const url = dashboardLink(ctx.dashboardUrl);
  if (!url) return undefined;
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname);
  return { url, note: local ? 'opens on this laptop only' : '' };
}

function htmlOf(card: SystemCard, ctx: RenderContext, lines: readonly SystemLine[], steps: readonly string[]): string {
  const dashboard = dashboardParts(card, ctx);
  return [
    `<b>${safe(card.title)}</b> · ${SEVERITY_WORD[card.severity]}`,
    ...lines.map((entry) => `<b>${safe(entry.label)}:</b> ${entry.strong ? `<b>${safe(entry.value)}</b>` : safe(entry.value)}`),
    ...(dashboard ? [`<b>Dashboard:</b> <a href="${escapeHtml(dashboard.url)}">Open</a>${dashboard.note ? ` (${dashboard.note})` : ''}`] : []),
    ...(steps.length > 0 ? [`<b>What to do:</b>`, ...steps.map((step, index) => `${index + 1}. ${safe(step)}`)] : []),
    ...(card.code ? [`<b>${safe(card.code.label)}:</b> <code>${safe(card.code.value)}</code>`] : []),
    `<i>${safe(sentLine(card, ctx.now))}</i>`,
  ].join('\n');
}

function plainOf(card: SystemCard, ctx: Partial<RenderContext>, lines: readonly SystemLine[], steps: readonly string[]): string {
  const dashboard = dashboardParts(card, ctx);
  return [
    `${card.title} · ${SEVERITY_WORD[card.severity]}`,
    ...lines.map((entry) => `${entry.label}: ${entry.value}`),
    ...(dashboard ? [`Dashboard: ${dashboard.url}${dashboard.note ? ` (${dashboard.note})` : ''}`] : []),
    ...(steps.length > 0 ? ['What to do:', ...steps.map((step, index) => `${index + 1}. ${step}`)] : []),
    ...(card.code ? [`${card.code.label}: ${card.code.value}`] : []),
    ...(ctx.now ? [sentLine(card, ctx.now)] : []),
  ].join('\n');
}

/** Plain text of a card without a send time: the stored fallback and what other sinks see. */
export function plainSystemText(card: SystemCard): string { return plainOf(card, {}, card.lines, card.steps); }

/** The formatted message, its plain-text fallback and its link buttons, for the moment of sending. */
export function renderSystemCard(card: SystemCard, ctx: RenderContext): RenderedAlert {
  let lines = card.lines;
  let steps = card.steps;
  let html = htmlOf(card, ctx, lines, steps);
  let plain = plainOf(card, ctx, lines, steps);
  // Over budget: drop the last lines and steps (the most detailed ones) so nothing is cut inside a tag.
  while ((html.length > HTML_BUDGET || plain.length > PLAIN_BUDGET) && (lines.length > 1 || steps.length > 0)) {
    if (lines.length > 1) lines = lines.slice(0, -1); else steps = steps.slice(0, -1);
    html = htmlOf(card, ctx, lines, steps);
    plain = plainOf(card, ctx, lines, steps);
  }
  const buttons: AlertButton[] = (card.txLinks ?? []).flatMap((link) => { const url = explorerTxUrl(link.chainId, link.hash); return url ? [{ text: link.text, url }] : []; });
  return { html, plain, buttons };
}
