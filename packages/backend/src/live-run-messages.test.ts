import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderSystemCard, type SystemCard } from './system-card.js';
import { ambiguousSubmissionCard, mintBlockedCard, mintConfirmedCard, mintFailedCard, mintSubmittedCard, runStartedCard, runSummaryCard, shortHash } from './live-run-messages.js';

const NOW = new Date('2026-10-03T14:03:22.000Z');
const at = new Date(NOW.getTime() - 4_000);
const HASH = `0x${'cd'.repeat(32)}`;
const WALLET = '0x365952eb1e8209bf2bcc2db5ed213111a87d061e';
const facts = { runId: 'run_7', chainId: 1, collection: 'Pudgy Example', wallet: WALLET, quantity: 2, at };
const render = (card: SystemCard) => renderSystemCard(card, { now: NOW, dashboardUrl: 'http://127.0.0.1:8780/' });

describe('live-run message templates (T-030, Phase 3, not wired)', () => {
  it('shortens hashes and addresses in the text, and gives the full hash only through the explorer button', () => {
    expect(shortHash(HASH)).toBe('0xcdcd…cdcd');
    expect(shortHash('not a hash')).toBe('unknown');
    const { html, plain, buttons } = render(mintSubmittedCard({ ...facts, hash: HASH }));
    for (const text of [html, plain]) { expect(text).not.toContain(HASH); expect(text).not.toContain(WALLET); expect(text).toContain('0xcdcd…cdcd'); expect(text).toContain('0x3659…061e'); }
    expect(buttons).toEqual([{ text: 'Transaction', url: `https://etherscan.io/tx/${HASH}` }]);
  });

  it('submitted → confirmed → failed: each says what it means and whether money was at risk', () => {
    expect(render(mintSubmittedCard({ ...facts, hash: HASH })).html).toContain('it is not final yet');
    const confirmed = render(mintConfirmedCard({ ...facts, hash: HASH, feePaid: '0.0004 ETH' })).html;
    expect(confirmed).toContain('MINT CONFIRMED</b> · INFO');
    expect(confirmed).toContain('<b>Network fee paid:</b> <b>0.0004 ETH</b>');
    const failed = render(mintFailedCard({ ...facts, hash: HASH, reason: 'PRICE_ABOVE_LIMIT' })).html;
    expect(failed).toContain('MINT FAILED</b> · CRITICAL');
    expect(failed).toContain('the mint price is above your limit [PRICE_ABOVE_LIMIT]');
    expect(failed).toContain('A failed transaction can still cost a network fee.');
  });

  it('blocked: nothing was bought. Unknown result: tells the owner not to send it again by hand and keeps new mints blocked', () => {
    expect(render(mintBlockedCard({ ...facts, reason: 'SPEND_CAP_EXCEEDED' })).html).toContain('nothing was bought or spent.');
    const unknown = render(ambiguousSubmissionCard({ ...facts, hash: HASH }));
    expect(unknown.html).toContain('MINT RESULT UNKNOWN</b> · CRITICAL');
    expect(unknown.html).toContain('do not send it again by hand');
    expect(unknown.buttons).toHaveLength(1);
    expect(render(ambiguousSubmissionCard(facts)).buttons).toEqual([]);
  });

  it('a malformed hash never becomes a link, and a failure without a hash still renders', () => {
    expect(render(mintFailedCard({ ...facts, hash: '0xnothash' })).buttons).toEqual([]);
    expect(render(mintFailedCard(facts)).html).toContain('MINT FAILED');
  });

  it('run started names the limits; the summary is critical when any mint is unknown and gives the totals', () => {
    expect(render(runStartedCard({ ...facts, walletCount: 4 })).html).toContain('only within your limits');
    const clean = render(runSummaryCard({ runId: 'run_7', chainId: 1, collection: 'Pudgy Example', confirmed: 4, failed: 0, blocked: 0, unknown: 0, spent: '0 ETH', feesPaid: '0.002 ETH', durationSeconds: 95, at })).html;
    expect(clean).toContain('LIVE RUN FINISHED</b> · INFO');
    expect(clean).toContain('<b>4 confirmed · 0 failed · 0 blocked · 0 unknown</b>');
    expect(clean).toContain('<b>Took:</b> 2 min');
    const bad = render(runSummaryCard({ runId: 'run_7', chainId: 1, collection: 'X', confirmed: 3, failed: 0, blocked: 0, unknown: 1, durationSeconds: 10, at })).html;
    expect(bad).toContain('· CRITICAL');
    expect(bad).toContain('At least one mint is unsettled.');
  });

  it('is not wired: no production file outside the barrel imports the templates', () => {
    const importers: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== 'dist') walk(path);
        else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') && !entry.name.endsWith('.test.ts') && /live-run-messages/.test(readFileSync(path, 'utf8'))) importers.push(entry.name);
      }
    };
    walk(join(__dirname, '..', '..'));
    expect(importers.sort()).toEqual(['index.ts']);
  });
});
