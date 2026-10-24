import { describe, expect, it } from 'vitest';
import { createBlockscoutPortfolio, parseItem, type PortfolioFetch } from './portfolio-provider.js';
import { createTelegramActions, type TelegramActionDeps } from './telegram-actions.js';

/** T-068: the Blockscout client (cache, spacing, pages, fixed error codes, no key leak) and the /portfolio reply. */
const KEY = ['proapi', 'testkeyvalue123'].join('_');
const A = '0x365952eb1e8209bf2bcc2db5ed213111a87d061e';
const B = '0x81c104dcb898416fd4f81ead091dba5b8f46f37a';
const C1 = '0x1111111111111111111111111111111111111111';
const item = (id: string, contract = C1, name: string | null = 'Cool Cats', extra: Record<string, unknown> = {}) => ({ id, token_type: 'ERC-721', value: '1', token: { address_hash: contract, ...(name ? { name } : {}) }, ...extra });
const reply = (status: number, body: unknown): Awaited<ReturnType<PortfolioFetch>> => ({ ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

function provider(responses: Array<Awaited<ReturnType<PortfolioFetch>> | Error>) {
  const urls: string[] = [];
  let clock = new Date('2026-10-25T12:00:00.000Z');
  const sleeps: number[] = [];
  const fetcher: PortfolioFetch = async (url) => { urls.push(url); const next = responses.shift() ?? reply(200, { items: [], next_page_params: null }); if (next instanceof Error) throw next; return next; };
  const p = createBlockscoutPortfolio({ apiKey: KEY, fetcher, now: () => clock, sleep: async (ms) => { sleeps.push(ms); } });
  return { p, urls, sleeps, advance: (ms: number) => { clock = new Date(clock.getTime() + ms); } };
}

describe('Blockscout portfolio client', () => {
  it('reads items, follows next_page_params, caches for 5 minutes and asks again after that', async () => {
    const t = provider([reply(200, { items: [item('1')], next_page_params: { token_id: '1', token_contract_address_hash: C1 } }), reply(200, { items: [item('2')], next_page_params: null })]);
    const first = await t.p.list(1, A);
    expect(first.items.map((entry) => entry.tokenId)).toEqual(['1', '2']);
    expect(first.cached).toBe(false);
    expect(t.urls[0]).toContain('/1/api/v2/addresses/' + A + '/nft?' + ['api', 'key='].join(''));
    expect(t.urls[1]).toContain('token_id=1');
    expect((await t.p.list(1, A)).cached).toBe(true);
    expect(t.urls).toHaveLength(2);
    t.advance(5 * 60_000 + 1);
    expect((await t.p.list(1, A)).cached).toBe(false);
  });

  it('stops at 5 pages and says the list is partial', async () => {
    const page = reply(200, { items: [item('1')], next_page_params: { token_id: '9' } });
    const t = provider([page, page, page, page, page, page]);
    const result = await t.p.list(1, A);
    expect(t.urls).toHaveLength(5);
    expect(result.truncated).toBe(true);
  });

  it('turns every failure into a fixed code and never lets the key out', async () => {
    for (const [response, code] of [[reply(402, { error: 'Featured chains' }), 'PORTFOLIO_CHAIN_NOT_COVERED'], [reply(429, {}), 'PORTFOLIO_RATE_LIMITED'], [reply(401, {}), 'PORTFOLIO_KEY_REJECTED'], [reply(500, {}), 'PORTFOLIO_UNAVAILABLE'], [reply(200, { nope: true }), 'PORTFOLIO_UNAVAILABLE'], [new Error(`connect failed https://api.blockscout.com/1?${['api', 'key='].join('')}${KEY}`), 'PORTFOLIO_UNAVAILABLE']] as const) {
      const t = provider([response]);
      const error = await t.p.list(1, A).then(() => undefined, (caught: Error) => caught);
      expect(error?.message).toBe(code);
      expect(error?.message).not.toContain(KEY);
    }
    await expect(provider([]).p.list(1, 'not-an-address')).rejects.toThrow('PORTFOLIO_WALLET_INVALID');
  });

  it('remembers a failure for a minute, refuses a huge body and a foreign paging key, and never follows a redirect', async () => {
    const down = provider([reply(500, {})]);
    await expect(down.p.list(1, A)).rejects.toThrow('PORTFOLIO_UNAVAILABLE');
    await expect(down.p.list(1, A)).rejects.toThrow('PORTFOLIO_UNAVAILABLE');
    expect(down.urls).toHaveLength(1);
    down.advance(61_000);
    await expect(down.p.list(1, A)).resolves.toMatchObject({ items: [] });
    expect(down.urls).toHaveLength(2);

    const huge = provider([reply(200, 'x'.repeat(1_000_001))]);
    await expect(huge.p.list(1, A)).rejects.toThrow('PORTFOLIO_UNAVAILABLE');
    const notJson = provider([reply(200, 'not json')]);
    await expect(notJson.p.list(1, A)).rejects.toThrow('PORTFOLIO_UNAVAILABLE');

    const foreign = provider([reply(200, { items: [], next_page_params: { [['api', 'key'].join('')]: 'stolen', 'bad key': '1', token_id: '3' } }), reply(200, { items: [], next_page_params: null })]);
    await foreign.p.list(1, A);
    expect(foreign.urls[1]).toContain('token_id=3');
    expect(foreign.urls[1]).not.toContain('stolen');
    expect(foreign.urls[1]).not.toContain('bad');

    const inits: unknown[] = [];
    const redirecting = createBlockscoutPortfolio({ apiKey: KEY, fetcher: async (_url, init) => { inits.push(init.redirect); return reply(200, { items: [], next_page_params: null }); }, sleep: async () => undefined });
    await redirecting.list(1, A);
    expect(inits).toEqual(['error']);
  });

  it('spaces requests at least 250 ms apart', async () => {
    const t = provider([]);
    await Promise.all([t.p.list(1, A), t.p.list(1, B), t.p.list(4663, A)]);
    expect(t.urls).toHaveLength(3);
    expect(t.sleeps.length).toBeGreaterThanOrEqual(1);
  });

  it('keeps unknown fields unknown instead of inventing them, and counts ERC-1155 amounts', () => {
    expect(parseItem(item('5', C1, null))).toEqual({ contract: C1, name: undefined, tokenId: '5', type: 'ERC-721', amount: 1n });
    expect(parseItem({ id: '7', token_type: 'ERC-1155', value: '12', token: { address: C1, name: 'Multi' } })).toEqual({ contract: C1, name: 'Multi', tokenId: '7', type: 'ERC-1155', amount: 12n });
    expect(parseItem({ id: '8', token: { address_hash: 'nope' } })?.contract).toBeUndefined();
    expect(parseItem('junk')).toBeUndefined();
    expect(parseItem(null)).toBeUndefined();
  });
});

describe('/portfolio', () => {
  const deps = (portfolio?: ReturnType<typeof provider>['p']): TelegramActionDeps => ({
    mode: 'dry-run', custody: 'turnkey', store: { snapshot: () => ({ events: [], campaigns: [], runs: [], receipts: [], simulations: [], killed: false }) } as never, application: {} as never, coordinator: { kill: async () => undefined },
    projectRoot: '/nonexistent', secretRoot: '/nonexistent', killSwitchPath: '/nonexistent/killswitch', backupStatusPath: '/nonexistent/status.json', startedAt: new Date(), walletList: async () => [A, B], watchedWallets: () => [], watcherHealthy: () => undefined,
    intelligence: () => ({}) as never, gasAlerts: () => ({}) as never, now: () => new Date('2026-10-25T12:00:00.000Z'), ...(portfolio ? { portfolio } : {}),
  });

  it('is off, with a plain reason, when no key is stored', async () => {
    await expect(createTelegramActions(deps()).portfolio()).rejects.toThrow('PORTFOLIO_NOT_SET_UP');
  });

  it('groups by collection per chain, shows partial and unreadable wallets, says Base is not covered, and never prints the key', async () => {
    const t = provider([
      reply(200, { items: [item('1'), item('2'), item('3', '0x2222222222222222222222222222222222222222', 'Zed‮')], next_page_params: null }), // Ethereum A
      reply(429, {}), // Ethereum B
      reply(200, { items: [], next_page_params: null }), reply(200, { items: [item('9', '0x3333333333333333333333333333333333333333', 'Robin')], next_page_params: null }),
    ]);
    const text = await createTelegramActions(deps(t.p)).portfolio();
    expect(text).toContain('Ethereum: 3 NFT(s)');
    expect(text).toContain('Cool Cats × 2');
    expect(text).toContain('Zed');
    expect(text).not.toContain('‮');
    expect(text).toContain('could not be read (PORTFOLIO_RATE_LIMITED)');
    expect(text).toMatch(/Robinhood: 1 NFT/);
    expect(text).toContain('Base is not covered');
    expect(text).toContain('As of 2026-10-25 12:00 UTC');
    expect(text).not.toContain(KEY);
  });
});
