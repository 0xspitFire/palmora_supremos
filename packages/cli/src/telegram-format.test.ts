import { describe, expect, it } from 'vitest';
import { createTelegramBotApi } from './telegram-api.js';
import { escapeHtml, toCopyableHtml } from './telegram-format.js';

/** T-069: copy-friendly replies. Escaping first means nothing from outside can add markup. */
const ADDRESS = '0x81c104dcb898416fd4f81ead091dba5b8f46f37a';
const CAMPAIGN = 'cmp_7f3a1c2e-1111-4222-8333-444455556666';

describe('copy formatting', () => {
  it('wraps ids, addresses and whole command lines, and leaves other text alone', () => {
    const text = toCopyableHtml(`Campaign recorded: ${CAMPAIGN}\nWallet ${ADDRESS} holds 1\nTo send it, within 15 minutes:\n/confirm LIVE-REQUEST abc12345 1-WALLETS 0.0002 0.2-GWEI\nRun run_0a1b2c3d-aaaa-bbbb-cccc-ddddeeeeffff and live_request_0123456789abcdef`);
    expect(text).toContain(`<b>Campaign Recorded:</b> <code>${CAMPAIGN}</code>`);
    expect(text).toContain(`Wallet <code>${ADDRESS}</code> holds 1`);
    expect(text).toContain('\n<code>/confirm LIVE-REQUEST abc12345 1-WALLETS 0.0002 0.2-GWEI</code>\n');
    expect(text).toContain('<code>run_0a1b2c3d-aaaa-bbbb-cccc-ddddeeeeffff</code>');
    expect(text).toContain('<code>live_request_0123456789abcdef</code>');
    expect(text).toContain('To send it, within 15 minutes:');
  });

  it('bolds and capitalises the words before a colon, and leaves sentences, times and links alone (T-071)', () => {
    expect(toCopyableHtml('Mode: LIVE (host)\nKill switch: ON (nothing can be spent)\nLive requests waiting: 0\nWhat to do:')).toBe('<b>Mode:</b> LIVE (host)\n<b>Kill Switch:</b> ON (nothing can be spent)\n<b>Live Requests Waiting:</b> 0\n<b>What To Do:</b>');
    expect(toCopyableHtml('Ethereum:')).toBe('<b>Ethereum:</b>');
    expect(toCopyableHtml('Not done: <b>x</b>')).toBe('<b>Not Done:</b> &lt;b&gt;x&lt;/b&gt;');
    // Not labels: a sentence, a time, a link, a bullet, a line with digits before the colon.
    for (const plain of ['Drop and wallets are ready: up to 2 wallets can mint', 'Sent 18:49:52 UTC, 0 s after it was blocked', 'See https://example.org/x', '• 0x3659…061e: it holds too little ETH', 'To send it, within 15 minutes:', 'Everything your 3 signing wallet(s) hold (x): y']) {
      expect(toCopyableHtml(plain), plain).not.toContain('<b>');
    }
  });

  it('does not wrap help lines or inline command mentions', () => {
    expect(toCopyableHtml('/status — Mode, kill switch')).toBe('/status — Mode, kill switch');
    expect(toCopyableHtml('Follow it with /requests and /runs.')).toBe('Follow it with /requests and /runs.');
  });

  it('escapes markup from outside text, including inside a command line and next to an id', () => {
    expect(toCopyableHtml('Name <b>x</b> & <script>')).toBe('Name &lt;b&gt;x&lt;/b&gt; &amp; &lt;script&gt;');
    expect(toCopyableHtml('/track 0x1 <a href="x">y</a>')).toBe('<code>/track 0x1 &lt;a href="x"&gt;y&lt;/a&gt;</code>');
    expect(toCopyableHtml(`${CAMPAIGN}<i>`)).toBe(`<code>${CAMPAIGN}</code>&lt;i&gt;`);
    expect(escapeHtml('a<b>&')).toBe('a&lt;b&gt;&amp;');
  });
});

describe('sendMessage formatting and fallback', () => {
  const fake = (statuses: number[]) => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetcher = async (_url: string, init?: { body?: unknown }) => { bodies.push(JSON.parse(String(init?.body))); const status = statuses.shift() ?? 200; return { ok: status === 200, status, json: async () => ({ ok: status === 200, result: true }) }; };
    return { bodies, api: createTelegramBotApi({ token: ['123', 'abcdef'].join(':'), fetcher: fetcher as never }) };
  };

  it('sends HTML with the copy blocks, and keeps the buttons', async () => {
    const t = fake([]);
    await t.api.sendMessage(1, `Campaign ${CAMPAIGN}`, [[{ text: 'Go', callback_data: '/status' }]]);
    expect(t.bodies).toHaveLength(1);
    expect(t.bodies[0]).toMatchObject({ parse_mode: 'HTML', text: `Campaign <code>${CAMPAIGN}</code>`, reply_markup: { inline_keyboard: [[{ text: 'Go', callback_data: '/status' }]] } });
  });

  it('resends the plain text when Telegram refuses the formatted one (400), so a reply is never lost', async () => {
    const t = fake([400, 200]);
    await t.api.sendMessage(1, `Campaign ${CAMPAIGN}`);
    expect(t.bodies).toHaveLength(2);
    expect(t.bodies[1]).toEqual({ chat_id: 1, disable_web_page_preview: true, text: `Campaign ${CAMPAIGN}` });
  });

  it('does not resend on other failures, and sends plain text when the formatted version would be too long', async () => {
    const down = fake([500]);
    await expect(down.api.sendMessage(1, 'x')).rejects.toThrow('TELEGRAM_SENDMESSAGE_FAILED:500');
    expect(down.bodies).toHaveLength(1);
    const long = fake([]);
    await long.api.sendMessage(1, `${ADDRESS} `.repeat(95));
    expect(long.bodies).toHaveLength(1);
    expect(long.bodies[0]).not.toHaveProperty('parse_mode');
  });
});
