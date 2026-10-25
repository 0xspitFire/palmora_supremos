import { describe, expect, it } from 'vitest';
import { FLOW_LIFETIME_MS, GuidedFlows, flowNeedsSession, type FlowResult, type GuidedActions, type GuidedPlan } from './guided-flows.js';

/** T-073 (D-069): the guided flows follow the real order of the commands, check every custom entry, and a final tap acts once. */
const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const C = '0x3333333333333333333333333333333333333333';
const CONTRACT = '0xa686fde3299d5451af22382240e0dff62f7b94db';

function setup(over: Partial<GuidedActions> = {}) {
  let clock = new Date('2026-10-25T12:00:00.000Z');
  const calls: string[] = [];
  const plan = (quantity: number | undefined, count: number | undefined, ok = true): GuidedPlan => ({ text: `plan q=${quantity ?? '-'} n=${count ?? '-'}`, ok, ready: [A, B, C].slice(0, count ?? 3), quantity: quantity ?? 1, maxQuantity: 3, phrase: `PHRASE-${count ?? 3}` });
  const actions: GuidedActions = {
    guidedChains: async () => [{ key: 'ethereum', name: 'Ethereum' }, { key: 'robinhood', name: 'Robinhood' }],
    guidedPlan: async (chain, contract, quantity, count) => { calls.push(`plan(${chain},${contract},${quantity ?? ''},${count ?? ''})`); return plan(quantity, count); },
    guidedPrepare: async (chain, contract, quantity, wallets, expected) => { calls.push(`prepare(${chain},${contract},${quantity},${wallets.join('+')},${expected})`); return { text: 'Campaign recorded: cmp_new', campaignId: 'cmp_new' }; },
    releaseStatus: async () => ({ text: 'The kill switch is ON. Nothing blocks the release.', canRelease: true, phrase: 'RELEASE engaged T1' }),
    releaseNow: async (expected) => { calls.push(`release(${expected})`); return 'The kill switch is off.'; },
    simulateCampaign: async (campaignId) => { calls.push(`simulate(${campaignId})`); return { text: '2 wallet(s) passed the test mint. The records are good for 30 minutes.', recorded: [A, B], sized: 1 }; },
    requestCandidates: async () => [{ id: 'cmp_a', label: 'Robinhood 0xa686…94db · 1 NFT', note: '2 wallet(s) tested, about 25 min left' }],
    requestWallets: async () => ({ wallets: [A, B], sized: 1 }),
    requestPreview: async (campaignId, wallets, fee) => { calls.push(`requestPreview(${campaignId},${wallets},${fee})`); return { text: 'The service will arm and run the request.', phrase: `REQ-${wallets.split(',').length}`, wallets: wallets.split(',') }; },
    requestSend: async (campaignId, wallets, fee, expected) => { calls.push(`requestSend(${campaignId},${wallets},${fee},${expected})`); return 'Request sent.'; },
    cancellables: async () => [{ id: 'live_request_1', label: 'Request 000001 · 1 wallet(s)' }, { id: 'fire_schedule_2', label: 'Schedule 000002' }],
    cancel: async (id) => { calls.push(`cancel(${id})`); return `Cancelled ${id}.`; },
    funding: async (id) => { calls.push(`funding(${id})`); return `Funding for ${id}.`; },
    revokeChoices: async () => [{ key: 'base', name: 'Base' }, { key: 'robinhood', name: 'Robinhood' }],
    revokeStatus: async (chain) => ({ text: `Switching ${chain} off stops new runs.`, phrase: `REVOKE ${chain} rec1` }),
    revokeNow: async (chain, expected) => { calls.push(`revoke(${chain},${expected})`); return `${chain} is off.`; },
    watchChains: async () => [{ key: 'ethereum', name: 'Ethereum' }],
    watchWallets: async () => [A, B],
    watchStatus: async (chain, address) => ({ text: `The wallet ${address} on ${chain} now has 3 sent transactions.`, phrase: 'ACCEPT 3' }),
    watchAcceptNow: async (chain, address, expected) => { calls.push(`watchaccept(${chain},${address},${expected})`); return 'Accepted.'; },
    recentRuns: async () => [{ id: 'run_1', label: 'live · Completed · 10-25 12:00 UTC' }],
    run: async (id) => { calls.push(`run(${id})`); return `Run ${id} result.`; },
    guidedCampaigns: async () => [{ id: 'cmp_a', label: 'Robinhood 0xa686…94db · 1 NFT', note: 'mint is open' }, { id: 'cmp_b', label: 'Ethereum 0x1234…abcd · 1 NFT', note: 'mint not open yet; busy: queued' }],
    signingWallets: async () => [A, B],
    feeOptions: async (campaignId) => (campaignId === 'cmp_a' || campaignId === 'cmp_new' ? { presets: [0.1, 0.2], limit: 0.2, unit: 'gwei' } : { presets: [5, 10, 25], limit: undefined, unit: 'gwei' }),
    firePreview: async (campaignId, wallets, fee) => { calls.push(`firePreview(${campaignId},${wallets},${fee})`); return { text: 'The mint is OPEN. Fire now.', wallets: wallets === 'all' ? [A, B] : wallets.split(','), digest: 'd'.repeat(64) }; },
    fireNow: async (campaignId, wallets, fee, digest) => { calls.push(`fire(${campaignId},${wallets},${fee},${digest?.slice(0, 4)})`); return 'Request sent.'; },
    schedulePreview: async (campaignId, wallets, fee, from, until) => { calls.push(`schedulePreview(${campaignId},${wallets},${fee},${from},${until})`); return { text: 'Scheduled mint preview.', phrase: 'SCHEDULE abc 2-WALLETS 0.0004 0.2-GWEI', wallets: [A, B], from: '2026-10-25T12:00:00.000Z', until: '2026-10-25T14:00:00.000Z', digest: 'dg' }; },
    scheduleCreate: async (campaignId, wallets, fee, from, until, phrase, digest) => { calls.push(`schedule(${campaignId},${wallets},${fee},${from},${until},${phrase},${digest})`); return 'Scheduled mint stored.'; },
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
    expect(t.calls.at(-1)).toBe(`prepare(robinhood,${CONTRACT},2,${A}+${B},PHRASE-2)`);
    // The next step follows as a button (the test mints), not as a command to copy.
    expect(done.reply.text).toContain('Campaign recorded: cmp_new');
    expect(done.reply.text).not.toContain('/simulate');
    expect(done.reply.buttons?.flat().map((button) => button.text)).toEqual(['Record Test Mints', 'Cancel']);
    expect(done.done).toEqual({ command: 'prepare', outcome: 'ok' });
    // The same button cannot act twice.
    const again = await t.flows.onButton('abcd1234', '4go');
    expect(again.reply.text).toMatch(/expired|earlier step/);
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
    // The release is bound to the kill engagement that was shown: its phrase goes with the tap.
    expect(t.calls).toEqual(['release(RELEASE engaged T1)']);
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
    expect(t.calls.at(-1)).toBe(`schedule(cmp_a,${A},${B},0.2,2026-10-25T12:00:00.000Z,2026-10-25T14:00:00.000Z,SCHEDULE abc 2-WALLETS 0.0004 0.2-GWEI,dg)`);
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

describe('final taps are bound, short-lived and serialised (review fixes)', () => {
  it('a release refused because the kill switch was engaged again since it was shown says so and records the refusal', async () => {
    const t = setup({ releaseNow: async (expected) => { if (expected === 'RELEASE engaged T1') throw new Error('KILL_STATE_CHANGED: engaged again'); return 'x'; } });
    const done = await t.press(await t.flows.start('release'), 'Release The Kill Switch');
    expect(done.reply.text).toContain('Not done: KILL_STATE_CHANGED');
    expect(done.done).toEqual({ command: 'release', outcome: 'refused:KILL_STATE_CHANGED' });
  });

  it('a prepare whose plan changed since it was reviewed is refused with the reviewed phrase', async () => {
    const t = setup({ guidedPrepare: async (_c, _k, _q, _w, expected) => { if (expected === 'PHRASE-3') throw new Error('PLAN_CHANGED: the amount differs'); return { text: 'x', campaignId: undefined }; } });
    let step = await t.flows.start('prepare');
    step = await t.press(step, 'Ethereum');
    step = (await t.flows.onText(CONTRACT))!;
    step = await t.press(step, '1');
    step = await t.press(step, 'All ready (3)');
    const done = await t.press(step, 'Prepare (Spends Nothing)');
    expect(done.reply.text).toContain('PLAN_CHANGED');
    expect(done.done?.outcome).toBe('refused:PLAN_CHANGED');
  });

  it('the last tap is good for 2 minutes only, and a late tap changes nothing', async () => {
    const t = setup();
    const step = await t.flows.start('release');
    t.advance(2 * 60_000 + 1);
    const late = await t.press(step, 'Release The Kill Switch');
    expect(late.reply.text).toContain('expired');
    expect(late.done).toBeUndefined();
    expect(t.calls).toEqual([]);
    const fresh = await t.flows.start('release');
    t.advance(2 * 60_000 - 1);
    expect((await t.press(fresh, 'Release The Kill Switch')).done?.outcome).toBe('ok');
  });

  it('a Custom tap where there is no custom entry is refused, and two quick taps on one button act once', async () => {
    const t = setup();
    const release = await t.flows.start('release');
    const stray = /^\/f_([0-9a-f]{8})_(\d)x?/.exec(release.reply.buttons!.flat()[0]!.callback_data)!;
    expect((await t.flows.onButton(stray[1]!, `${stray[2]}cu`)).reply.text).toContain('no longer valid');
    const button = release.reply.buttons!.flat()[0]!.callback_data;
    const match = /^\/f_([0-9a-f]{8})_(.+)$/.exec(button)!;
    const [one, two] = await Promise.all([t.flows.onButton(match[1]!, match[2]!), t.flows.onButton(match[1]!, match[2]!)]);
    expect([one.done?.outcome, two.done?.outcome].filter(Boolean)).toEqual(['ok']);
    expect(t.calls.filter((call) => call.startsWith('release('))).toHaveLength(1);
  });

  it('a new flow replaces the old one, whose buttons then do nothing', async () => {
    const t = setup();
    const first = await t.flows.start('prepare');
    const old = first.reply.buttons!.flat()[0]!.callback_data;
    await t.flows.start('release');
    const match = /^\/f_([0-9a-f]{8})_(.+)$/.exec(old)!;
    expect(t.flows.active()).toBe('release');
    expect((await t.flows.onButton(match[1]!, match[2]!)).reply.text).toMatch(/earlier step|expired|no longer valid/);
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

describe('the steps after prepare are buttons too (T-074)', () => {
  it('prepare, then record the test mints, then choose the wallets for the request: nothing to copy at any point', async () => {
    const t = setup();
    let step = await t.flows.start('prepare');
    step = await t.press(step, 'Robinhood');
    step = (await t.flows.onText(CONTRACT))!;
    step = await t.press(step, '1');
    step = await t.press(step, 'All ready (3)');
    step = await t.press(step, 'Prepare (Spends Nothing)');
    expect(step.reply.text).toContain('Campaign recorded: cmp_new');
    expect(step.reply.text).toContain('Test mints only pass once the mint is open');
    step = await t.press(step, 'Record Test Mints');
    expect(t.calls.at(-1)).toBe('simulate(cmp_new)');
    expect(step.reply.text).toContain('2 wallet(s) passed the test mint');
    expect(step.reply.text).toContain('sized for 1 wallet(s)');
    expect(step.reply.buttons?.flat().map((button) => button.text)).toEqual(['All Tested (1)', '0x1111…1111', '0x2222…2222', 'Custom…', 'Cancel']);
    step = await t.press(step, 'All Tested (1)');
    step = await t.press(step, '0.2 gwei');
    expect(t.calls.at(-1)).toBe(`requestPreview(cmp_new,${A},0.2)`);
    expect(step.reply.buttons?.flat().map((button) => button.text)).toEqual(['Send Request', 'Cancel']);
    const sent = await t.press(step, 'Send Request');
    expect(t.calls.at(-1)).toBe(`requestSend(cmp_new,${A},0.2,REQ-1)`);
    expect(sent.done).toEqual({ command: 'request', outcome: 'ok' });
  });

  it('a request refuses a custom wallet list that has no fresh test mint or is longer than the campaign was sized for', async () => {
    const t = setup();
    let step = await t.flows.start('request');
    step = await t.press(step, 'Robinhood 0xa686…94db · 1 NFT');
    step = await t.press(step, 'Custom…');
    expect((await t.flows.onText(`${C}`))!.reply.text).toContain('has no fresh test mint on this campaign');
    expect((await t.flows.onText(`${A}, ${B}`))!.reply.text).toContain('sized for 1 wallet(s); you chose 2');
    step = (await t.flows.onText(A))!;
    expect(step.reply.text).toContain('Choose the fee ceiling');
  });

  it('a request is a read until its last tap: only that tap needs the unlocked session', () => {
    expect(flowNeedsSession('request', 'o1')).toBe(false);
    expect(flowNeedsSession('request', 'go')).toBe(true);
    expect(flowNeedsSession('release', 'go')).toBe(true);
    expect(flowNeedsSession('fire', 'o1')).toBe(true);
    expect(flowNeedsSession('prepare', 'go')).toBe(false);
    expect(flowNeedsSession('simulate', 'go')).toBe(false);
  });

  it('a command typed in full opens the summary with its button (no phrase to copy), and a changed request is refused at the tap', async () => {
    const t = setup();
    const summary = await t.flows.start('request', { campaign: 'cmp_a', wallets: 'all', fee: 0.2 });
    expect(summary.reply.text).toContain('The service will arm and run the request.');
    expect(t.calls.at(-1)).toBe(`requestPreview(cmp_a,${A},0.2)`);
    const refused = setup({ requestSend: async (_c, _w, _f, expected) => { if (expected === 'REQ-1') throw new Error('PLAN_CHANGED: the request changed'); return 'x'; } });
    const again = await refused.flows.start('request', { campaign: 'cmp_a', wallets: [A], fee: 0.2 });
    const done = await refused.press(again, 'Send Request');
    expect(done.done).toEqual({ command: 'request', outcome: 'refused:PLAN_CHANGED' });
    const scheduled = await t.flows.start('schedule', { campaign: 'cmp_a', wallets: 'all', fee: 0.2, from: 'now', until: '+2h' });
    expect(scheduled.reply.buttons?.flat().map((button) => button.text)).toEqual(['Store Schedule', 'Cancel']);
    const planned = await t.flows.start('prepare', { chain: 'robinhood', contract: CONTRACT });
    expect(planned.reply.text).toContain('How many NFTs per wallet?');
    const simulate = await t.flows.start('simulate', { campaign: 'cmp_a' });
    expect(simulate.reply.buttons?.flat().map((button) => button.text)).toEqual(['Record Test Mints', 'Cancel']);
  });

  it('typed /simulate in full records the test mints at once and goes straight on to the wallets', async () => {
    const t = setup();
    const result = await t.flows.runSimulate('cmp_a');
    expect(t.calls).toEqual(['simulate(cmp_a)']);
    expect(result.done).toEqual({ command: 'simulate', outcome: 'ok' });
    expect(result.reply.buttons?.flat().map((button) => button.text)).toContain('All Tested (1)');
    const failing = setup({ simulateCampaign: async () => { throw new Error('MINT_NOT_OPEN: the mint is upcoming'); } });
    expect((await failing.flows.runSimulate('cmp_a')).reply.text).toContain('Not done: MINT_NOT_OPEN');
  });

  it('cancel lists what can be cancelled and cancels the chosen one; funding shows the chosen campaign; each says so when there is nothing', async () => {
    const t = setup();
    let step = await t.flows.start('cancel');
    expect(step.reply.buttons?.flat().map((button) => button.text)).toEqual(['Request 000001 · 1 wallet(s)', 'Schedule 000002', 'Cancel']);
    step = await t.press(step, 'Schedule 000002');
    expect(t.calls.at(-1)).toBe('cancel(fire_schedule_2)');
    expect(step.done).toEqual({ command: 'cancel', outcome: 'ok' });
    const funding = await t.press(await t.flows.start('funding'), 'Robinhood 0xa686…94db · 1 NFT');
    expect(t.calls.at(-1)).toBe('funding(cmp_a)');
    expect(funding.reply.text).toBe('Funding for cmp_a.');
    const run = await t.press(await t.flows.start('run'), 'live · Completed · 10-25 12:00 UTC');
    expect(run.reply.text).toBe('Run run_1 result.');
    expect((await setup({ recentRuns: async () => [] }).flows.start('run')).reply.text).toBe('No runs yet.');
    expect((await setup({ cancellables: async () => [] }).flows.start('cancel')).reply.text).toContain('Nothing is waiting');
    expect((await setup({ requestCandidates: async () => [] }).flows.start('request')).reply.text).toContain('No campaign has fresh test mints');
  });
});

describe('revoke and watchaccept (D-070)', () => {
  it('revoke: pick the chain, see what it means, one button, bound to the record shown; nothing when no chain is on', async () => {
    const t = setup();
    let step = await t.flows.start('revoke');
    expect(step.reply.buttons?.flat().map((button) => button.text)).toEqual(['Base', 'Robinhood', 'Cancel']);
    step = await t.press(step, 'Robinhood');
    expect(step.reply.text).toContain('Switching robinhood off stops new runs.');
    const done = await t.press(step, 'Switch It Off');
    expect(t.calls.at(-1)).toBe('revoke(robinhood,REVOKE robinhood rec1)');
    expect(done.done).toEqual({ command: 'revoke', outcome: 'ok' });
    expect((await setup({ revokeChoices: async () => [] }).flows.start('revoke')).reply.text).toContain('Nothing to switch off');
    const changed = setup({ revokeNow: async () => { throw new Error('ENABLEMENT_CHANGED: a different record is current'); } });
    const refused = await changed.press(await changed.flows.start('revoke', { chain: 'base' }), 'Switch It Off');
    expect(refused.done).toEqual({ command: 'revoke', outcome: 'refused:ENABLEMENT_CHANGED' });
  });

  it('watchaccept: chain, wallet or a typed address (checked), the wallet as it is now, one button bound to that state', async () => {
    const t = setup();
    let step = await t.flows.start('watchaccept');
    step = await t.press(step, 'Ethereum');
    expect(step.reply.buttons?.flat().map((button) => button.text)).toEqual(['0x1111…1111', '0x2222…2222', 'Custom…', 'Cancel']);
    step = await t.press(step, 'Custom…');
    expect((await t.flows.onText('0x123'))!.reply.text).toContain('is not a wallet address');
    step = (await t.flows.onText(C))!;
    expect(step.reply.text).toContain(`The wallet ${C} on ethereum now has 3 sent transactions.`);
    const done = await t.press(step, 'Accept This Change');
    expect(t.calls.at(-1)).toBe(`watchaccept(ethereum,${C},ACCEPT 3)`);
    expect(done.done).toEqual({ command: 'watchaccept', outcome: 'ok' });
    expect((await t.flows.start('watchaccept', { chain: 'ethereum', address: 'nope' })).reply.text).toContain('ADDRESS_INVALID');
    const typedInFull = await t.flows.start('watchaccept', { chain: 'ethereum', address: A });
    expect(typedInFull.reply.buttons?.flat().map((button) => button.text)).toEqual(['Accept This Change', 'Cancel']);
  });

  it('only the watchaccept taps need the unlocked session; a revoke never does', () => {
    expect(flowNeedsSession('watchaccept', 'o1')).toBe(true);
    expect(flowNeedsSession('watchaccept', 'go')).toBe(true);
    expect(flowNeedsSession('revoke', 'go')).toBe(false);
  });
});

describe('the campaign id stays in view (T-074)', () => {
  it('shows the campaign id under the heading of every step once a campaign is chosen, and not twice right after prepare', async () => {
    const t = setup();
    let step = await t.flows.start('fire');
    step = await t.press(step, 'Robinhood 0xa686…94db · 1 NFT');
    expect(step.reply.text).toContain('Fire A Campaign · Step 2 Of 4\nCampaign: cmp_a');
    step = await t.press(step, 'All Signing Wallets (2)');
    expect(step.reply.text).toContain('Campaign: cmp_a');
    step = await t.press(step, '0.2 gwei');
    expect(step.reply.text).toContain('Campaign: cmp_a');
    let prepare = await t.flows.start('prepare');
    prepare = await t.press(prepare, 'Robinhood');
    prepare = (await t.flows.onText(CONTRACT))!;
    prepare = await t.press(prepare, '1');
    prepare = await t.press(prepare, 'All ready (3)');
    const recorded = await t.press(prepare, 'Prepare (Spends Nothing)');
    expect(recorded.reply.text.match(/cmp_new/g)?.length).toBe(1);
  });
});

describe('review fixes for the button steps (T-074)', () => {
  it('a command typed in full is held to the same fee rule as a Custom entry', async () => {
    const t = setup();
    expect((await t.flows.start('request', { campaign: 'cmp_a', wallets: 'all', fee: 0.5 })).reply.text).toContain('MAX_FEE_GWEI_ABOVE_LIMIT');
    expect((await t.flows.start('fire', { campaign: 'cmp_a', wallets: 'all', fee: 0 })).reply.text).toContain('MAX_FEE_GWEI_REQUIRED');
    expect((await t.flows.start('schedule', { campaign: 'cmp_a', wallets: 'all', fee: 0.9, from: 'now', until: '+2h' })).reply.text).toContain('MAX_FEE_GWEI_ABOVE_LIMIT');
    expect(t.calls.filter((call) => call.startsWith('requestPreview') || call.startsWith('schedulePreview'))).toEqual([]);
  });

  it('Record Test Mints is good for 2 minutes, and a refusal says to send /simulate when the mint is open', async () => {
    const t = setup();
    const step = await t.flows.start('simulate', { campaign: 'cmp_a' });
    t.advance(2 * 60_000 + 1);
    expect((await t.press(step, 'Record Test Mints')).reply.text).toContain('expired');
    expect(t.calls).toEqual([]);
    const closed = setup({ simulateCampaign: async () => { throw new Error('MINT_NOT_OPEN: the mint is upcoming'); } });
    const refused = await closed.press(await closed.flows.start('simulate', { campaign: 'cmp_a' }), 'Record Test Mints');
    expect(refused.reply.text).toContain('Send /simulate when the mint is open.');
    expect(refused.done).toEqual({ command: 'simulate', outcome: 'refused:MINT_NOT_OPEN' });
  });

  it('when the test mints are recorded but the wallet choices cannot be shown, it says so and keeps the outcome true', async () => {
    const t = setup({ requestWallets: async () => { throw new Error('RPC_DOWN: no answer'); } });
    const result = await t.flows.runSimulate('cmp_a');
    expect(result.reply.text).toContain('2 wallet(s) passed the test mint');
    expect(result.reply.text).toContain('The test mints are recorded; send /request to continue.');
    expect(result.done).toEqual({ command: 'simulate', outcome: 'ok' });
  });

  it('a cancel the service refused is recorded as refused', async () => {
    const t = setup({ cancel: async () => 'Not cancelled: that request is unknown, or the service already started it.' });
    const done = await t.press(await t.flows.start('cancel'), 'Request 000001 · 1 wallet(s)');
    expect(done.done).toEqual({ command: 'cancel', outcome: 'refused:NOT_CANCELLED' });
  });

  it('a request typed in full with more wallets than the campaign was sized for shows the sizing refusal and sends nothing', async () => {
    const t = setup({ requestPreview: async () => { throw new Error('PLANNED_EXPOSURE_INVALID: this campaign was sized for 1 wallet(s); you chose 2.'); } });
    const result = await t.flows.start('request', { campaign: 'cmp_a', wallets: [A, B], fee: 0.2 });
    expect(result.reply.text).toContain('sized for 1 wallet(s); you chose 2');
    expect(t.calls.some((call) => call.startsWith('requestSend'))).toBe(false);
  });
});
