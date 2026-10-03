import { describe, expect, it } from 'vitest';
import { buildAlertCard, chainDisplay, cleanCollectionName, cleanText, dashboardAnchor, dashboardLink, explorerAddressUrl, openSeaUrl, parseAlertCard, parseDigestItems, plainAlertText, renderAlertCard, renderDigest, type AlertCard, type AlertCardInput } from './alert-card.js';
import { redactText } from './observability.js';

const CONTRACT = '0x3333333333333333333333333333333333333333';
const NOW = new Date('2026-10-03T14:03:22.000Z');
const LOCAL = 'http://127.0.0.1:8780/';

function card(overrides: Partial<AlertCardInput> = {}): AlertCard {
  return buildAlertCard({
    title: 'WORTH A LOOK · score 72/100', chainId: 1, contract: CONTRACT, collectionName: 'Pudgy Example', mint: 'free',
    fields: [{ label: 'Tracking Status', value: '2 of your watched wallets minted (Whale One, 0xcd34…0001)' }, { label: 'Price', value: 'free' }],
    notes: [{ label: 'Why', value: 'Watched wallets agree.' }], summary: 'Score 72/100 · free', record: { kind: 'opportunity', id: `seadrop:1:${CONTRACT}` },
    spottedAt: new Date(NOW.getTime() - 18_000), spottedLabel: 'the latest mint', ...overrides,
  });
}

describe('alert card layout (T-029)', () => {
  it('renders the approved structure: bold title, the name linked to the explorer, full address, upper-case chain, fields, notes, links, sent line', () => {
    const { html } = renderAlertCard(card(), { now: NOW, dashboardUrl: LOCAL });
    expect(html.split('\n')).toEqual([
      '<b>WORTH A LOOK · score 72/100</b>',
      `<a href="https://etherscan.io/address/${CONTRACT}">Pudgy Example</a>`,
      `<code>${CONTRACT}</code>`,
      'ETHEREUM · FREE MINT',
      '',
      '<b>Tracking Status:</b> 2 of your watched wallets minted (Whale One, 0xcd34…0001)',
      '<b>Price:</b> free',
      '',
      '<b>Why:</b> Watched wallets agree.',
      '',
      `<a href="http://127.0.0.1:8780/#home-opportunity-seadrop-1-${CONTRACT}">Dashboard record</a> · Nothing is bought automatically.`,
      '<i>Sent 14:03:22 UTC, 18 s after the bot spotted the latest mint</i>',
    ]);
    expect(html).not.toContain('Who');
  });

  it('shows FREE MINT only for a free mint', () => {
    expect(renderAlertCard(card({ mint: 'paid' }), { now: NOW }).html).toContain('\nETHEREUM\n');
    expect(renderAlertCard(card({ mint: 'unknown' }), { now: NOW }).html).not.toContain('FREE MINT');
    expect(renderAlertCard(card({ mint: 'free' }), { now: NOW }).html).toContain('ETHEREUM · FREE MINT');
  });

  it.each([[1, 'ETH MINT', 'ETHEREUM', 'https://etherscan.io'], [4663, 'ROBIN MINT', 'ROBINHOOD', 'https://robinhoodchain.blockscout.com'], [8453, 'BASE MINT', 'BASE', 'https://basescan.org']])(
    'names a collection with no name by its chain: chain %i is %s, linked on %s', (chainId, label, chain, explorer) => {
      const { html } = renderAlertCard(card({ chainId, collectionName: null }), { now: NOW });
      expect(html).toContain(`<a href="${explorer}/address/${CONTRACT}">${label}</a>`);
      expect(html).toContain(`${chain} · FREE MINT`);
    });

  it('names an unknown chain "CHAIN <id> MINT" and links nothing, with no buttons', () => {
    const rendered = renderAlertCard(card({ chainId: 77, collectionName: null }), { now: NOW });
    expect(rendered.html).toContain('\nCHAIN 77 MINT\n');
    expect(rendered.html).not.toContain('<a href="https://');
    expect(rendered.buttons).toEqual([]);
  });

  it('adds link buttons: the explorer, and OpenSea only on chains OpenSea supports', () => {
    expect(renderAlertCard(card(), { now: NOW }).buttons).toEqual([{ text: 'Etherscan', url: `https://etherscan.io/address/${CONTRACT}` }, { text: 'OpenSea', url: `https://opensea.io/assets/ethereum/${CONTRACT}` }]);
    expect(renderAlertCard(card({ chainId: 4663 }), { now: NOW }).buttons).toEqual([{ text: 'Blockscout', url: `https://robinhoodchain.blockscout.com/address/${CONTRACT}` }]);
    expect(renderAlertCard(card({ chainId: 8453 }), { now: NOW }).buttons).toEqual([{ text: 'Basescan', url: `https://basescan.org/address/${CONTRACT}` }, { text: 'OpenSea', url: `https://opensea.io/assets/base/${CONTRACT}` }]);
    expect(openSeaUrl(4663, CONTRACT)).toBeUndefined();
    expect(explorerAddressUrl(1, 'not-an-address')).toBeUndefined();
  });

  it('builds the dashboard link from one setting, so a live address needs no code change, and ignores an unsafe one', () => {
    const rid = { kind: 'opportunity' as const, id: `seadrop:1:${CONTRACT}` };
    expect(dashboardLink('https://mintbot.example/app/', rid)).toBe(`https://mintbot.example/app/#home-opportunity-seadrop-1-${CONTRACT}`);
    expect(dashboardLink('http://[::1]:8780/', rid)).toBe(`http://[::1]:8780/#home-opportunity-seadrop-1-${CONTRACT}`);
    expect(dashboardLink('https://mintbot.example/app/')).toBe('https://mintbot.example/app/');
    // A query string in the configured address is never carried into an alert (it could hold a token).
    expect(dashboardLink('https://mintbot.example/app/?token=abc123#old', rid)).toBe(`https://mintbot.example/app/#home-opportunity-seadrop-1-${CONTRACT}`);
    for (const unsafe of ['javascript:alert(1)', 'ftp://x.example/', 'http://user:pass@x.example/', 'not a url', '']) expect(dashboardLink(unsafe, rid)).toBeUndefined();
    expect(renderAlertCard(card(), { now: NOW }).html).not.toContain('Dashboard record');
    expect(renderAlertCard(card(), { now: NOW, dashboardUrl: 'javascript:alert(1)' }).html).not.toContain('javascript');
    expect(dashboardAnchor({ kind: 'opportunity', id: 'seadrop:1:0xABC' })).toBe('home-opportunity-seadrop-1-0xabc');
    expect(dashboardAnchor({ kind: 'calendar', id: 'calendar:1:0xABC' })).toBe('home-calendar-calendar-1-0xabc');
  });

  it('ends with the sent time and the seconds since the bot spotted it, honestly large for a late retry or digest', () => {
    const last = (spottedMsAgo: number) => renderAlertCard(card({ spottedAt: NOW.getTime() - spottedMsAgo }), { now: NOW }).html.split('\n').at(-1);
    expect(last(18_000)).toBe('<i>Sent 14:03:22 UTC, 18 s after the bot spotted the latest mint</i>');
    expect(last(0)).toContain('0 s after');
    expect(last(300_000)).toContain('300 s (5 min) after');
    expect(last(-5_000)).toContain(', 0 s after');
    expect(renderAlertCard(card(), { now: NOW }).plain.split('\n').at(-1)).toBe('Sent 14:03:22 UTC, 18 s after the bot spotted the latest mint');
  });

  it('keeps the stored plain text free of a send time and with the explorer link and full address', () => {
    const plain = plainAlertText(card());
    expect(plain).toContain(`https://etherscan.io/address/${CONTRACT}`);
    expect(plain).toContain(CONTRACT);
    expect(plain).toContain('ETHEREUM · FREE MINT');
    expect(plain).not.toContain('Sent ');
    expect(plain).not.toContain('Dashboard record');
  });

  it('survives the existing secret-redaction filter unchanged: the address, the link and the footer', () => {
    const { html, plain } = renderAlertCard(card(), { now: NOW, dashboardUrl: LOCAL });
    expect(redactText(html)).toBe(html);
    expect(redactText(plain)).toBe(plain);
  });

  it('stays under the limits even when escaping makes every character longer, in both forms', () => {
    const heavy = card({ fields: Array.from({ length: 6 }, (_, index) => ({ label: `F${index}`, value: '&'.repeat(400) })), notes: [{ label: 'Why', value: '<'.repeat(400) }] });
    const { html, plain } = renderAlertCard(heavy, { now: NOW, dashboardUrl: LOCAL });
    expect(html.length).toBeLessThanOrEqual(3_900);
    expect(plain.length).toBeLessThanOrEqual(1_900);
    expect(html.split('\n').at(-1)).toContain('Sent 14:03:22 UTC');
    expect(plain.split('\n').at(-1)).toContain('Sent 14:03:22 UTC');
    expect((html.match(/<a /g) ?? []).length).toBe((html.match(/<\/a>/g) ?? []).length);
  });

  it('keeps the plain-text form under the redaction filter\'s 2,000 characters, so the sent line and the links are never cut off', () => {
    const long = 'x'.repeat(400);
    const { plain } = renderAlertCard(card({ fields: Array.from({ length: 12 }, (_, index) => ({ label: `Field ${index}`, value: long })), notes: [{ label: 'Why', value: long }] }), { now: NOW, dashboardUrl: LOCAL });
    expect(plain.length).toBeLessThanOrEqual(1_900);
    expect(redactText(plain)).toBe(plain);
    expect(plain).toContain('Dashboard record: http://127.0.0.1:8780/');
    expect(plain.split('\n').at(-1)).toContain('Sent 14:03:22 UTC');
  });

  it('stays under the Telegram limit by dropping the least important lines, and never leaves a tag open', () => {
    const long = 'x'.repeat(400);
    const huge = card({ fields: Array.from({ length: 12 }, (_, index) => ({ label: `Field ${index}`, value: long })), notes: Array.from({ length: 4 }, (_, index) => ({ label: `Note ${index}`, value: long })) });
    const { html } = renderAlertCard(huge, { now: NOW, dashboardUrl: LOCAL });
    expect(html.length).toBeLessThanOrEqual(3_900);
    expect((html.match(/<a /g) ?? []).length).toBe((html.match(/<\/a>/g) ?? []).length);
    expect(html.startsWith('<b>')).toBe(true);
    expect(html.endsWith('</i>')).toBe(true);
    expect(html).toContain('<b>Field 0:</b>');
  });
});

describe('untrusted text from the chain (T-029)', () => {
  it('escapes markup in names and values so a message cannot be reshaped', () => {
    const { html } = renderAlertCard(card({ collectionName: '<b>"Free" & <a href="https://evil.example">x</a></b>', fields: [{ label: 'Price', value: '<script>alert(1)</script> & "quoted"' }] }), { now: NOW });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('href="https://evil.example"');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quoted&quot;');
    expect((html.match(/<a /g) ?? []).length).toBe(1);
  });

  it.each([
    ['  Pudgy   Example  ', 'Pudgy Example'],
    ['Cool\u202eNFT\u200b\u2060Club', 'CoolNFTClub'],
    ['\uff26\uff35\uff2e Club', 'FUN Club'],
    ['Line\none\r\ntwo', 'Line one two'],
    ['\u0000\u0007\u001b[31mRed', '[31mRed'],
    ['@everyone free mint', 'everyone free mint'],
    ['#1 Collection', '1 Collection'],
    ['https://evil.example/claim', 'https evil·example/claim'],
    ['visit www.evil.com now', 'visit www·evil·com now'],
    ['t.me/scam', 't·me/scam'],
    ['mint.eth', 'mint·eth'],
    ['Free @scammer drop', 'Free scammer drop'],
    ['claim.cc now', 'claim·cc now'],
    ['airdrop.top', 'airdrop·top'],
    ['mint.fun', 'mint·fun'],
    ['evil.example', 'evil·example'],
    ['$ETH airdrop', 'ETH airdrop'],
    ['/start now', 'start now'],
    ['Mail a@b.com', 'Mail ab·com'],
    ['Edition v1.2', 'Edition v1·2'],
    ['Call +15551234567', 'Call 1555 1234 567'],
    ['A\u{e0100}\u034f\u2800\u180bB', 'AB'],
    ['\u{e0041}\u{e0042}Tag', 'Tag'],
  ])('cleans the collection name %j to %j', (raw, cleaned) => {
    expect(cleanCollectionName(raw)).toBe(cleaned);
  });

  it('rejects empty or non-text names, and caps a long name at 40 characters', () => {
    for (const bad of ['', '   ', '\u200b\u200b', null, undefined, 42, {}]) expect(cleanCollectionName(bad)).toBeNull();
    const capped = cleanCollectionName('A'.repeat(200))!;
    expect(Array.from(capped)).toHaveLength(40);
    expect(capped.endsWith('…')).toBe(true);
    expect(Array.from(cleanText('\u{1f600}'.repeat(100), 10))).toHaveLength(10);
  });

  it('leaves no word in a name that Telegram could turn into a link, mention, hashtag, cashtag, command, e-mail or phone number', () => {
    for (const raw of ['Free @scammer drop', 'claim.cc now', 'a.dev', 'x.zip', 'mint.fun', '$BTC', '/start', 'a@b.co', '+1 555 123 4567 call', 'https://x.example', '#hash tag']) {
      const name = cleanCollectionName(raw) ?? '';
      expect(name).not.toMatch(/[@#$]|^\/|\s\/|\p{L}\.\p{L}|:\/\/|\d{7,}/u);
    }
  });

  it('never lets a name decide the link: the link comes from the table and the validated address only', () => {
    const { html, buttons } = renderAlertCard(card({ collectionName: 'https://evil.example"><a href="x' }), { now: NOW });
    expect(html.match(/href="([^"]+)"/g)).toEqual([`href="https://etherscan.io/address/${CONTRACT}"`]);
    expect(buttons.every((button) => button.url.startsWith('https://etherscan.io/') || button.url.startsWith('https://opensea.io/'))).toBe(true);
  });
});

describe('stored cards are parsed strictly (T-029)', () => {
  const good = (): Record<string, unknown> => JSON.parse(JSON.stringify(card()));

  it('accepts a round-tripped card and lower-cases the address', () => {
    expect(parseAlertCard(good())).toEqual(card());
    expect(parseAlertCard({ ...good(), contract: CONTRACT.toUpperCase().replace('0X', '0x') })?.contract).toBe(CONTRACT);
  });

  it.each([
    ['not an object', 'text'], ['null', null], ['an array', []], ['wrong version', { v: 2 }], ['bad address', { contract: '0x12' }], ['non-hex address', { contract: `0x${'g'.repeat(40)}` }],
    ['bad chain', { chainId: 0 }], ['fractional chain', { chainId: 1.5 }], ['text chain', { chainId: '1' }], ['no spotted time', { spottedAt: undefined }], ['bad spotted time', { spottedAt: 'yesterday' }], ['no title', { title: '' }], ['hidden-only title', { title: '\u200b' }],
  ])('refuses %s', (_name, patch) => {
    expect(parseAlertCard(typeof patch === 'object' && patch !== null && !Array.isArray(patch) ? { ...good(), ...patch } : patch)).toBeNull();
  });

  it('cleans and caps what it keeps: fields, notes, hidden characters, bad ids and unknown mint kinds', () => {
    const parsed = parseAlertCard({ ...good(), mint: 'weird', record: { kind: 'opportunity', id: 'bad id<>' }, summary: 's'.repeat(999), fields: [...Array.from({ length: 30 }, (_, index) => ({ label: `L${index}`, value: `v\u202e${index}` })), { label: '', value: 'no label' }, 'text', null], notes: Array.from({ length: 9 }, (_, index) => ({ label: 'N', value: `n${index}` })) })!;
    expect(parsed.mint).toBe('unknown');
    expect(parsed.record).toBeUndefined();
    expect(parseAlertCard({ ...good(), record: { kind: 'wallet', id: 'x' } })?.record).toBeUndefined();
    expect(parsed.fields).toHaveLength(12);
    expect(parsed.fields[0]?.value).toBe('v0');
    expect(parsed.notes).toHaveLength(4);
    expect(Array.from(parsed.summary).length).toBeLessThanOrEqual(300);
  });

  it('buildAlertCard throws for an invalid contract rather than sending a card with a broken link', () => {
    expect(() => buildAlertCard({ title: 'X', chainId: 1, contract: 'nope', spottedAt: NOW })).toThrow('ALERT_CARD_INVALID');
    expect(() => buildAlertCard({ title: 'X', chainId: 1, contract: CONTRACT, spottedAt: 'never' })).toThrow('ALERT_CARD_INVALID');
  });

  it('parses digest items, with or without a card, and refuses anything malformed', () => {
    expect(parseDigestItems([{ text: 'plain reminder' }, { text: 'with card', card: good() }])).toEqual([{ text: 'plain reminder' }, { text: 'with card', card: card() }]);
    for (const bad of [null, 'x', {}, [], [null], [{}], [{ text: '' }]]) expect(parseDigestItems(bad)).toBeNull();
    expect(parseDigestItems(Array.from({ length: 80 }, () => ({ text: 't' })))).toHaveLength(50);
  });

  it('reports chain facts for known and unknown chains', () => {
    expect(chainDisplay(1).name).toBe('ETHEREUM');
    expect(chainDisplay(999)).toEqual({ name: 'CHAIN 999', short: 'CHAIN 999' });
    expect(chainDisplay(Number('constructor' as never) || 2)).toEqual({ name: 'CHAIN 2', short: 'CHAIN 2' });
  });
});

describe('digests (T-029)', () => {
  it('renders a compact entry per item with the name linked, and the age of the oldest item', () => {
    const items = [{ text: 'a', card: card({ summary: 'opens in 20 min, free' }) }, { text: 'plain <b>note</b>' }, { text: 'c', card: card({ chainId: 4663, collectionName: null, spottedAt: NOW.getTime() - 90_000 }) }];
    const { html, plain, buttons } = renderDigest(items, { now: NOW, dashboardUrl: LOCAL });
    expect(buttons).toEqual([]);
    expect(html.split('\n')[0]).toBe('<b>MintBot reminders (3)</b>');
    expect(html).toContain(`• <a href="https://etherscan.io/address/${CONTRACT}">Pudgy Example</a> · ETHEREUM · FREE MINT\n  opens in 20 min, free`);
    expect(html).toContain(`<a href="https://robinhoodchain.blockscout.com/address/${CONTRACT}">ROBIN MINT</a>`);
    expect(html).toContain('• plain &lt;b&gt;note&lt;/b&gt;');
    expect(html.split('\n').at(-1)).toBe('<i>Sent 14:03:22 UTC, oldest item spotted 90 s earlier</i>');
    expect(plain).toContain(`https://etherscan.io/address/${CONTRACT}`);
  });

  it('shows as many items as fit and says how many more, without ever cutting a tag', () => {
    const items = Array.from({ length: 50 }, (_, index) => ({ text: `item ${index}`, card: card({ summary: 'x'.repeat(250), collectionName: `Collection ${index}` }) }));
    const { html } = renderDigest(items, { now: NOW, dashboardUrl: LOCAL });
    expect(html.length).toBeLessThanOrEqual(3_900);
    expect(html).toMatch(/… and \d+ more/);
    expect((html.match(/<a /g) ?? []).length).toBe((html.match(/<\/a>/g) ?? []).length);
  });

  it('keeps the digest\'s plain-text form under 2,000 characters too, and says how many more there are', () => {
    const items = Array.from({ length: 30 }, (_, index) => ({ text: `item ${index}`, card: card({ summary: 'y'.repeat(250), collectionName: `Collection ${index}` }) }));
    const { plain } = renderDigest(items, { now: NOW, dashboardUrl: LOCAL });
    expect(plain.length).toBeLessThanOrEqual(1_900);
    expect(plain).toMatch(/… and \d+ more/);
    expect(redactText(plain)).toBe(plain);
  });
});
