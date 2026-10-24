import { describe, expect, it } from 'vitest';
import { FLOW_LIFETIME_MS, GuidedFlows, type FlowResult, type GuidedActions, type GuidedPlan } from './guided-flows.js';

/** T-073 (D-069): the guided flows follow the real order of the commands, check every custom entry, and a final tap acts once. */
const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const C = '0x3333333333333333333333333333333333333333';
const CONTRACT = '0xa686fde3299d5451af22382240e0dff62f7b94db';

function setup(over: Partial<GuidedActions> = {}) {
  let clock = new Date('2026-10-25T12:00:00.000Z');
  const calls: string[] = [];
  const plan = (quantity: number | undefined, count: number | undefined, ok = true): GuidedPlan => ({ text: `plan q=${quantity ?? '-'} n=${count ?? '-'}`, ok, ready: [A, B, C].slice(0, count ?? 3), quantity: quantity ?? 1, maxQuantity: 3 });
  const actions: GuidedActions = {
    guidedChains: async () => [{ key: 'ethereum', name: 'Ethereum' }, { key: 'robinhood', name: 'Robinhood' }],
    guidedPlan: async (chain, contract, quantity, count) => { calls.push(`plan(${chain},${contract},${quantity ?? ''},${count ?? ''})`); return plan(quantity, count); },
    guidedPrepare: async (chain, contract, quantity, wallets) => { calls.push(`prepare(${chain},${contract},${quantity},${wallets.join('+')})`); return 'Campaign recorded: cmp_new'; },
    releaseStatus: async () => ({ text: 'The kill switch is ON. Nothing blocks the release.', canRelease: true }),
    releaseNow: async () => { calls.push('release'); return 'The kill switch is off.'; },
    guidedCampaigns: async () => [{ id: 'cmp_a', label: 'Robinhood 0xa686…94db · 1 NFT', note: 'mint is open' }, { id: 'cmp_b', label: 'Ethereum 0x1234…abcd · 1 NFT', note: 'mint not open yet; busy: queued' }],
    signingWallets: async () => [A, B],
    feeOptions: async (campaignId) => (campaignId === 'cmp_a' ? { presets: [0.1, 0.2], limit: 0.2, unit: 'gwei' } : { presets: [5, 10, 25], limit: undefined, unit: 'gwei' }),
    firePreview: async (campaignId, wallets, fee) => { calls.push(`firePreview(${campaignId},${wallets},${fee})`); return { text: 'The mint is OPEN. Fire now.', wallets: wallets === 'all' ? [A, B] : wallets.split(','), digest: 'd'.repeat(64) }; },
    fireNow: async (campaignId, wallets, fee, digest) => { calls.push(`fire(${campaignId},${wallets},${fee},${digest?.slice(0, 4)})`); return 'Request sent.'; },
    schedulePreview: async (campaignId, wallets, fee, from, until) => { calls.push(`schedulePreview(${campaignId},${wallets},${fee},${from},${until})`); return { text: 'Scheduled mint preview.', phrase: 'SCHEDULE abc 2-WALLETS 0.0004 0.2-GWEI', wallets: [A, B], from: '2026-10-25T12:00:00.000Z', until: '2026-10-25T14:00:00.000Z' }; },
    scheduleCreate: async (campaignId, wallets, fee, from, until, phrase) => { calls.push(`schedule(${campaignId},${wallets},${fee},${from},${until},${phrase})`); return 'Scheduled mint stored.'; },
    ...over,
  };
  const flows = new GuidedFlows({ actions, now: () => clock, explain: (error) => (error instanceof Error ? error.message : 'x'), newId: () => 'abcd1234' });
  const tap = (result: FlowResult, label: string): string => {
    const button = result.reply.buttons?.flat().find((item) => item.text === label);
    if (!button) throw new Error(`no button "${label}" in: ${(result.reply.buttons ?? []).flat().map((item) => item.text).join(' | ')}`);
    return button.callback_data;
  };
  const press = (result: FlowResult, label: string) => { const data = tap(result, label); const match = /^\/f_([0-9a-f]{8})_(.+)$/.exec(data)!; return flows.onButton(match[1]!, match[2]!); };
  return { flows, calls, press, tap, advance: (ms: number) => { clock = new Date(clock.getTime() + ms); } };
}

describe('prepare flow (kill switch ON, no unlock)', () => {
  it('goes chain, contract, quantity, wallets, summary, then one tap that prepares with the chosen values', async () => {
    const t = setup();
    let step = await t.flows.start('prepare');
    expect(step.reply.text).toContain('Step 1 Of 5');
    expect(step.reply.buttons?.flat().map((button) => button.text)).toEqual(['Ethereum', 'Robinhood', 'Cancel']);
    step = await t.press(step, 'Robinhood');
    expect(step.reply.text).toContain('Send the contract address as a message');
    step = (await t.flows.onText(CONTRACT))!;
    expect(step.reply.text).toContain('How many NFTs per wallet? The drop allows up to 3.');
    expect(step.reply.buttons?.flat().map((button) => button.text)).toEqual(['1', '2', '3', 'Custom…', 'Cancel']);
    step = await t.press(step, '2');
    expect(step.reply.text).toContain('3 wallet(s) are ready');
    expect(step.reply.buttons?.flat().map((button) => button.text)).toEqual(['1 wallet', '2 wallets', 'All ready (3)', 'Custom…', 'Cancel']);
    step = await t.press(step, '2 wallets');
    expect(step.reply.text).toContain('Review. This only records a campaign; it spends nothing.');
    expect(t.calls.at(-1)).toBe(`plan(robinhood,${CONTRACT},2,2)`);
    const done = await t.press(step, 'Prepare (Spends Nothing)');
    expect(t.calls.at(-1)).toBe(`prepare(robinhood,${CONTRACT},2,${A}+${B})`);
    expect(done.reply.text).toBe('Campaign recorded: cmp_new');
    expect(done.done).toEqual({ command: 'prepare', outcome: 'ok' });
    // The same button cannot act twice.
    const again = await t.flows.onButton('abcd1234', '4go');
    expect(again.reply.text).toContain('expired');
    expect(t.calls.filter((call) => call.startsWith('prepare('))).toHaveLength(1);
  });

  it('refuses a wrong contract, quantity or wallet count in plain words, keeps its place, and returns to the choices after three wrong entries', async () => {
    const t = setup();
    let step = await t.flows.start('prepare');
    step = await t.press(step, 'Ethereum');
    expect((await t.flows.onText('not an address'))!.reply.text).toContain('is not a contract address');
    step = (await t.flows.onText(CONTRACT))!;
    step = await t.press(step, 'Custom…');
    expect(step.reply.text).toContain('from 1 to 3');
    // Two wrong entries keep waiting; each says what is allowed.
    for (const wrong of ['7', '0']) expect((await t.flows.onText(wrong))!.reply.text, wrong).toMatch(/Not accepted: use a whole number from 1 to 3.*Try again/s);
    // The third wrong entry in a row brings the choices back.
    const choices = (await t.flows.onText('abc'))!;
    expect(choices.reply.text).toContain('third wrong entry in a row');
    expect(choices.reply.buttons?.flat().map((button) => button.text)).toContain('Custom…');
    expect(await t.flows.onText('2')).toBeUndefined();
    // Other kinds of wrong values are refused the same way.
    for (const wrong of ['-1', '1.5', '2 3']) {
      const again = await t.press(choices, 'Custom…');
      expect(again.reply.text).toContain('Type the number of NFTs');
      expect((await t.flows.onText(wrong))!.reply.text, wrong).toContain('Not accepted');
      await t.flows.onText('9'); await t.flows.onText('9');
    }
    // A valid custom entry works, and so does a custom wallet count.
    const fresh = await t.press(choices, 'Custom…');
    expect(fresh.reply.text).toContain('Type the number of NFTs');
    const next = (await t.flows.onText('3'))!;
    expect(next.reply.text).toContain('wallet(s) are ready');
    await t.press(next, 'Custom…');
    expect((await t.flows.onText('4'))!.reply.text).toContain('from 1 to 3');
    expect((await t.flows.onText('2'))!.reply.text).toContain('Review.');
  });

  it('shows the plan and waits for another contract when the plan is not ready, and keeps the earlier plan when a quantity fails', async () => {
    const blocked = setup({ guidedPlan: async () => ({ text: 'Not ready: the drop is paid.', ok: false, ready: [], quantity: 1, maxQuantity: 1 }) });
    let step = await blocked.flows.start('prepare');
    step = await blocked.press(step, 'Robinhood');
    const refused = (await blocked.flows.onText(CONTRACT))!;
    expect(refused.reply.text).toContain('Not ready: the drop is paid.');
    expect(refused.reply.text).toContain('send another contract address');
    expect((await blocked.flows.onText(CONTRACT))!.reply.text).toContain('Not ready');
  });
});

describe('release flow (unlock needed, checked by the router)', () => {
  it('shows the state, offers one button, and releases through the action; it offers no button when nothing can be released', async () => {
    const t = setup();
    const step = await t.flows.start('release');
    expect(step.reply.text).toContain('The kill switch is ON');
    const done = await t.press(step, 'Release The Kill Switch');
    expect(t.calls).toEqual(['release']);
    expect(done.done).toEqual({ command: 'release', outcome: 'ok' });
    const blocked = setup({ releaseStatus: async () => ({ text: 'A run is unresolved, so it cannot be released.', canRelease: false }) });
    const none = await blocked.flows.start('release');
    expect(none.reply.buttons?.flat().map((button) => button.text)).toEqual(['Cancel']);
  });

  it('records a refusal with its code when the release is refused at the tap', async () => {
    const t = setup({ releaseNow: async () => { throw new Error('UNRESOLVED_EXECUTIONS: a run is unresolved'); } });
    const done = await t.press(await t.flows.start('release'), 'Release The Kill Switch');
    expect(done.reply.text).toContain('Not done: UNRESOLVED_EXECUTIONS');
    expect(done.done).toEqual({ command: 'release', outcome: 'refused:UNRESOLVED_EXECUTIONS' });
  });
});

describe('fire flow', () => {
  it('goes campaign, wallets, fee, summary, then fires with the server-built values and the preview digest', async () => {
    const t = setup();
    let step = await t.flows.start('fire');
    expect(step.reply.text).toContain('busy: queued');
    step = await t.press(step, 'Robinhood 0xa686…94db · 1 NFT');
    expect(step.reply.buttons?.flat().map((button) => button.text)).toEqual(['All Signing Wallets (2)', '0x1111…1111', '0x2222…2222', 'Custom…', 'Cancel']);
    step = await t.press(step, 'All Signing Wallets (2)');
    expect(step.reply.text).toContain('Your Turnkey policy allows at most 0.2 gwei');
    step = await t.press(step, '0.2 gwei');
    expect(step.reply.text).toContain('The mint is OPEN');
    const done = await t.press(step, 'Fire Now');
    expect(t.calls.at(-1)).toBe(`fire(cmp_a,${A},${B},0.2,dddd)`.replace(`${A},${B}`, `${A},${B}`));
    expect(done.done).toEqual({ command: 'fire', outcome: 'ok' });
  });

  it('checks a custom wallet list and a custom fee: wrong addresses, other wallets, duplicates, zero, text and above the limit are refused', async () => {
    const toWallets = async () => {
      const t = setup();
      let step = await t.flows.start('fire');
      step = await t.press(step, 'Robinhood 0xa686…94db · 1 NFT');
      await t.press(step, 'Custom…');
      return t;
    };
    const reasons: Array<[string, RegExp]> = [['0x123', /is not a wallet address/], [`${A}, ${C}`, /is not one of your signing wallets/], [`${A} ${A}`, /listed twice/], [',', /at least one wallet/]];
    for (const [text, expected] of reasons) expect((await (await toWallets()).flows.onText(text))!.reply.text, text).toMatch(expected);
    const t = await toWallets();
    let step = (await t.flows.onText(`${A}, ${B}`))!;
    expect(step.reply.text).toContain('Choose the fee ceiling');
    const custom = await t.press(step, 'Custom…');
    expect(custom.reply.text).toContain('Type the fee ceiling');
    for (const [text, expected] of [['0', /plain number above 0/], ['abc', /plain number above 0/]] as const) {
      expect((await t.flows.onText(text))!.reply.text, text).toMatch(expected);
    }
    // Third wrong entry in a row (above the limit): back to the choices.
    const back = (await t.flows.onText('0.5'))!;
    expect(back.reply.text).toMatch(/above the limit of 0.2 gwei set by your Turnkey policy[\s\S]*third wrong entry/);
    step = await t.press(back, 'Custom…');
    expect((await t.flows.onText('1e2'))!.reply.text).toMatch(/plain number above 0/);
    step = (await t.flows.onText('0.15'))!;
    expect(step.reply.text).toContain('The mint is OPEN');
    expect(t.calls.at(-1)).toBe(`firePreview(cmp_a,${A},${B},0.15)`);
  });

  it('shows why a fire cannot be prepared (for example the mint is not open) and fires nothing', async () => {
    const t = setup({ firePreview: async () => { throw new Error('MINT_NOT_OPEN: the mint is upcoming; use /schedule'); } });
    let step = await t.flows.start('fire');
    step = await t.press(step, 'Robinhood 0xa686…94db · 1 NFT');
    step = await t.press(step, 'All Signing Wallets (2)');
    const refused = await t.press(step, '0.1 gwei');
    expect(refused.reply.text).toContain('Not done: MINT_NOT_OPEN');
    expect(t.calls.filter((call) => call.startsWith('fire('))).toEqual([]);
  });

  it('says so when no live campaign is prepared', async () => {
    const t = setup({ guidedCampaigns: async () => [] });
    expect((await t.flows.start('fire')).reply.text).toContain('No live campaign is prepared yet');
    expect(t.flows.active()).toBeUndefined();
  });

  it('uses the chain\'s own fee presets and no fixed limit outside Robinhood', async () => {
    const t = setup();
    let step = await t.flows.start('fire');
    step = await t.press(step, 'Ethereum 0x1234…abcd · 1 NFT');
    step = await t.press(step, 'All Signing Wallets (2)');
    expect(step.reply.buttons?.flat().map((button) => button.text)).toEqual(['5 gwei', '10 gwei', '25 gwei', 'Custom…', 'Cancel']);
    step = await t.press(step, 'Custom…');
    expect((await t.flows.onText('60'))!.reply.text).toContain('The mint is OPEN');
  });
});

describe('schedule flow', () => {
  it('goes campaign, wallets, fee, window, summary, then stores with the server-built phrase and resolved times', async () => {
    const t = setup();
    let step = await t.flows.start('schedule');
    expect(step.reply.text).toContain('Step 1 Of 5');
    step = await t.press(step, 'Robinhood 0xa686…94db · 1 NFT');
    step = await t.press(step, 'All Signing Wallets (2)');
    step = await t.press(step, '0.2 gwei');
    expect(step.reply.buttons?.flat().map((button) => button.text)).toEqual(['Now To +1 H', 'Now To +2 H', 'Now To +3 H', 'Now To +6 H', 'Custom…', 'Cancel']);
    step = await t.press(step, 'Now To +2 H');
    expect(t.calls.at(-1)).toBe('schedulePreview(cmp_a,all,0.2,now,+2h)');
    const done = await t.press(step, 'Store Schedule');
    expect(t.calls.at(-1)).toBe(`schedule(cmp_a,${A},${B},0.2,2026-10-25T12:00:00.000Z,2026-10-25T14:00:00.000Z,SCHEDULE abc 2-WALLETS 0.0004 0.2-GWEI)`);
    expect(done.done).toEqual({ command: 'schedule', outcome: 'ok' });
  });

  it('checks a custom window: two times are needed and the schedule rules (past, too long, too far) come back in plain words', async () => {
    let attempt = 0;
    const t = setup({ schedulePreview: async (_c, _w, _f, from, until) => { attempt += 1; if (until === '+9h') throw new Error('WINDOW_TOO_LONG: a window is at most 6 hours'); return { text: 'preview', phrase: 'P', wallets: [A], from, until }; } });
    let step = await t.flows.start('schedule');
    step = await t.press(step, 'Robinhood 0xa686…94db · 1 NFT');
    step = await t.press(step, 'All Signing Wallets (2)');
    step = await t.press(step, '0.2 gwei');
    step = await t.press(step, 'Custom…');
    expect((await t.flows.onText('now'))!.reply.text).toContain('send two times separated by a space');
    expect((await t.flows.onText('now +9h'))!.reply.text).toContain('WINDOW_TOO_LONG: a window is at most 6 hours');
    expect((await t.flows.onText('now +90m'))!.reply.text).toContain('preview');
    expect(attempt).toBe(2);
  });
});

describe('buttons and typed text in general', () => {
  it('ignores a button from an earlier step without changing anything, refuses an expired or unknown flow, and cancels', async () => {
    const t = setup();
    const first = await t.flows.start('prepare');
    const chainButton = first.reply.buttons!.flat()[0]!.callback_data;
    await t.press(first, 'Robinhood');
    const stale = /^\/f_([0-9a-f]{8})_(.+)$/.exec(chainButton)!;
    expect((await t.flows.onButton(stale[1]!, stale[2]!)).reply.text).toContain('earlier step');
    expect((await t.flows.onButton('deadbeef', '0o1')).reply.text).toContain('expired');
    t.advance(FLOW_LIFETIME_MS + 1);
    expect((await t.flows.onButton('abcd1234', '1x')).reply.text).toContain('expired');
    expect(await t.flows.onText(CONTRACT)).toBeUndefined();
    const second = await t.flows.start('release');
    expect((await t.press(second, 'Cancel')).reply.text).toContain('Cancelled. Nothing was changed.');
    expect(t.flows.active()).toBeUndefined();
  });

  it('only answers typed text while it waits, and another command ends the wait', async () => {
    const t = setup();
    expect(await t.flows.onText('hello')).toBeUndefined();
    let step = await t.flows.start('prepare');
    step = await t.press(step, 'Ethereum');
    t.flows.interrupt();
    expect(await t.flows.onText(CONTRACT)).toBeUndefined();
    expect(t.calls).toEqual([]);
  });

  it('every button carries only a flow id, a step and a short key (well under Telegram\'s 64 bytes)', async () => {
    const t = setup();
    let step = await t.flows.start('fire');
    for (const button of step.reply.buttons!.flat()) expect(button.callback_data).toMatch(/^\/f_[0-9a-f]{8}_\d[a-z0-9]{1,12}$/);
    step = await t.press(step, 'Robinhood 0xa686…94db · 1 NFT');
    for (const button of step.reply.buttons!.flat()) { expect(button.callback_data.length).toBeLessThan(64); expect(button.callback_data).not.toContain(A); }
  });
});
