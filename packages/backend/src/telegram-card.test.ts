import { describe, expect, it } from 'vitest';
import { AlertManager } from './alerts.js';
import { buildAlertCard, type AlertCard } from './alert-card.js';
import { NotificationDispatcher, type NotificationMessage, type NotificationSink } from './notifications.js';
import { DurableStore } from './store.js';
import { TelegramNotifier, type TelegramFetcher } from './telegram.js';

const CONTRACT = '0x3333333333333333333333333333333333333333';
const NOW = new Date('2026-10-03T14:03:22.000Z');
const LOCAL = 'http://127.0.0.1:8780/';

const card = (overrides: Partial<Parameters<typeof buildAlertCard>[0]> = {}): AlertCard => buildAlertCard({
  title: 'WORTH A LOOK · score 72/100', chainId: 1, contract: CONTRACT, collectionName: 'Pudgy Example', mint: 'free',
  fields: [{ label: 'Tracking Status', value: '1 of your watched wallets minted (Whale One)' }], notes: [], summary: 'Score 72/100',
  record: { kind: 'opportunity', id: `seadrop:1:${CONTRACT}` }, spottedAt: new Date(NOW.getTime() - 18_000), spottedLabel: 'the latest mint', ...overrides,
});

interface Sent { url: string; body: Record<string, unknown>; }
/** A fetcher that records every call and answers from a script of statuses (the last repeats). */
function recorder(statuses: number[] = [200], bodyOk = true) {
  const calls: Sent[] = [];
  const fetcher: TelegramFetcher = async (url, init) => {
    calls.push({ url, body: JSON.parse(init?.body ?? '{}') as Record<string, unknown> });
    const status = statuses[Math.min(calls.length - 1, statuses.length - 1)]!;
    return { ok: status >= 200 && status < 300, status, json: async () => ({ ok: bodyOk }) };
  };
  return { calls, fetcher };
}

const secretStore = { has: () => true, get: (name: string) => (name === 'TG_BOT_TOKEN' ? 'token-123' : '42') };
const notifier = (fetcher: TelegramFetcher, extra: { dashboardUrl?: string } = {}) => new TelegramNotifier({ secretStore, fetcher, now: () => NOW, ...extra });
const message = (extra: Partial<Parameters<TelegramNotifier['send']>[0]> = {}): Parameters<TelegramNotifier['send']>[0] => ({ eventId: 'notify_1', type: 'alert_opportunity', text: 'plain fallback text', ...extra });

describe('Telegram sender renders collection alerts (T-029)', () => {
  it('sends a formatted message with link buttons and no callback data, so nothing can come back to the bot', async () => {
    const { calls, fetcher } = recorder();
    await notifier(fetcher, { dashboardUrl: LOCAL }).send(message({ card: card() }));
    expect(calls).toHaveLength(1);
    const body = calls[0]!.body;
    expect(calls[0]!.url).toContain('/sendMessage');
    expect(body).toMatchObject({ chat_id: '42', parse_mode: 'HTML', disable_web_page_preview: true });
    expect(String(body.text)).toContain(`<a href="https://etherscan.io/address/${CONTRACT}">Pudgy Example</a>`);
    expect(String(body.text)).toContain(`<a href="http://127.0.0.1:8780/#home-opportunity-seadrop-1-${CONTRACT}">Dashboard record</a>`);
    expect(String(body.text).split('\n').at(-1)).toBe('<i>Sent 14:03:22 UTC, 18 s after the bot spotted the latest mint</i>');
    expect(body.reply_markup).toEqual({ inline_keyboard: [[{ text: 'Etherscan', url: `https://etherscan.io/address/${CONTRACT}` }, { text: 'OpenSea', url: `https://opensea.io/assets/ethereum/${CONTRACT}` }]] });
    expect(JSON.stringify(body)).not.toContain('callback');
  });

  it('computes the seconds at the moment of sending, so a late retry says so', async () => {
    const { calls, fetcher } = recorder();
    const late = new TelegramNotifier({ secretStore, fetcher, now: () => new Date(NOW.getTime() + 600_000) });
    await late.send(message({ card: card() }));
    expect(String(calls[0]!.body.text)).toContain('Sent 14:13:22 UTC, 618 s (10 min) after the bot spotted the latest mint');
  });

  it('leaves out the dashboard link when no dashboard address is set, and ignores an unsafe one', async () => {
    for (const extra of [{}, { dashboardUrl: 'javascript:alert(1)' }, { dashboardUrl: 'http://user:pass@x.example/' }]) {
      const { calls, fetcher } = recorder();
      await notifier(fetcher, extra).send(message({ card: card() }));
      expect(String(calls[0]!.body.text)).not.toContain('Dashboard record');
    }
  });

  it('sends a digest as one formatted message with no buttons', async () => {
    const { calls, fetcher } = recorder();
    await notifier(fetcher, { dashboardUrl: LOCAL }).send(message({ type: 'alert_digest', items: [{ text: 'a', card: card() }, { text: 'b <i>plain</i>' }] }));
    const body = calls[0]!.body;
    expect(body).toMatchObject({ parse_mode: 'HTML' });
    expect(body.reply_markup).toBeUndefined();
    expect(String(body.text)).toContain('<b>MintBot reminders (2)</b>');
    expect(String(body.text)).toContain('• b &lt;i&gt;plain&lt;/i&gt;');
  });

  it('still sends a message with no card exactly as before: plain text, redacted, no formatting', async () => {
    const { calls, fetcher } = recorder();
    await notifier(fetcher).send(message({ text: 'run started: r1 (3 wallets)' }));
    expect(calls[0]!.body).toEqual({ chat_id: '42', text: 'run started: r1 (3 wallets)', disable_web_page_preview: true });
  });

  it('still sends the stored plain text if rendering ever fails, so the alert is not lost', async () => {
    const { calls, fetcher } = recorder();
    const broken = { ...card(), fields: null } as unknown as AlertCard;
    await notifier(fetcher).send(message({ card: broken, text: 'stored plain text' }));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({ chat_id: '42', text: 'stored plain text', disable_web_page_preview: true });
  });

  it('resends the same facts as plain text when Telegram refuses the formatting, so an alert is never lost to markup', async () => {
    const { calls, fetcher } = recorder([400, 200]);
    await notifier(fetcher, { dashboardUrl: LOCAL }).send(message({ card: card() }));
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body.parse_mode).toBe('HTML');
    const retry = calls[1]!.body;
    expect(retry.parse_mode).toBeUndefined();
    expect(retry.reply_markup).toBeUndefined();
    expect(String(retry.text)).toContain(`https://etherscan.io/address/${CONTRACT}`);
    expect(String(retry.text)).toContain('Sent 14:03:22 UTC, 18 s after the bot spotted the latest mint');
    expect(String(retry.text)).not.toContain('<b>');
  });

  it('fails as before when the plain resend is refused too, and does not resend on any other failure', async () => {
    const both = recorder([400, 400]);
    await expect(notifier(both.fetcher).send(message({ card: card() }))).rejects.toThrow('TELEGRAM_DELIVERY_FAILED:400');
    expect(both.calls).toHaveLength(2);
    const server = recorder([500]);
    await expect(notifier(server.fetcher).send(message({ card: card() }))).rejects.toThrow('TELEGRAM_DELIVERY_FAILED:500');
    expect(server.calls).toHaveLength(1);
    const limited = recorder([429]);
    await expect(notifier(limited.fetcher).send(message({ card: card() }))).rejects.toThrow('TELEGRAM_DELIVERY_FAILED:429');
    expect(limited.calls).toHaveLength(1);
  });

  it('rejects a delivery Telegram accepted with ok:false in the body, formatted or plain', async () => {
    await expect(notifier(recorder([200], false).fetcher).send(message({ card: card() }))).rejects.toThrow('TELEGRAM_DELIVERY_REJECTED');
    await expect(notifier(recorder([200], false).fetcher).send(message())).rejects.toThrow('TELEGRAM_DELIVERY_REJECTED');
  });
});

describe('stored cards reach the sender on every attempt (T-029)', () => {
  function capture(failFirst = 0) {
    const sent: NotificationMessage[] = [];
    let failures = failFirst;
    const sink: NotificationSink = { send: async (item) => { sent.push(item); if (failures > 0) { failures -= 1; throw new Error('TELEGRAM_DELIVERY_FAILED:500'); } } };
    return { sent, sink };
  }
  const event = (id: string, data: Record<string, unknown>) => ({ id, type: 'alert_opportunity', at: NOW.toISOString(), data });

  it('passes the card from the stored event to the sink, next to the plain text', async () => {
    const { sent, sink } = capture();
    const dispatcher = new NotificationDispatcher(new DurableStore(), sink, { now: () => NOW });
    await dispatcher.dispatchEvent(event('evt_1', { card: card(), text: 'plain' }), 'plain');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ text: 'plain', card: { contract: CONTRACT, collectionName: 'Pudgy Example' } });
  });

  it('hands the card to the sink again on a retry, so it is rendered at the moment it is actually sent', async () => {
    const { sent, sink } = capture(1);
    const dispatcher = new NotificationDispatcher(new DurableStore(), sink, { now: () => NOW, retryBaseMs: 0 });
    await expect(dispatcher.dispatchEvent(event('evt_2', { card: card(), text: 'plain' }), 'plain')).rejects.toThrow('TELEGRAM_DELIVERY_FAILED:500');
    await dispatcher.dispatchPending();
    expect(sent).toHaveLength(2);
    expect(sent.map((item) => item.card?.contract)).toEqual([CONTRACT, CONTRACT]);
  });

  it('sends plain text for a malformed stored card, and for an event without one', async () => {
    const { sent, sink } = capture();
    const dispatcher = new NotificationDispatcher(new DurableStore(), sink, { now: () => NOW });
    await dispatcher.dispatchEvent(event('evt_3', { card: { v: 1, contract: 'nope' }, text: 'plain' }), 'plain');
    await dispatcher.dispatchEvent(event('evt_4', { text: 'plain' }), 'plain');
    expect(sent.map((item) => item.card)).toEqual([undefined, undefined]);
    expect(sent.map((item) => item.text)).toEqual(['plain', 'plain']);
  });

  it('keeps each alert\'s card in the digest, so the digest renders the same links, and old alerts without a card still list as text', async () => {
    const store = new DurableStore();
    const { sent, sink } = capture();
    const alerts = new AlertManager(store, new NotificationDispatcher(store, sink, { now: () => NOW }), undefined, { now: () => NOW });
    await alerts.intelligence({ kind: 'opening_soon', dedupe: 'a', text: 'with card', priority: 'grouped', card: card({ title: 'OPENING SOON' }) });
    await alerts.intelligence({ kind: 'underfunded', dedupe: 'b', text: 'without card', priority: 'grouped' });
    expect(await alerts.flushDigest()).toBe(2);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.items).toHaveLength(2);
    expect(sent[0]!.items?.[0]).toMatchObject({ text: 'with card', card: { title: 'OPENING SOON' } });
    expect(sent[0]!.items?.[1]).toEqual({ text: 'without card' });
    expect(sent[0]!.text).toContain('• with card');
    expect(sent[0]!.text).toContain('• without card');
  });

  it('sends an immediate alert with its card, and stores the card on the alert event', async () => {
    const store = new DurableStore();
    const { sent, sink } = capture();
    const alerts = new AlertManager(store, new NotificationDispatcher(store, sink, { now: () => NOW }), undefined, { now: () => NOW });
    expect(await alerts.intelligence({ kind: 'opportunity', dedupe: 'x', text: 'plain', priority: 'immediate', card: card() })).toBe(true);
    expect(sent[0]!.card?.collectionName).toBe('Pudgy Example');
    expect(store.snapshot().events.find((entry) => entry.type === 'alert_opportunity')?.data.card).toMatchObject({ v: 1, contract: CONTRACT });
  });
});
