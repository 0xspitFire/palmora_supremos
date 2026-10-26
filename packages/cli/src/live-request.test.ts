import { describe, expect, it } from 'vitest';
import type { Campaign, SimulationEvidenceRecord } from '@mint-bot/backend';
import { LIVE_REQUEST_LIFETIME_MS, previewLiveRequest, processLiveRunRequests, runLiveRequest, startLiveRequestPoller, type LiveRequestProcessorDeps, type LiveRequestStore } from './live-request.js';

const NOW = new Date('2026-10-24T10:00:00.000Z');
const WALLET_A = '0x1111111111111111111111111111111111111111';
const WALLET_B = '0x2222222222222222222222222222222222222222';

const campaign = (overrides: Partial<Campaign> = {}): Campaign => ({
  id: 'cmp_0000000000000000abcdef12',
  state: 'Draft',
  chainId: 4663,
  contract: '0x3333333333333333333333333333333333333333',
  strategy: 'seadrop-v1-public',
  quantity: 1,
  dryRun: false,
  spendPolicy: { maxRunWei: 10_000_000_000_000_000n, dailyCapWei: 10_000_000_000_000_000n, gasCeilingWei: 1_000_000_000_000_000n },
  chainVerification: { chainId: 4663 } as Campaign['chainVerification'],
  mintPriceWei: 0n,
  feePolicy: { kind: 'free', configuredPriorityFeeWei: 0n, totalFeeBudgetWei: 100_000_000_000_000n } as Campaign['feePolicy'],
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
  ...overrides,
});

const simulation = (wallet: string, id: string, overrides: Partial<SimulationEvidenceRecord> = {}): SimulationEvidenceRecord => ({
  id, campaignId: 'cmp_0000000000000000abcdef12', wallet, inputDigest: 'd', success: true, sourceBlock: 1n, sourceBlockHash: '0x', checkedAt: '2026-10-24T09:55:00.000Z', expiresAt: '2026-10-24T10:25:00.000Z', worstCaseFeeWei: 0n, ...overrides,
});

const state = (simulations: SimulationEvidenceRecord[], campaigns = [campaign()]) => ({ campaigns, simulations, events: [] });

describe('live-request preview (T-058)', () => {
  it('binds the exact wallets to their newest fresh passing simulation and names the most that can be spent', () => {
    const preview = previewLiveRequest(state([simulation(WALLET_A, 'old', { checkedAt: '2026-10-24T09:50:00.000Z' }), simulation(WALLET_A, 'new'), simulation(WALLET_B, 'b')]), 'cmp_0000000000000000abcdef12', [WALLET_A, WALLET_B.toUpperCase().replace('0X', '0x')], 5, NOW);
    expect(preview.wallets).toEqual([WALLET_A, WALLET_B]);
    expect(preview.simulationIds).toEqual(['new', 'b']);
    expect(preview.maxExposureWei).toBe('200000000000000');
    expect(preview.phrase).toBe(`LIVE-REQUEST abcdef12 2-WALLETS ${preview.maxExposureEth} 5-GWEI`);
  });

  it('refuses without a fresh passing simulation for every wallet, for a dry campaign, bad wallets or a bad fee ceiling (fail closed)', () => {
    const id = 'cmp_0000000000000000abcdef12';
    expect(() => previewLiveRequest(state([simulation(WALLET_A, 'a', { expiresAt: '2026-10-24T09:59:59.000Z' })]), id, [WALLET_A], 5, NOW)).toThrow(/SIMULATION_REQUIRED/);
    expect(() => previewLiveRequest(state([simulation(WALLET_A, 'a', { success: false })]), id, [WALLET_A], 5, NOW)).toThrow(/SIMULATION_REQUIRED/);
    expect(() => previewLiveRequest(state([simulation(WALLET_A, 'a')]), id, [WALLET_A, WALLET_B], 5, NOW)).toThrow(/SIMULATION_REQUIRED/);
    expect(() => previewLiveRequest(state([simulation(WALLET_A, 'a')], [campaign({ dryRun: true })]), id, [WALLET_A], 5, NOW)).toThrow(/LIVE_REQUIRES_NON_DRY_CAMPAIGN/);
    expect(() => previewLiveRequest(state([simulation(WALLET_A, 'a')]), id, [WALLET_A, WALLET_A], 5, NOW)).toThrow(/WALLETS_INVALID/);
    expect(() => previewLiveRequest(state([simulation(WALLET_A, 'a')]), id, ['0x12'], 5, NOW)).toThrow(/WALLETS_INVALID/);
    expect(() => previewLiveRequest(state([simulation(WALLET_A, 'a')]), id, [], 5, NOW)).toThrow(/WALLETS_INVALID/);
    for (const fee of [0, -1, 501, Number.NaN]) expect(() => previewLiveRequest(state([simulation(WALLET_A, 'a')]), id, [WALLET_A], fee, NOW)).toThrow(/MAX_FEE_GWEI_REQUIRED/);
    expect(() => previewLiveRequest(state([simulation(WALLET_A, 'a')]), 'missing', [WALLET_A], 5, NOW)).toThrow(/CAMPAIGN_NOT_FOUND/);
    expect(() => previewLiveRequest(state([simulation(WALLET_A, 'a')], [campaign({ spendPolicy: { maxRunWei: 1n, dailyCapWei: 1n, gasCeilingWei: 1n } })]), id, [WALLET_A], 5, NOW)).toThrow(/PLANNED_EXPOSURE_INVALID/);
  });
});

describe('live-request create (T-058)', () => {
  const store = () => {
    const recorded: Parameters<LiveRequestStore['recordLiveRunRequest']>[0][] = [];
    const value: LiveRequestStore = { snapshot: () => state([simulation(WALLET_A, 'a')]), recordLiveRunRequest: (input) => { recorded.push(input); } };
    return { value, recorded };
  };

  it('status and a missing phrase only preview; nothing is approved or recorded', async () => {
    const { value, recorded } = store();
    let approvals = 0;
    const approve = async () => { approvals += 1; return { id: 'approval' }; };
    const status = await runLiveRequest({ action: 'status', campaignId: 'cmp_0000000000000000abcdef12', wallets: [WALLET_A], maxFeeGwei: 5, confirm: undefined, now: NOW, store: value, approve });
    expect(status.state).toBe('ConfirmToRequest');
    await runLiveRequest({ action: 'create', campaignId: 'cmp_0000000000000000abcdef12', wallets: [WALLET_A], maxFeeGwei: 5, confirm: undefined, now: NOW, store: value, approve });
    expect(approvals).toBe(0);
    expect(recorded).toEqual([]);
  });

  it('a wrong phrase is refused before any approval (fail closed)', async () => {
    const { value, recorded } = store();
    let approvals = 0;
    await expect(runLiveRequest({ action: 'create', campaignId: 'cmp_0000000000000000abcdef12', wallets: [WALLET_A], maxFeeGwei: 6, confirm: 'LIVE-REQUEST abcdef12 1-WALLETS 0.0001 5-GWEI', now: NOW, store: value, approve: async () => { approvals += 1; return { id: 'x' }; } })).rejects.toThrow(/CONFIRMATION_PHRASE_MISMATCH/);
    expect(approvals).toBe(0);
    expect(recorded).toEqual([]);
  });

  it('the exact phrase records the approval of the exact request and a request that lasts 30 minutes', async () => {
    const { value, recorded } = store();
    const preview = previewLiveRequest(value.snapshot(), 'cmp_0000000000000000abcdef12', [WALLET_A], 5, NOW);
    const approved: unknown[] = [];
    const result = await runLiveRequest({ action: 'create', campaignId: 'cmp_0000000000000000abcdef12', wallets: [WALLET_A], maxFeeGwei: 5, confirm: preview.phrase, now: NOW, store: value, approve: async (validated) => { approved.push(validated); return { id: 'approval-1' }; }, newId: () => 'request-1' });
    expect(result).toMatchObject({ state: 'Requested', requestId: 'request-1' });
    expect(approved).toEqual([expect.objectContaining({ wallets: [WALLET_A], simulationIds: ['a'], evidenceAt: NOW.toISOString() })]);
    expect(recorded).toEqual([expect.objectContaining({ id: 'request-1', approvalId: 'approval-1', simulationIds: ['a'], maxFeeGwei: '5', requestedAt: NOW.toISOString(), expiresAt: new Date(NOW.getTime() + LIVE_REQUEST_LIFETIME_MS).toISOString() })]);
    expect(recorded[0]!.confirmationDigest).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('live-request processing in the host service (T-058)', () => {
  const pending = { id: 'request-1', campaignId: 'cmp_0000000000000000abcdef12', wallets: [WALLET_A], simulationIds: ['a'], approvalId: 'approval-1', evidenceAt: NOW.toISOString(), maxFeeGwei: '5', requestedAt: NOW.toISOString(), expiresAt: '2026-10-24T10:30:00.000Z' };
  const deps = (overrides: Partial<LiveRequestProcessorDeps> = {}) => {
    const calls: string[] = [];
    const events: unknown[] = [];
    const ceilings: Array<[string, number | undefined]> = [];
    const claimed = new Set<string>();
    const value: LiveRequestProcessorDeps = {
      unclaimed: () => [pending].filter((item) => !claimed.has(item.id)),
      claim: (id) => { if (claimed.has(id)) return false; claimed.add(id); calls.push(`claim:${id}`); return true; },
      campaign: () => campaign(),
      command: async (name, input) => { calls.push(`${name}:${String(input.idempotencyKey)}:${String(input.approvalId ?? input.runId)}`); return { id: 'run-1', state: name === 'run' ? 'Completed' : 'Armed' }; },
      setFeeCeiling: (id, gwei) => { ceilings.push([id, gwei]); },
      record: async (event) => { events.push(event); },
      now: () => NOW,
      ...overrides,
    };
    return { value, calls, events, ceilings };
  };

  it('claims first, arms live with the recorded approval, runs under the request fee ceiling, then clears it', async () => {
    const { value, calls, events, ceilings } = deps();
    expect(await processLiveRunRequests(value)).toBe(1);
    expect(calls).toEqual(['claim:request-1', 'arm:live-request:request-1:approval-1', 'run:live-request-run:request-1:run-1']);
    expect(ceilings).toEqual([['cmp_0000000000000000abcdef12', 5], ['cmp_0000000000000000abcdef12', undefined]]);
    expect(events).toEqual([{ requestId: 'request-1', runId: 'run-1', state: 'finished' }]);
    expect(await processLiveRunRequests(value)).toBe(0);
  });

  it('an expired request is claimed as expired and never armed (fail closed)', async () => {
    const { value, calls, events } = deps({ now: () => new Date('2026-10-24T10:30:00.000Z') });
    expect(await processLiveRunRequests(value)).toBe(0);
    expect(calls).toEqual(['claim:request-1']);
    expect(events).toEqual([{ requestId: 'request-1', state: 'expired', code: 'LIVE_REQUEST_EXPIRED' }]);
  });

  it('a request dated in the future is claimed as expired and never armed (fail closed)', async () => {
    const { value, calls, events } = deps({ unclaimed: () => [{ ...pending, requestedAt: '2099-01-01T00:00:00.000Z' }] });
    expect(await processLiveRunRequests(value)).toBe(0);
    expect(calls).toEqual(['claim:request-1']);
    expect(events).toEqual([{ requestId: 'request-1', state: 'expired', code: 'LIVE_REQUEST_TIME_INVALID' }]);
  });

  it('a request another pass already claimed is never armed', async () => {
    const { value, calls } = deps({ claim: () => false });
    expect(await processLiveRunRequests(value)).toBe(0);
    expect(calls).toEqual([]);
  });

  it('a refused arm stops the request with only its fixed code, never provider text, and nothing is run', async () => {
    const { value, calls, events, ceilings } = deps({ command: async (name) => { calls.push(name); throw new Error('APPROVAL_REQUIRED'); } });
    await processLiveRunRequests(value);
    expect(calls).toEqual(['claim:request-1', 'arm']);
    expect(ceilings).toEqual([]);
    expect(events).toEqual([{ requestId: 'request-1', state: 'stopped', code: 'APPROVAL_REQUIRED' }]);
    const leaky = deps({ command: async () => { throw new Error('fetch https://rpc.example/key-123 failed'); } });
    await processLiveRunRequests(leaky.value);
    expect(leaky.events).toEqual([{ requestId: 'request-1', state: 'stopped', code: 'LIVE_REQUEST_FAILED' }]);
  });

  it('a run that returns without completing is stopped under its state and never recorded as finished (fail closed)', async () => {
    for (const state of ['Failed', 'Aborted', undefined]) {
      const { value, events } = deps({ command: async (name) => ({ id: 'run-1', ...(name === 'run' && state ? { state } : {}) }) });
      await processLiveRunRequests(value);
      expect(events).toEqual([{ requestId: 'request-1', runId: 'run-1', state: 'stopped', code: `RUN_${state ? state.toUpperCase() : 'UNKNOWN'}` }]);
    }
  });

  it('a stored fee ceiling outside 0 to 500 gwei is never armed', async () => {
    const { value, calls, events } = deps({ unclaimed: () => [{ ...pending, maxFeeGwei: '900' }] });
    await processLiveRunRequests(value);
    expect(calls).toEqual(['claim:request-1']);
    expect(events).toEqual([{ requestId: 'request-1', state: 'stopped', code: 'MAX_FEE_GWEI_INVALID' }]);
  });

  it('a failed run still clears the fee ceiling and is recorded as stopped with its run', async () => {
    const { value, events, ceilings } = deps({ command: async (name) => { if (name === 'run') throw new Error('KILL_SWITCH_ACTIVE'); return { id: 'run-1' }; } });
    await processLiveRunRequests(value);
    expect(ceilings.at(-1)).toEqual(['cmp_0000000000000000abcdef12', undefined]);
    expect(events).toEqual([{ requestId: 'request-1', runId: 'run-1', state: 'stopped', code: 'KILL_SWITCH_ACTIVE' }]);
  });
});

describe('the request poller keeps every nudge (T-067)', () => {
  it('a tick that arrives while a pass is running makes one more pass instead of being lost', async () => {
    let passes = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const now = new Date();
    const request = { id: 'live_request_1', campaignId: 'c', wallets: ['0x1111111111111111111111111111111111111111'], simulationIds: ['s'], approvalId: 'a', evidenceAt: now.toISOString(), maxFeeGwei: '0.2', requestedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString() };
    const poller = startLiveRequestPoller({
      unclaimed: () => { passes += 1; return passes === 1 ? [request] : []; },
      claim: () => true, campaign: () => ({ id: 'c' }) as Campaign, command: async () => { await gate; return { id: 'run', state: 'Completed' }; }, setFeeCeiling: () => undefined, record: async () => undefined, now: () => new Date(),
    }, { intervalMs: 3_600_000 });
    const first = poller.tick();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await poller.tick();
    expect(passes).toBe(1);
    release();
    await first;
    expect(passes).toBe(2);
    poller.stop();
  });
});

describe('the code shown for a stopped request keeps the failing check visible (second live attempt)', () => {
  it('keeps up to three fixed parts and drops everything else (words, addresses, amounts)', async () => {
    const now = new Date();
    const request = { id: 'live_request_1', campaignId: 'c', wallets: ['0x1111111111111111111111111111111111111111'], simulationIds: ['s'], approvalId: 'a', evidenceAt: now.toISOString(), maxFeeGwei: '0.2', requestedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString() };
    const codeFor = async (message: string): Promise<string | undefined> => {
      const records: Array<{ code?: string }> = [];
      await processLiveRunRequests({ unclaimed: () => [request], claim: () => true, campaign: () => ({ id: 'c' }) as Campaign, command: async () => { throw new Error(message); }, setFeeCeiling: () => undefined, record: async (event) => { records.push(event); }, now: () => now });
      return records[0]?.code;
    };
    expect(await codeFor('READINESS_REFRESH_FAILED:FUNDING_NOT_ARRIVED')).toBe('READINESS_REFRESH_FAILED:FUNDING_NOT_ARRIVED');
    expect(await codeFor('READINESS_REFRESH_FAILED:FUNDING_PLAN_BLOCKED:WALLET_ABOVE_RUN_ENVELOPE')).toBe('READINESS_REFRESH_FAILED:FUNDING_PLAN_BLOCKED:WALLET_ABOVE_RUN_ENVELOPE');
    expect(await codeFor('READINESS_REFRESH_FAILED:FUNDING_PLAN_BLOCKED:0x1111111111111111111111111111111111111111')).toBe('READINESS_REFRESH_FAILED:FUNDING_PLAN_BLOCKED');
    expect(await codeFor('KILLED')).toBe('KILLED');
    expect(await codeFor('some provider said something about https://rpc.example/key')).toBe('LIVE_REQUEST_FAILED');
  });

  it('an uncoded failure keeps only a system error code or a standard error type as a hint, never the text', async () => {
    const now = new Date();
    const request = { id: 'live_request_1', campaignId: 'c', wallets: ['0x1111111111111111111111111111111111111111'], simulationIds: ['s'], approvalId: 'a', evidenceAt: now.toISOString(), maxFeeGwei: '0.2', requestedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString() };
    const codeOf = async (error: unknown): Promise<string | undefined> => {
      const records: Array<{ code?: string }> = [];
      await processLiveRunRequests({ unclaimed: () => [request], claim: () => true, campaign: () => ({ id: 'c' }) as Campaign, command: async () => { throw error; }, setFeeCeiling: () => undefined, record: async (event) => { records.push(event); }, now: () => now });
      return records[0]?.code;
    };
    expect(await codeOf(Object.assign(new Error('open /some/folder/file failed'), { code: 'EACCES' }))).toBe('LIVE_REQUEST_FAILED:EACCES');
    expect(await codeOf(Object.assign(new Error('fetch https://rpc.example/key failed'), { code: 'ETIMEDOUT', name: 'TimeoutError' }))).toBe('LIVE_REQUEST_FAILED:ETIMEDOUT:TIMEOUTERROR');
    expect(await codeOf(new TypeError('cannot read properties of undefined'))).toBe('LIVE_REQUEST_FAILED:TYPEERROR');
    expect(await codeOf(Object.assign(new Error('x'), { code: 'not a code https://rpc.example/key' }))).toBe('LIVE_REQUEST_FAILED');
    expect(await codeOf('a thrown string')).toBe('LIVE_REQUEST_FAILED');
  });
});
