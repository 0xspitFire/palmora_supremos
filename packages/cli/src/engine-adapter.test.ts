import { describe, expect, it } from 'vitest';
import { assertWithinAdmittedExposure, baseReceiptFactsAgree, chainName, engineConfigFromCampaign, freeMintReserveCapsFor, preSignReservationGate, selectKeyListWallets } from './engine-adapter.js';
import { canonicalExecutionIdentity, createBroadcaster } from '@mint-bot/engine';

const campaign = { mintPriceWei: 1_000n, quantity: 2 };

describe('Base adapter wiring (D-057)', () => {
  it('maps canonical chain 8453 into the Engine Base target', () => {
    expect(chainName(8453)).toBe('base');
  });

  it('requires independent providers to agree on every settlement gas fact', () => {
    const receipt = { blockHash: '0xabc', blockNumber: 10n, status: 'success', gasUsed: 20n, effectiveGasPrice: 30n };
    expect(baseReceiptFactsAgree(receipt, { ...receipt, blockHash: '0xAbC' })).toBe(true);
    for (const changed of [
      { blockHash: '0xdef' },
      { blockNumber: 11n },
      { status: 'reverted' },
      { gasUsed: 21n },
      { effectiveGasPrice: 31n },
    ]) expect(baseReceiptFactsAgree(receipt, { ...receipt, ...changed })).toBe(false);
  });

  it('composes Base live execution as one send to the owner-bound primary RPC', async () => {
    const baseCampaign = {
      id: 'base-campaign', state: 'Draft', chainId: 8453, contract: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', strategy: 'seadrop-v1-public', quantity: 1, dryRun: false,
      spendPolicy: { maxRunWei: 200_000_000_000_000n, dailyCapWei: 200_000_000_000_000n, gasCeilingWei: 200_000_000_000_000n },
      chainVerification: { chainId: 8453, status: 'verified', seaDropCompatible: true, sourceBlock: 1n, endpointReference: 'BASE_RPC_URL' },
      mintPriceWei: 0n,
      feePolicy: { kind: 'free', configuredPriorityFeeWei: 100_000_000n, freeTotalSpendCapWei: 200_000_000_000_000n, l2ExecutionGasBudgetWei: 199_999_900_000_000n, l1DataGasBudgetWei: 0n, totalFeeBudgetWei: 200_000_000_000_000n },
      broadcastMode: 'public', createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    } as const;
    const config = engineConfigFromCampaign(baseCampaign, {
      killSwitchFile: '/tmp/test-kill', secretRoot: '/tmp/test-secrets', logFile: '/tmp/test.log', maxFeePerGasGwei: 0.1, gasLimitPadding: 1.2, maxReplacementBumps: 0,
      getState: () => ({}) as never, transact: async (mutate) => mutate({} as never),
    }, false, 1);
    expect(config.broadcast.mode).toBe('public');

    const destinations: string[] = [];
    const priorFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      destinations.push(String(input));
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: `0x${'1'.repeat(64)}` }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
      const broadcaster = createBroadcaster({ chainId: 8453, name: 'Base', blockTimeMs: 2_000, confirmationDepth: 1, rpcEndpoints: ['https://primary.invalid', 'https://fallback.invalid'], isL2: true, verificationStatus: 'verified', finalityPolicy: { stages: ['soft', 'posted', 'ethereum_final'], settlementStage: 'ethereum_final', notes: 'test' }, executionEnabled: true }, config.broadcast.mode, []);
      await broadcaster.broadcast(['0x02']);
      expect(destinations).toEqual(['https://primary.invalid']);
    } finally { globalThis.fetch = priorFetch; }
  });
});

describe('pre-sign exposure guard (T-010)', () => {
  it('allows a transaction that exactly matches the admitted value and fits the reservation', () => {
    expect(() => assertWithinAdmittedExposure({ valueWei: 2_000n, maxGasCostWei: 400n, l1DataGasWei: 0n }, campaign, { amountWei: 2_400n })).not.toThrow();
  });

  it('refuses signing when the price changed after admission, up or down', () => {
    expect(() => assertWithinAdmittedExposure({ valueWei: 2_002n, maxGasCostWei: 0n, l1DataGasWei: 0n }, campaign, { amountWei: 10_000n })).toThrow('MINT_VALUE_CHANGED_SINCE_ADMISSION');
    expect(() => assertWithinAdmittedExposure({ valueWei: 1_998n, maxGasCostWei: 0n, l1DataGasWei: 0n }, campaign, { amountWei: 10_000n })).toThrow('MINT_VALUE_CHANGED_SINCE_ADMISSION');
  });

  it('refuses signing when worst-case gas pushes exposure one wei past the reservation', () => {
    expect(() => assertWithinAdmittedExposure({ valueWei: 2_000n, maxGasCostWei: 401n, l1DataGasWei: 0n }, campaign, { amountWei: 2_400n })).toThrow('EXPOSURE_EXCEEDS_RESERVATION');
    expect(() => assertWithinAdmittedExposure({ valueWei: 2_000n, maxGasCostWei: 400n, l1DataGasWei: 1n }, campaign, { amountWei: 2_400n })).toThrow('EXPOSURE_EXCEEDS_RESERVATION');
  });

  it('fails closed on negative gas figures and for free mints that suddenly carry value', () => {
    expect(() => assertWithinAdmittedExposure({ valueWei: 2_000n, maxGasCostWei: -1n, l1DataGasWei: 0n }, campaign, { amountWei: 10_000n })).toThrow('EXPOSURE_EXCEEDS_RESERVATION');
    expect(() => assertWithinAdmittedExposure({ valueWei: 1n, maxGasCostWei: 0n, l1DataGasWei: 0n }, { mintPriceWei: 0n, quantity: 5 }, { amountWei: 10_000n })).toThrow('MINT_VALUE_CHANGED_SINCE_ADMISSION');
  });
});

describe('complete pre-sign reservation gate used by the adapter reserve step (T-010)', () => {
  const address = '0x1111111111111111111111111111111111111111';
  const identity = canonicalExecutionIdentity('run-1', 'intent-1', 0, address);
  const reservation = { id: 'res-1', status: 'reserved', amountWei: 2_400n };
  const base = { killed: false, byWallet: new Map([[address, reservation]]), runId: 'run-1', intentId: 'intent-1', campaign: { id: 'cmp-1', mintPriceWei: 1_000n, quantity: 2 } };
  const input = { address, walletIndex: 0, runId: 'run-1', campaignId: 'cmp-1', executionId: identity.executionId, transactionIntentId: identity.transactionIntentId, valueWei: 2_000n, maxGasCostWei: 400n, l1DataGasWei: 0n };

  it('returns the reservation only when every check passes', () => {
    expect(preSignReservationGate({ ...base, input })).toBe(reservation);
  });

  it('D-062: a Base or Robinhood enablement revoked after the run started stops the next signature; paid also needs a current paid enablement', () => {
    expect(() => preSignReservationGate({ ...base, input, enablement: { current: false, paidAllowed: false } })).toThrow('CHAIN_ENABLEMENT_NOT_CURRENT');
    expect(() => preSignReservationGate({ ...base, input, enablement: { current: false, paidAllowed: true } })).toThrow('CHAIN_ENABLEMENT_NOT_CURRENT');
    expect(() => preSignReservationGate({ ...base, input, enablement: { current: true, paidAllowed: false } })).toThrow('PAID_ENABLEMENT_NOT_CURRENT');
    expect(preSignReservationGate({ ...base, input, enablement: { current: true, paidAllowed: true } })).toBe(reservation);
    expect(preSignReservationGate({ ...base, input: { ...input, valueWei: 0n }, campaign: { ...base.campaign, mintPriceWei: 0n }, enablement: { current: true, paidAllowed: false } })).toBe(reservation);
    // the kill switch is still checked first
    expect(() => preSignReservationGate({ ...base, killed: true, input, enablement: { current: false, paidAllowed: false } })).toThrow('KILLED');
  });

  it('refuses in order: kill switch, missing or used reservation, identity, value, exposure', () => {
    expect(() => preSignReservationGate({ ...base, killed: true, input })).toThrow('KILLED');
    expect(() => preSignReservationGate({ ...base, byWallet: new Map(), input })).toThrow('DURABLE_RESERVATION_REQUIRED');
    expect(() => preSignReservationGate({ ...base, byWallet: new Map([[address, { ...reservation, status: 'settled' }]]), input })).toThrow('DURABLE_RESERVATION_REQUIRED');
    expect(() => preSignReservationGate({ ...base, input: { ...input, executionId: 'forged' } })).toThrow('CANONICAL_IDENTITY_REQUIRED');
    expect(() => preSignReservationGate({ ...base, input: { ...input, valueWei: 2_001n } })).toThrow('MINT_VALUE_CHANGED_SINCE_ADMISSION');
    expect(() => preSignReservationGate({ ...base, input: { ...input, maxGasCostWei: 401n } })).toThrow('EXPOSURE_EXCEEDS_RESERVATION');
  });
});

describe('adapter wiring (T-010)', () => {
  it('routes the reserve step through the complete pre-sign gate', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('./engine-adapter.ts', import.meta.url), 'utf8');
    const reserveBody = source.slice(source.indexOf('reserve: async (input) => {'), source.indexOf('const settleTotal'));
    expect(reserveBody).toContain('preSignReservationGate(');
  });

  it('re-reads the reservations when reserve runs, never the copy taken when execute started (T-021)', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('./engine-adapter.ts', import.meta.url), 'utf8');
    const reserveBody = source.slice(source.indexOf('reserve: async (input) => {'), source.indexOf('const settleTotal'));
    expect(reserveBody).toContain('options.getState()');
    expect(reserveBody).toContain('byWallet: freshByWallet');
    expect(reserveBody).not.toMatch(/byWallet,\s*runId/);
  });

  it('refuses when a reservation was released or settled after execute began, with no signer involved', () => {
    const address = '0x1111111111111111111111111111111111111111';
    const identity = canonicalExecutionIdentity('run-1', 'intent-1', 0, address);
    const input = { address, walletIndex: 0, runId: 'run-1', campaignId: 'cmp-1', executionId: identity.executionId, transactionIntentId: identity.transactionIntentId, valueWei: 2_000n, maxGasCostWei: 400n, l1DataGasWei: 0n };
    const args = { killed: false, runId: 'run-1', intentId: 'intent-1', campaign: { id: 'cmp-1', mintPriceWei: 1_000n, quantity: 2 }, input };
    for (const status of ['released', 'settled', 'failed']) {
      expect(() => preSignReservationGate({ ...args, byWallet: new Map([[address, { id: 'res-1', status, amountWei: 2_400n }]]) })).toThrow('DURABLE_RESERVATION_REQUIRED');
    }
    // A reservation that vanished from the fresh state entirely is refused too.
    expect(() => preSignReservationGate({ ...args, byWallet: new Map() })).toThrow('DURABLE_RESERVATION_REQUIRED');
  });
});

describe('free-mint reserve caps per chain (D-042, D-057)', () => {
  it('reports the approved Ethereum and Base policies while leaving Robinhood on its Engine default', () => {
    expect(freeMintReserveCapsFor(1)).toEqual({ perWalletCapWei: 400_000_000_000_000n, activePeriodCapWei: 2_400_000_000_000_000n });
    expect(freeMintReserveCapsFor(4663)).toBeUndefined();
    expect(freeMintReserveCapsFor(8453)).toEqual({ perWalletCapWei: 200_000_000_000_000n, activePeriodCapWei: 1_200_000_000_000_000n });
    expect(freeMintReserveCapsFor(0)).toBeUndefined();
  });
});

describe('wallet selection takes exactly the approved wallets, wherever they sit in the key list (D-073)', () => {
  const list = [{ index: 0, address: '0xAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaa' }, { index: 1, address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }, { index: 2, address: '0xcccccccccccccccccccccccccccccccccccccccc' }];
  it('returns positions and lower-case addresses in key-list order, whatever order or letter case they arrive in', () => {
    expect(selectKeyListWallets(list, [list[0]!.address, list[1]!.address])).toEqual({ indexes: [0, 1], addresses: [list[0]!.address.toLowerCase(), list[1]!.address] });
    expect(selectKeyListWallets(list, list.map((wallet) => wallet.address).reverse()).indexes).toEqual([0, 1, 2]);
    // A later wallet alone, and a gap, are fine now.
    expect(selectKeyListWallets(list, [list[2]!.address]).indexes).toEqual([2]);
    expect(selectKeyListWallets(list, [list[2]!.address.toUpperCase().replace('0X', '0x'), list[0]!.address]).indexes).toEqual([0, 2]);
  });
  it('still refuses a repeat, a stranger, an empty list, and a key list that repeats a requested address', () => {
    expect(() => selectKeyListWallets(list, [list[0]!.address, list[0]!.address])).toThrow('WALLET_SELECTION_NOT_REPRESENTABLE');
    expect(() => selectKeyListWallets(list, [list[0]!.address.toLowerCase(), list[0]!.address.toUpperCase().replace('0X', '0x')])).toThrow('WALLET_SELECTION_NOT_REPRESENTABLE');
    expect(() => selectKeyListWallets(list, [list[0]!.address, '0xdddddddddddddddddddddddddddddddddddddddd'])).toThrow('WALLET_SELECTION_NOT_REPRESENTABLE');
    expect(() => selectKeyListWallets(list, [])).toThrow('EMPTY_EXECUTION_FLEET');
    expect(() => selectKeyListWallets([list[0]!, { index: 1, address: list[0]!.address.toLowerCase() }], [list[0]!.address])).toThrow('WALLET_SELECTION_NOT_REPRESENTABLE');
    expect(() => selectKeyListWallets(list.slice(0, 1), list.map((wallet) => wallet.address))).toThrow('WALLET_SELECTION_NOT_REPRESENTABLE');
  });
  it('hands the engine the positions and the approved addresses', () => {
    const selection = selectKeyListWallets(list, [list[2]!.address]);
    const config = engineConfigFromCampaign({ id: 'c', chainId: 1, contract: '0x3333333333333333333333333333333333333333', strategy: 'seadrop-v1-public', quantity: 1, spendPolicy: { maxRunWei: 10n ** 16n, dailyCapWei: 10n ** 16n, gasCeilingWei: 10n ** 15n }, feePolicy: { kind: 'free', configuredPriorityFeeWei: 0n, totalFeeBudgetWei: 1n } } as never, { maxFeePerGasGwei: 1, gasLimitPadding: 1, maxReplacementBumps: 0, killSwitchFile: '/x' } as never, true, 1, selection);
    expect(config.fleet).toMatchObject({ maxWallets: 1, walletIndexes: [2], expectedAddresses: [list[2]!.address] });
  });
});
