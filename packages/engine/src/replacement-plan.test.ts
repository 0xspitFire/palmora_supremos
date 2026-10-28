import { describe, expect, it } from 'vitest';
import { MintEngine } from './mint-engine.js';
import type { MintJobConfig } from './types.js';

const CONTRACT = '0x1111111111111111111111111111111111111111' as const;
type Planner = { replacementPlan(chainId: number, broadcaster: string): { ceiling: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }; maxBumps: number; stuckAfterMs: number } | undefined };

function config(overrides: { bumps?: number; dryRun?: boolean; replacement?: MintJobConfig['fees']['replacement'] | null } = {}): MintJobConfig {
  const replacement = overrides.replacement === null ? undefined : (overrides.replacement ?? { ceilingMaxFeePerGasGwei: 1.3, ceilingMaxPriorityFeePerGasGwei: 0.13, stuckAfterMs: 8_000, policyLimits: { maxFeePerGasGwei: 1.3, maxPriorityFeePerGasGwei: 0.13 }, ownerCap: { maxFeePerGasGwei: 9, maxPriorityFeePerGasGwei: 9 } });
  return {
    target: { chain: 'robinhood', contract: CONTRACT, strategy: 'seadrop-v1-public', quantity: 1, campaignId: 'c' },
    fleet: { walletFile: '/tmp/never-read-wallet-file', maxWallets: 1 },
    timing: { mintStartUnix: 'auto', armBeforeMs: 30_000 },
    fees: { maxFeePerGasGwei: 1, maxPriorityFeePerGasGwei: 0.1, gasLimitPadding: 1.1, ...(replacement ? { replacement } : {}) },
    safety: { maxSpendEth: 1, dailySpendCapEth: 1, maxReplacementBumps: overrides.bumps ?? 2, dryRun: overrides.dryRun ?? false, killSwitchFile: '/tmp/mintbot-t094-kill' },
    broadcast: { mode: 'sequencer', rpcEndpoints: [], blastParallel: false },
    observability: { logLevel: 'error', logFile: '/tmp/mintbot-t094.log' },
  };
}
const plan = (cfg: MintJobConfig, chainId = 4663, broadcaster = 'sequencer-direct') => (new MintEngine(cfg) as unknown as Planner).replacementPlan(chainId, broadcaster);

describe('T-094 when replacement is enabled', () => {
  it('is off by default: no replacement block means nothing is replaced even with bumps configured', () => {
    expect(plan(config({ replacement: null }))).toBeUndefined();
  });

  it('is off with zero bumps and in dry runs', () => {
    expect(plan(config({ bumps: 0 }))).toBeUndefined();
    expect(plan(config({ dryRun: true }))).toBeUndefined();
  });

  it('is only for public or sequencer sends on Base and Robinhood, never Ethereum or Flashbots bundles', () => {
    expect(plan(config(), 1)).toBeUndefined();
    expect(plan(config(), 4663, 'flashbots')).toBeUndefined();
    expect(plan(config(), 4663)).toBeDefined();
    expect(plan(config(), 8453, 'public-mempool')).toBeDefined();
  });

  it('returns the ceiling and applies a floor to the stuck time', () => {
    const planned = plan(config())!;
    expect(planned).toMatchObject({ maxBumps: 2, stuckAfterMs: 8_000 });
    expect(planned.ceiling).toEqual({ maxFeePerGas: 1_300_000_000n, maxPriorityFeePerGas: 130_000_000n });
    expect(plan(config({ replacement: { ceilingMaxFeePerGasGwei: 1.3, ceilingMaxPriorityFeePerGasGwei: 0.13, stuckAfterMs: 500, policyLimits: { maxFeePerGasGwei: 1.3, maxPriorityFeePerGasGwei: 0.13 }, ownerCap: { maxFeePerGasGwei: 9, maxPriorityFeePerGasGwei: 9 } } }))!.stuckAfterMs).toBe(6_000);
  });

  it('refuses the whole run, before anything is signed, when the ceiling cannot hold the configured bumps', () => {
    // two bumps from 1 / 0.1 gwei need 1.21 / 0.121 gwei
    expect(() => plan(config({ replacement: { ceilingMaxFeePerGasGwei: 1.2, ceilingMaxPriorityFeePerGasGwei: 0.13, stuckAfterMs: 8_000, policyLimits: { maxFeePerGasGwei: 9, maxPriorityFeePerGasGwei: 9 }, ownerCap: { maxFeePerGasGwei: 9, maxPriorityFeePerGasGwei: 9 } } }))).toThrow('too low');
    expect(() => plan(config({ replacement: { ceilingMaxFeePerGasGwei: 1.3, ceilingMaxPriorityFeePerGasGwei: 0.12, stuckAfterMs: 8_000, policyLimits: { maxFeePerGasGwei: 9, maxPriorityFeePerGasGwei: 9 }, ownerCap: { maxFeePerGasGwei: 9, maxPriorityFeePerGasGwei: 9 } } }))).toThrow('too low');
    expect(() => plan(config({ replacement: { ceilingMaxFeePerGasGwei: 0.1, ceilingMaxPriorityFeePerGasGwei: 2, stuckAfterMs: 8_000, policyLimits: { maxFeePerGasGwei: 9, maxPriorityFeePerGasGwei: 9 }, ownerCap: { maxFeePerGasGwei: 9, maxPriorityFeePerGasGwei: 9 } } }))).toThrow();
    expect(() => plan(config({ bumps: 9 }))).toThrow('invalid');
  });

  it('refuses the run when the ceiling is not inside the signed provider policy limits, or the limits are missing', () => {
    const ceiling = { ceilingMaxFeePerGasGwei: 1.3, ceilingMaxPriorityFeePerGasGwei: 0.13, stuckAfterMs: 8_000 };
    expect(() => plan(config({ replacement: { ...ceiling, policyLimits: { maxFeePerGasGwei: 1.29, maxPriorityFeePerGasGwei: 0.13 }, ownerCap: { maxFeePerGasGwei: 9, maxPriorityFeePerGasGwei: 9 } } }))).toThrow('signed provider policy');
    expect(() => plan(config({ replacement: { ...ceiling, policyLimits: { maxFeePerGasGwei: 1.3, maxPriorityFeePerGasGwei: 0.12 }, ownerCap: { maxFeePerGasGwei: 9, maxPriorityFeePerGasGwei: 9 } } }))).toThrow('signed provider policy');
    expect(() => plan(config({ replacement: ceiling as never }))).toThrow('signed provider policy');
    expect(plan(config({ replacement: { ...ceiling, policyLimits: { maxFeePerGasGwei: 1.3, maxPriorityFeePerGasGwei: 0.13 }, ownerCap: { maxFeePerGasGwei: 9, maxPriorityFeePerGasGwei: 9 } } }))).toBeDefined();
  });

  it('refuses the run when the ceiling is above what the owner approved for this campaign, or the owner cap is missing', () => {
    const base = { ceilingMaxFeePerGasGwei: 1.3, ceilingMaxPriorityFeePerGasGwei: 0.13, stuckAfterMs: 8_000, policyLimits: { maxFeePerGasGwei: 9, maxPriorityFeePerGasGwei: 9 } };
    expect(() => plan(config({ replacement: { ...base, ownerCap: { maxFeePerGasGwei: 1.29, maxPriorityFeePerGasGwei: 9 } } }))).toThrow('owner fee cap');
    expect(() => plan(config({ replacement: { ...base, ownerCap: { maxFeePerGasGwei: 9, maxPriorityFeePerGasGwei: 0.12 } } }))).toThrow('owner fee cap');
    expect(() => plan(config({ replacement: base as never }))).toThrow('owner fee cap');
    expect(plan(config({ replacement: { ...base, ownerCap: { maxFeePerGasGwei: 1.3, maxPriorityFeePerGasGwei: 0.13 } } }))).toBeDefined();
  });
});

describe('T-094 engine wiring', () => {
  it('reserves at the ceiling, reconciles against the whole hash set, and only replaces after the original was sent', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('./mint-engine.ts', import.meta.url), 'utf8');
    expect(source).toContain('reservedMaxFeePerGas: replacement.ceiling.maxFeePerGas');
    expect(source).toContain('maxGasCostWei: gasLimit * reserveFee');
    expect(source).toContain('ownHashes: watched');
    // the ladder starts only after the original broadcast succeeded and its attempt was persisted
    expect(source.indexOf('runReplacementLadder({')).toBeGreaterThan(source.indexOf('nonceManager.consumeNonce(walletAddress);'));
    // every replacement re-checks kill switch / grant / drop / simulation before signing, signs inside the admission gate, and verifies what was signed
    const ladderBlock = source.slice(source.indexOf('const ladderDeps'), source.indexOf('const ladder = await runReplacementLadder'));
    for (const needle of ['this.checkKill()', 'assertDirectChainExecutionPolicy(', 'recheckDrop?.()', 'simulateMint(', 'admissionGate.enter()', 'assertSignedMatchesIntent(', 'REPLACEMENT_ABOVE_CEILING', 'persistAttempt(']) expect(ladderBlock).toContain(needle);
    expect(ladderBlock.indexOf('persistAttempt(')).toBeLessThan(ladderBlock.indexOf('broadcaster.broadcast('));
    // no second bump mechanism: replacement broadcasts pass zero bumps to the broadcaster
    expect(ladderBlock).toContain('{ maxBumps: 0 }');
  });
});
