import { describe, expect, it } from 'vitest';
import type { BackendState } from '@mint-bot/backend';
import { assertLiveRunAllowed, assertWalletFileMatchesRun, describeLiveRunResult, liveRunPhrase, previewLiveRun, quantityPlanForRun } from './live-run.js';

const W1 = '0x1111111111111111111111111111111111111111';
const W2 = '0x2222222222222222222222222222222222222222';
const RUN = 'run_abcdef12345678';

function state(over: { runState?: string; mode?: string; reservations?: Array<Record<string, unknown>>; receipts?: Array<Record<string, unknown>>; events?: unknown[] } = {}): BackendState {
  const reservation = (wallet: string, extra: Record<string, unknown> = {}) => ({ id: `res_${wallet.slice(2, 4)}`, runId: RUN, campaignId: 'c1', wallet, amountWei: 100_000_000_000_000n, accountingDate: '2026-10-08', status: 'reserved', createdAt: '', updatedAt: '', ...extra });
  return {
    campaigns: [{ id: 'c1', contract: '0xabc', quantity: 2 }],
    runs: [{ id: RUN, intentId: 'i1', campaignId: 'c1', mode: over.mode ?? 'live', state: over.runState ?? 'Armed' }],
    intents: [{ id: 'i1', runId: RUN, campaignId: 'c1', wallets: [W1, W2] }],
    reservations: over.reservations ?? [reservation(W1), reservation(W2)],
    receipts: over.receipts ?? [],
    attempts: [],
    events: over.events ?? [{ id: 'e1', type: 'quantity_plan', at: '', data: { campaignId: 'c1', reduced: true, message: 'Fees were high, so 2 NFTs instead of 5.', maxFeeGwei: '12' } }],
  } as unknown as BackendState;
}

describe('guided live run preview and confirmation (T-024 stage 2)', () => {
  it('shows the most that can be spent and the phrase that must be typed', () => {
    const preview = previewLiveRun(state(), RUN);
    expect(preview).toMatchObject({ maxExposureEth: '0.0002', quantityPerWallet: 2, planningMaxFeeGwei: '12', phrase: 'RUN-LIVE 12345678 0.0002' });
    expect(preview.quantityNote).toContain('2 NFTs instead of 5');
    expect(liveRunPhrase(RUN, '0.0003')).not.toBe(preview.phrase);
  });

  it('refuses a dry run, a run that is not armed, missing or open reservations', () => {
    expect(() => previewLiveRun(state({ mode: 'dry-run' }), RUN)).toThrow('LIVE_RUN_REQUIRED');
    expect(() => previewLiveRun(state({ runState: 'Completed' }), RUN)).toThrow('RUN_NOT_ARMED');
    expect(() => previewLiveRun(state({ reservations: [] }), RUN)).toThrow('RESERVATIONS_NOT_READY');
    expect(() => previewLiveRun(state({ reservations: [{ id: 'r', runId: RUN, wallet: W1, amountWei: 1n, status: 'reserved' }] }), RUN)).toThrow('RESERVATIONS_NOT_READY');
    expect(() => previewLiveRun(state({ reservations: [{ runId: RUN, wallet: W1, amountWei: 1n, status: 'settled' }, { runId: RUN, wallet: W2, amountWei: 1n, status: 'reserved' }] }), RUN)).toThrow('RESERVATIONS_NOT_READY');
    expect(() => previewLiveRun(state(), 'run_missing')).toThrow('RUN_NOT_FOUND');
  });

  it('fails closed: nothing runs without the exact phrase, a fee at or under the plan, and a recorded plan', () => {
    const preview = previewLiveRun(state(), RUN);
    expect(() => assertLiveRunAllowed({ preview, confirm: preview.phrase, maxFeeGwei: 12 })).not.toThrow();
    expect(() => assertLiveRunAllowed({ preview, confirm: preview.phrase, maxFeeGwei: 8 })).not.toThrow();
    expect(() => assertLiveRunAllowed({ preview, confirm: undefined, maxFeeGwei: 12 })).toThrow('CONFIRMATION_PHRASE_MISMATCH');
    expect(() => assertLiveRunAllowed({ preview, confirm: 'RUN-LIVE 12345678 0.0009', maxFeeGwei: 12 })).toThrow('CONFIRMATION_PHRASE_MISMATCH');
    expect(() => assertLiveRunAllowed({ preview, confirm: preview.phrase, maxFeeGwei: 12.5 })).toThrow('MAX_FEE_ABOVE_PLAN');
    for (const bad of [undefined, 0, -1, Number.NaN, 501]) expect(() => assertLiveRunAllowed({ preview, confirm: preview.phrase, maxFeeGwei: bad })).toThrow('MAX_FEE_GWEI_REQUIRED');
    const noPlan = previewLiveRun(state({ events: [] }), RUN);
    expect(() => assertLiveRunAllowed({ preview: noPlan, confirm: noPlan.phrase, maxFeeGwei: 12 })).toThrow('PLANNING_FEE_UNKNOWN');
  });

  it('finds the plan by campaign before the run copy exists, and prefers the latest one', () => {
    const events = [{ id: 'a', type: 'quantity_plan', at: '', data: { campaignId: 'c1', message: 'old' } }, { id: 'b', runId: RUN, type: 'quantity_plan', at: '', data: { campaignId: 'c1', message: 'new' } }] as never;
    expect(quantityPlanForRun(events, RUN, 'c1')?.message).toBe('new');
    expect(quantityPlanForRun(events, 'other', 'zzz')).toBeNull();
  });

  it('explains a finished run: minted wallets, spend, ledger match and why fewer NFTs', () => {
    const done = state({
      runState: 'Completed',
      reservations: [
        { runId: RUN, wallet: W1, amountWei: 100_000_000_000_000n, actualAmountWei: 40_000_000_000_000n, status: 'settled' },
        { runId: RUN, wallet: W2, amountWei: 100_000_000_000_000n, status: 'released' },
      ],
      receipts: [{ id: 'r1', runId: RUN, state: 'Confirmed', actualSpendWei: 40_000_000_000_000n }],
    });
    const report = describeLiveRunResult(done, RUN);
    expect(report).toMatchObject({ walletsMinted: 1, walletsNotMinted: 1, nftsMinted: 2, spentEth: '0.00004', ledgerMatchesReceipts: true, settledReservations: 1, releasedReservations: 1 });
    expect(report.summary).toContain('1 of 2 wallet(s) minted 2 NFT(s) each');
    expect(report.summary).toContain('2 NFTs instead of 5');
  });

  it('flags a ledger that does not match the receipts', () => {
    const bad = state({
      runState: 'Completed',
      reservations: [{ runId: RUN, wallet: W1, amountWei: 100n, actualAmountWei: 10n, status: 'settled' }],
      receipts: [{ id: 'r1', runId: RUN, state: 'Confirmed', actualSpendWei: 99n }],
    });
    const report = describeLiveRunResult(bad, RUN);
    expect(report.ledgerMatchesReceipts).toBe(false);
    expect(report.summary).toContain('WARNING');
  });
});

describe('wallet file check', () => {
  it('requires exactly the admitted wallets, ignoring address case', () => {
    expect(() => assertWalletFileMatchesRun({ wallets: [W1, W2] }, [W2.toUpperCase().replace('0X', '0x'), W1])).not.toThrow();
    expect(() => assertWalletFileMatchesRun({ wallets: [W1, W2] }, [W1])).toThrow('WALLET_FILE_DIFFERS_FROM_RUN');
    expect(() => assertWalletFileMatchesRun({ wallets: [W1] }, [W1, W2])).toThrow('WALLET_FILE_DIFFERS_FROM_RUN');
    expect(() => assertWalletFileMatchesRun({ wallets: [W1, W2] }, [W1, '0x3333333333333333333333333333333333333333'])).toThrow('WALLET_FILE_DIFFERS_FROM_RUN');
  });
});

describe('live-run command wiring', () => {
  it('previews first, checks the confirmation before building a runtime that can sign, and copies the plan onto the run before running', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
    const start = source.indexOf(".command('live-run'");
    const body = source.slice(start, source.indexOf(".command('execute'", start));
    expect(start).toBeGreaterThan(0);
    expect(body.indexOf('previewLiveRun(')).toBeLessThan(body.indexOf('if (args.confirm === undefined)'));
    expect(body.indexOf('if (args.confirm === undefined)')).toBeLessThan(body.indexOf('assertLiveRunAllowed('));
    expect(body.indexOf('assertLiveRunAllowed(')).toBeLessThan(body.indexOf('acceptPersonalLiveLocalCustody: true'));
    expect(body.indexOf("type: 'quantity_plan'")).toBeLessThan(body.indexOf("command('run'"));
    expect(body.indexOf('{ startCoordinator: false }')).toBeGreaterThan(0);
  });

  it('records the quantity plan at live-prepare, keyed by campaign', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
    const start = source.indexOf(".command('live-prepare'");
    const body = source.slice(start, source.indexOf(".command('survey-seadrop'", start));
    expect(body).toContain("type: 'quantity_plan'");
    expect(body).toContain('campaignId: campaign.id');
  });
});
