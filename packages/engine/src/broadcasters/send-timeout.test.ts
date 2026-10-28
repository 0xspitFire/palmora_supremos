import { afterEach, describe, expect, it, vi } from 'vitest';
import { chainRpcSecretNames } from '../chains.js';
import { BlastBroadcaster } from './blast.js';
import { FlashbotsBroadcaster } from './flashbots.js';
import { PublicMempoolBroadcaster } from './public-mempool.js';
import { SequencerDirectBroadcaster } from './sequencer-direct.js';
import { SEND_TIMEOUT_MS } from './send-timeout.js';

const signed = '0x02f8' as `0x${string}`;
const GOOD = 'https://good.example/rpc';
const HUNG = 'https://hung.example/rpc';

/** A fetch whose hung endpoint only ends when its abort signal fires; the good one answers at once. */
function stubFetch(controllers: AbortController[]) {
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
    expect(ms).toBe(SEND_TIMEOUT_MS);
    const controller = new AbortController();
    controllers.push(controller);
    return controller.signal;
  });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: { signal?: AbortSignal }) => {
    expect(init.signal).toBeInstanceOf(AbortSignal);
    if (url === GOOD) return { json: async () => ({ result: `0x${'ab'.repeat(32)}` }) };
    return new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new Error('The operation was aborted due to timeout'))));
  }));
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('D-079 third Robinhood slot', () => {
  it('is part of the Robinhood endpoint set and nothing else changed', () => {
    expect(chainRpcSecretNames(4663)).toEqual(['ROBINHOOD_RPC_URL', 'ROBINHOOD_RPC_FBACK', 'ROBINHOOD_RPC_FBACK_II']);
    expect(chainRpcSecretNames(8453)).toEqual(['BASE_RPC_URL', 'BASE_RPC_FBACK', 'BASE_RPC_FBACK_II']);
  });
});

describe('D-079 send timeouts', () => {
  it('a hung endpoint is recorded as ambiguous after the abort and does not stall the good one (blast)', async () => {
    const controllers: AbortController[] = [];
    stubFetch(controllers);
    const pending = new BlastBroadcaster([GOOD, HUNG]).broadcast([signed]);
    await Promise.resolve();
    await vi.waitFor(() => expect(controllers.length).toBeGreaterThanOrEqual(2));
    controllers.forEach((controller) => controller.abort());
    const results = await pending;
    expect(results.find((result) => result.endpoint === GOOD)?.responseClass).toBe('accepted');
    const hung = results.find((result) => result.endpoint === HUNG);
    expect(hung).toMatchObject({ success: false, ambiguous: true, responseClass: 'ambiguous' });
    expect(hung?.txHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('applies the abort to the sequencer sender and to the single public sender', async () => {
    const controllers: AbortController[] = [];
    stubFetch(controllers);
    const sequencer = new SequencerDirectBroadcaster(GOOD, [HUNG]).broadcast([signed]);
    await vi.waitFor(() => expect(controllers.length).toBe(2));
    controllers.forEach((controller) => controller.abort());
    expect((await sequencer).find((result) => result.endpoint === HUNG)?.responseClass).toBe('ambiguous');

    const publicSend = new PublicMempoolBroadcaster(HUNG).broadcast([signed]);
    await vi.waitFor(() => expect(controllers.length).toBe(3));
    controllers[2]!.abort();
    expect((await publicSend)[0]).toMatchObject({ ambiguous: true, responseClass: 'ambiguous' });
  });

  it('a Flashbots timeout is ambiguous, never a definite rejection', async () => {
    const controllers: AbortController[] = [];
    stubFetch(controllers);
    const authSigner = { address: `0x${'11'.repeat(20)}`, signMessage: async () => `0x${'22'.repeat(65)}` };
    const pending = new FlashbotsBroadcaster({ relayUrl: HUNG, authSigner, blockRange: 1 } as never).broadcast([signed], { targetBlock: 10n });
    await vi.waitFor(() => expect(controllers.length).toBe(1));
    controllers[0]!.abort();
    expect((await pending)[0]).toMatchObject({ success: false, ambiguous: true, responseClass: 'ambiguous' });
  });
});
