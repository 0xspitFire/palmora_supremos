import { describe, expect, it } from 'vitest';
import { HTML_BUDGET, PLAIN_BUDGET } from './alert-card.js';
import { buildSystemCard, parseSystemCard, plainSystemText, renderSystemCard, type SystemCard } from './system-card.js';

const NOW = new Date('2026-10-03T14:03:22.000Z');
const HASH = `0x${'ab'.repeat(32)}`;

const card = (overrides: Partial<Parameters<typeof buildSystemCard>[0]> = {}): SystemCard => buildSystemCard({
  title: 'KILL SWITCH ENGAGED', severity: 'critical',
  lines: [{ label: 'What happened', value: 'the kill switch was engaged.', strong: true }, { label: 'What it means', value: 'no new mints are admitted.' }],
  steps: ['Check the state.', 'Release it from the terminal.'],
  code: { label: 'Run', value: 'run_1' },
  eventAt: new Date(NOW.getTime() - 2_000), eventLabel: 'the kill', summary: 'Kill switch engaged.', ...overrides,
});

describe('system message cards (T-030)', () => {
  it('renders title and severity, bold facts, numbered steps, a copyable value and the delay', () => {
    const { html, plain, buttons } = renderSystemCard(card(), { now: NOW });
    expect(html.split('\n')).toEqual([
      '<b>KILL SWITCH ENGAGED</b> · CRITICAL',
      '<b>What happened:</b> <b>the kill switch was engaged.</b>',
      '<b>What it means:</b> no new mints are admitted.',
      '<b>What to do:</b>',
      '1. Check the state.',
      '2. Release it from the terminal.',
      '<b>Run:</b> <code>run_1</code>',
      '<i>Sent 14:03:22 UTC, 2 s after the kill</i>',
    ]);
    expect(plain).not.toMatch(/<[a-z/]/);
    expect(plain).toContain('KILL SWITCH ENGAGED · CRITICAL');
    expect(plain.split('\n').at(-1)).toBe('Sent 14:03:22 UTC, 2 s after the kill');
    expect(buttons).toEqual([]);
  });

  it('says only "Sent <time>" when the message is not about an event, and never invents a delay', () => {
    const { html } = renderSystemCard(card({ eventAt: undefined, eventLabel: undefined }), { now: NOW });
    expect(html.split('\n').at(-1)).toBe('<i>Sent 14:03:22 UTC</i>');
  });

  it('adds the dashboard line only for a valid address, and says when it opens on this laptop only', () => {
    const wanted = card({ dashboard: true });
    expect(renderSystemCard(wanted, { now: NOW, dashboardUrl: 'http://127.0.0.1:8780/' }).html).toContain('<b>Dashboard:</b> <a href="http://127.0.0.1:8780/">Open</a> (opens on this laptop only)');
    const publicLine = renderSystemCard(wanted, { now: NOW, dashboardUrl: 'https://mint.example.org/app?token=1#x' }).html;
    expect(publicLine).toContain('<a href="https://mint.example.org/app">Open</a>');
    expect(publicLine).not.toContain('laptop');
    for (const bad of [undefined, 'javascript:alert(1)', 'https://user:pass@mint.example.org/']) expect(renderSystemCard(wanted, { now: NOW, ...(bad ? { dashboardUrl: bad } : {}) }).html).not.toContain('Dashboard:');
    expect(renderSystemCard(card(), { now: NOW, dashboardUrl: 'http://127.0.0.1:8780/' }).html).not.toContain('Dashboard:');
  });

  it('turns a transaction hash into an explorer button and drops one that is not a hash', () => {
    const linked = parseSystemCard({ ...card(), txLinks: [{ text: 'Transaction', chainId: 1, hash: HASH }, { text: 'Bad', chainId: 1, hash: '0x12' }, { text: 'Unknown chain', chainId: 99999, hash: HASH }] });
    expect(linked?.txLinks).toEqual([{ text: 'Transaction', chainId: 1, hash: HASH }]);
    expect(renderSystemCard(linked!, { now: NOW }).buttons).toEqual([{ text: 'Transaction', url: `https://etherscan.io/tx/${HASH}` }]);
  });

  it('escapes hostile text and redacts anything that looks like a secret in the formatted form (the sender redacts the plain form)', () => {
    const hostile = card({ lines: [{ label: 'What <b>happened', value: `<a href="https://evil.example">click</a> ${HASH} api_key=abc123`, strong: true }], steps: ['<script>alert(1)</script>'] });
    const { html } = renderSystemCard(hostile, { now: NOW });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<a href="https://evil.example">');
    expect(html).not.toContain(HASH);
    expect(html).not.toContain('abc123');
  });

  it('rejects malformed stored cards so the message goes out as plain text', () => {
    for (const bad of [null, 'x', {}, { ...card(), v: 2 }, { ...card(), kind: 'alert' }, { ...card(), severity: 'fatal' }, { ...card(), title: '   ' }]) expect(parseSystemCard(bad)).toBeNull();
    expect(() => buildSystemCard({ title: '', severity: 'info' })).toThrow('SYSTEM_CARD_INVALID');
    const lenient = parseSystemCard({ ...card(), lines: 'nope', steps: [1, '', 'ok'], eventAt: 'not a date' });
    expect(lenient).toMatchObject({ lines: [], steps: ['ok'] });
    expect(lenient?.eventAt).toBeUndefined();
  });

  it('keeps both forms inside their budgets however much text arrives, and never cuts inside a tag', () => {
    const lines = Array.from({ length: 14 }, (_, index) => ({ label: `Line ${index}`, value: 'x'.repeat(390), strong: true }));
    const { html, plain } = renderSystemCard(card({ lines, steps: Array.from({ length: 6 }, () => 'y'.repeat(290)) }), { now: NOW });
    expect(html.length).toBeLessThanOrEqual(HTML_BUDGET);
    expect(plain.length).toBeLessThanOrEqual(PLAIN_BUDGET);
    expect(html.split('\n').at(-1)).toMatch(/^<i>Sent /);
    expect((html.match(/<b>/g) ?? []).length).toBe((html.match(/<\/b>/g) ?? []).length);
  });

  it('stores a plain-text form without a send time for other sinks', () => {
    const text = plainSystemText(card());
    expect(text).toContain('What happened: the kill switch was engaged.');
    expect(text).not.toContain('Sent ');
  });
});
