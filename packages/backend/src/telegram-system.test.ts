import { describe, expect, it } from 'vitest';
import { AlertManager } from './alerts.js';
import { NotificationDispatcher, type NotificationMessage } from './notifications.js';
import { DurableStore } from './store.js';
import { TelegramNotifier, type TelegramFetcher } from './telegram.js';
import { mintSubmittedCard } from './live-run-messages.js';
import { killEngagedCard, spendCapCard, startCard } from './system-messages.js';

const NOW = new Date('2026-10-03T14:03:22.000Z');

interface Sent { url: string; body: Record<string, unknown>; }
function recorder(statuses: number[] = [200]) {
  const calls: Sent[] = [];
  const fetcher: TelegramFetcher = async (url, init) => {
    calls.push({ url, body: JSON.parse(init?.body ?? '{}') as Record<string, unknown> });
    const status = statuses[Math.min(calls.length - 1, statuses.length - 1)]!;
    return { ok: status >= 200 && status < 300, status, json: async () => ({ ok: true }) };
  };
  return { calls, fetcher };
}
const secretStore = { has: () => true, get: (name: string) => (name === 'TG_BOT_TOKEN' ? 'token-123' : '42') };
const notifier = (fetcher: TelegramFetcher, extra: { dashboardUrl?: string } = {}) => new TelegramNotifier({ secretStore, fetcher, now: () => NOW, ...extra });
const message = (extra: Partial<Parameters<TelegramNotifier['send']>[0]> = {}): Parameters<TelegramNotifier['send']>[0] => ({ eventId: 'notify_1', type: 'alert_kill', text: 'plain fallback text', ...extra });

describe('system messages reach Telegram formatted, with a plain fallback (T-030)', () => {
  const kill = () => killEngagedCard({ reason: 'KILL_SWITCH_ENGAGED', runId: 'run_1', at: new Date(NOW.getTime() - 2_000) });

  it('sends a system card as formatted text without callback data, with the delay computed at send time', async () => {
    const { calls, fetcher } = recorder();
    await notifier(fetcher).send(message({ system: kill() }));
    const body = calls[0]!.body;
    expect(body).toMatchObject({ chat_id: '42', parse_mode: 'HTML', disable_web_page_preview: true });
    expect(String(body.text)).toContain('<b>KILL SWITCH ENGAGED</b> · CRITICAL');
    expect(String(body.text).split('\n').at(-1)).toBe('<i>Sent 14:03:22 UTC, 2 s after the kill</i>');
    expect(JSON.stringify(body)).not.toContain('callback');
  });

  it('shows the dashboard link from the configured address, and the explorer button for a transaction', async () => {
    const { calls, fetcher } = recorder();
    const start = startCard({ mode: 'read-only', watched: 1, ownWallets: 1, at: NOW });
    await notifier(fetcher, { dashboardUrl: 'https://mint.example.org/' }).send(message({ system: start }));
    expect(String(calls[0]!.body.text)).toContain('<a href="https://mint.example.org/">Open</a>');
    const hash = `0x${'ab'.repeat(32)}`;
    await notifier(fetcher).send(message({ system: mintSubmittedCard({ runId: 'r', chainId: 1, collection: 'X', at: NOW, hash }) }));
    expect(calls[1]!.body.reply_markup).toEqual({ inline_keyboard: [[{ text: 'Transaction', url: `https://etherscan.io/tx/${hash}` }]] });
    expect(String(calls[1]!.body.text)).not.toContain(hash);
  });

  it('resends the same facts as redacted plain text when Telegram refuses the formatting', async () => {
    const { calls, fetcher } = recorder([400, 200]);
    await notifier(fetcher).send(message({ system: spendCapCard({ notice: 'SPEND_CAP_EXCEEDED', runId: 'run_1', at: NOW }), text: 'x' }));
    expect(calls).toHaveLength(2);
    const retry = calls[1]!.body;
    expect(retry.parse_mode).toBeUndefined();
    expect(String(retry.text)).toContain('SPEND CAP REACHED · CRITICAL');
    expect(String(retry.text)).not.toContain('<b>');
  });

  it('redacts a secret-shaped value in the plain resend', async () => {
    const { calls, fetcher } = recorder([400, 200]);
    const card = { ...kill(), lines: [{ label: 'What happened', value: `token=abcd1234 0x${'ab'.repeat(32)}` }] };
    await notifier(fetcher).send(message({ system: card }));
    expect(String(calls[1]!.body.text)).not.toContain('abcd1234');
    expect(String(calls[1]!.body.text)).not.toContain('ab'.repeat(32));
  });

  it('still sends the stored text if a system card cannot be rendered', async () => {
    const { calls, fetcher } = recorder();
    const broken = { ...kill(), lines: null } as never;
    await notifier(fetcher).send(message({ system: broken, text: 'stored plain text' }));
    expect(calls[0]!.body).toEqual({ chat_id: '42', text: 'stored plain text', disable_web_page_preview: true });
  });
});

describe('kill, cap and health events carry system cards (T-030)', () => {
  function manager() {
    const store = new DurableStore();
    const sent: NotificationMessage[] = [];
    const alerts = new AlertManager(store, new NotificationDispatcher(store, { send: async (item) => { sent.push(item); } }, { now: () => NOW }), undefined, { now: () => NOW });
    return { store, sent, alerts };
  }

  it('kill: the stored event and the sink get a card, and the plain text names the kill in words', async () => {
    const { store, sent, alerts } = manager();
    await alerts.kill('KILL_SWITCH_ENGAGED');
    expect(sent[0]!.system).toMatchObject({ kind: 'system', title: 'KILL SWITCH ENGAGED', severity: 'critical', eventAt: NOW.toISOString() });
    expect(sent[0]!.text).toContain('What happened: the kill switch was engaged [KILL_SWITCH_ENGAGED]');
    expect(store.snapshot().events.find((entry) => entry.type === 'alert_kill')?.data.system).toMatchObject({ v: 1, kind: 'system' });
  });

  it('cap: a code in the notice becomes words; free text in the notice is not copied', async () => {
    const { sent, alerts } = manager();
    await alerts.cap('FLEET_DAILY_CAP_EXCEEDED: wallet 0x1111111111111111111111111111111111111111 via https://u:p@rpc.example/path', 'run_3');
    const text = sent[0]!.text;
    expect(sent[0]!.system?.title).toBe('SPEND CAP REACHED');
    expect(text).toContain('daily, all wallets');
    expect(text).not.toContain('rpc.example');
    expect(text).not.toContain('0x1111');
  });

  it('a health alert is sent at once with its card, once per identity', async () => {
    const { sent, alerts } = manager();
    const system = killEngagedCard({ at: NOW });
    expect(await alerts.intelligence({ kind: 'health', dedupe: 'health:x:1:open', text: 'plain', priority: 'immediate', system })).toBe(true);
    expect(await alerts.intelligence({ kind: 'health', dedupe: 'health:x:1:open', text: 'plain', priority: 'immediate', system })).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.system?.title).toBe('KILL SWITCH ENGAGED');
  });

  it('a malformed stored system card goes out as plain text, never blocking the alert', async () => {
    const store = new DurableStore();
    const sent: NotificationMessage[] = [];
    const dispatcher = new NotificationDispatcher(store, { send: async (item) => { sent.push(item); } }, { now: () => NOW });
    await dispatcher.dispatchEvent({ id: 'evt_bad', type: 'alert_health', at: NOW.toISOString(), data: { system: { v: 1, kind: 'system', title: '', severity: 'critical' }, text: 'plain' } }, 'plain');
    expect(sent[0]!.system).toBeUndefined();
    expect(sent[0]!.text).toBe('plain');
  });
});
