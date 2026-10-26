import { describe, expect, it } from 'vitest';
import { assertLiveOperationalReadiness, computeWalletSetDigest, type AssuranceRun, type Campaign, type CompensatingAssuranceContext, type OperationalReadiness } from '@mint-bot/backend';
import { createHash } from 'node:crypto';
import { assertApproverKeyPin } from './turnkey-readiness-service.js';
import { createTurnkeyReadiness, type ReadinessSigner, type TurnkeyReadinessOptions, type VerifiedTurnkeyRecord } from './turnkey-readiness.js';

/**
 * T-042 binding requirements 1 to 4 at the service: fresh in-process observation, expectations only from the verified record,
 * the probe at start and before every arm with the kill switch on failure, and a record that changes after start is refused.
 * The record is judged by the REAL arm-gate assertion, so what the service writes is exactly what a run would be held to.
 */
const NOW = new Date('2026-10-23T12:00:00.000Z');
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const W1 = '0x1111111111111111111111111111111111111111';
const W2 = '0x2222222222222222222222222222222222222222';
const OUTSIDER = '0x9999999999999999999999999999999999999999';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const LOCK = `sha256:${'c'.repeat(64)}`;

const verified = (overrides: Partial<VerifiedTurnkeyRecord> = {}): VerifiedTurnkeyRecord => ({
  digest: DIGEST,
  issuedAt: new Date(NOW.getTime() - DAY).toISOString(),
  expiresAt: new Date(NOW.getTime() + 5 * DAY).toISOString(),
  chainId: 1,
  organizationId: 'org-dev',
  policyReference: `turnkey:policy-1:0x${'ab'.repeat(32)}`,
  policyDigest: `0x${'ab'.repeat(32)}`,
  addresses: [W1, W2],
  ...overrides,
});

const campaign = (overrides: Partial<Campaign> = {}): Campaign => ({
  id: 'c1', chainId: 1, quantity: 1, mintPriceWei: 0n, feePolicy: { kind: 'free', configuredPriorityFeeWei: 0n, totalFeeBudgetWei: 300_000_000_000_000n },
  ...overrides,
} as unknown as Campaign);

const run = (overrides: Partial<AssuranceRun> = {}): AssuranceRun => ({ chainId: 1, wallets: [W1], campaign: campaign(), ...overrides });

const rehearsalFile = (record = DIGEST) => ({
  type: 'turnkey-signing-rehearsal', recordedAt: new Date(NOW.getTime() - DAY).toISOString(), policyRecordDigest: record,
  walletSetDigest: computeWalletSetDigest([W1, W2]), lockfileDigest: LOCK, safety: { broadcastAttempted: false },
});

interface Harness { options: TurnkeyReadinessOptions; recorded: OperationalReadiness[]; kills: string[]; zeroized: { count: number }; probes: { count: number }; state: { record: VerifiedTurnkeyRecord; balances: bigint; probeDigest: string; probeFails: boolean; rehearsal: unknown; reconciledAt: string | undefined; now: Date } }

function harness(overrides: Partial<TurnkeyReadinessOptions> = {}): Harness {
  const state = { record: verified(), balances: 400_000_000_000_000n, probeDigest: DIGEST, probeFails: false, rehearsal: rehearsalFile() as unknown, reconciledAt: new Date(NOW.getTime() - 2 * MIN).toISOString() as string | undefined, now: NOW };
  const recorded: OperationalReadiness[] = [];
  const kills: string[] = [];
  const zeroized = { count: 0 };
  const probes = { count: 0 };
  const signer = (): ReadinessSigner => ({
    probe: async () => { probes.count += 1; if (state.probeFails) throw new Error('provider said something with a secret'); return { status: 'ok', policyRecordDigest: state.probeDigest }; },
    zeroize: () => { zeroized.count += 1; },
  });
  const options: TurnkeyReadinessOptions = {
    readSigned: async () => ({ signed: {}, publicKey: 'pinned' }),
    verifyRecord: () => state.record,
    readOptional: async () => state.rehearsal,
    lockfileDigest: async () => LOCK,
    createSigner: async () => signer(),
    readBalances: async (_chain, addresses) => addresses.map((address) => ({ address, balanceWei: state.balances })),
    engageKillSwitch: async (reason) => { kills.push(reason); },
    killSwitchEngaged: async () => false,
    notificationsReady: async () => true,
    reconciledAt: () => state.reconciledAt,
    chainVerified: () => true,
    secretStoreReference: 'secret-store-ref',
    storePath: '/var/lib/mint-bot/db/mintbot.sqlite',
    now: () => state.now,
    record: async (operational: OperationalReadiness, context: CompensatingAssuranceContext) => {
      // The real arm-gate assertion, with the binding the service derived from the verified record.
      assertLiveOperationalReadiness(operational, state.now, { provider: 'turnkey', providerIdentity: 'org-dev', policyReference: `turnkey:policy-1:0x${'ab'.repeat(32)}`, policyDigest: `0x${'ab'.repeat(32)}` }, undefined, context);
      recorded.push(operational);
    },
    ...overrides,
  };
  return { options, recorded, kills, zeroized, probes, state };
}

describe('Turnkey readiness at the service (T-042 requirements 1 to 4)', () => {
  it('derives the expected custody policy from the verified record only', async () => {
    const h = harness();
    const readiness = await createTurnkeyReadiness(h.options);
    expect(readiness.expectedCustodyPolicy).toEqual({ provider: 'turnkey', providerIdentity: 'org-dev', policyReference: `turnkey:policy-1:0x${'ab'.repeat(32)}`, policyDigest: `0x${'ab'.repeat(32)}`, recordDigest: DIGEST });
  });

  it('refuses to start when the record cannot be verified (bad signature or expired)', async () => {
    const h = harness({ verifyRecord: () => { throw new Error('TURNKEY_POLICY_RECORD_EXPIRED'); } });
    await expect(createTurnkeyReadiness(h.options)).rejects.toThrow('TURNKEY_POLICY_RECORD_EXPIRED');
  });

  it('a refresh probes just now, reads balances in-process, and records readiness the real arm gate accepts', async () => {
    const h = harness();
    const readiness = await createTurnkeyReadiness(h.options);
    await readiness.refresh(run());
    expect(h.probes.count).toBe(1);
    expect(h.zeroized.count).toBe(1);
    const operational = h.recorded[0]!;
    expect(operational.custody).toMatchObject({ provider: 'turnkey', assuranceKind: 'turnkey-compensating-controls', attestationStatus: 'unknown', providerIdentity: 'org-dev' });
    expect(Date.parse(operational.expiresAt) - Date.parse(operational.observedAt)).toBe(10 * MIN);
    expect(operational.custody?.compensatingControls?.balances?.wallets).toHaveLength(2);
    expect(JSON.stringify(operational)).not.toMatch(/apiPrivate|privateKey|mnemonic|password|provider said/i);
  });

  it('every refresh probes again: nothing is reused from an earlier observation', async () => {
    const h = harness();
    const readiness = await createTurnkeyReadiness(h.options);
    await readiness.refresh(run());
    await readiness.refresh(run());
    expect(h.probes.count).toBe(2);
    expect(h.recorded).toHaveLength(2);
  });

  it('a failed probe engages the kill switch with a fixed reason, hides the provider text and records nothing', async () => {
    const h = harness();
    const readiness = await createTurnkeyReadiness(h.options);
    h.state.probeFails = true;
    await expect(readiness.refresh(run())).rejects.toThrow('TURNKEY_PROVIDER_DRIFT_KILL_SWITCH_ENGAGED');
    expect(h.kills).toEqual(['provider-probe-failed']);
    expect(h.recorded).toHaveLength(0);
    expect(h.zeroized.count).toBe(1);
  });

  it('a provider that vouches for a different record is drift: kill switch, no readiness', async () => {
    const h = harness();
    const readiness = await createTurnkeyReadiness(h.options);
    h.state.probeDigest = `sha256:${'f'.repeat(64)}`;
    await expect(readiness.refresh(run())).rejects.toThrow('TURNKEY_PROVIDER_DRIFT_KILL_SWITCH_ENGAGED');
    expect(h.kills.length).toBeGreaterThan(0);
    expect(h.recorded).toHaveLength(0);
  });

  it('the start-up probe also engages the kill switch on failure', async () => {
    const h = harness();
    const readiness = await createTurnkeyReadiness(h.options);
    await readiness.probeAtStart();
    expect(h.probes.count).toBe(1);
    h.state.probeFails = true;
    await expect(readiness.probeAtStart()).rejects.toThrow('TURNKEY_PROVIDER_DRIFT_KILL_SWITCH_ENGAGED');
    expect(h.kills).toEqual(['provider-probe-failed']);
  });

  it('a record that changes after start (even if validly signed) is refused until the service is restarted', async () => {
    const h = harness();
    const readiness = await createTurnkeyReadiness(h.options);
    h.state.record = verified({ digest: `sha256:${'b'.repeat(64)}` });
    await expect(readiness.refresh(run())).rejects.toThrow('TURNKEY_RECORD_CHANGED_RESTART_REQUIRED');
    await expect(readiness.probeAtStart()).rejects.toThrow('TURNKEY_RECORD_CHANGED_RESTART_REQUIRED');
    expect(h.probes.count).toBe(0);
    expect(h.recorded).toHaveLength(0);
  });

  it('refuses a chain or a wallet the record does not cover, before any provider call', async () => {
    const h = harness();
    const readiness = await createTurnkeyReadiness(h.options);
    await expect(readiness.refresh(run({ chainId: 8453 }))).rejects.toThrow('TURNKEY_RECORD_CHAIN_MISMATCH');
    await expect(readiness.refresh(run({ wallets: [OUTSIDER] }))).rejects.toThrow('TURNKEY_WALLET_NOT_IN_RECORD');
    await expect(readiness.refresh(run({ wallets: [] }))).rejects.toThrow('TURNKEY_WALLET_NOT_IN_RECORD');
    expect(h.probes.count).toBe(0);
  });

  it('without the owner-run rehearsal record the real gate names the missing control and nothing is recorded', async () => {
    const h = harness();
    const readiness = await createTurnkeyReadiness(h.options);
    h.state.rehearsal = undefined;
    await expect(readiness.refresh(run())).rejects.toThrow('COMPENSATING_CONTROL_REHEARSAL');
    // a rehearsal bound to another record does not count either
    h.state.rehearsal = rehearsalFile(`sha256:${'e'.repeat(64)}`);
    await expect(readiness.refresh(run())).rejects.toThrow('COMPENSATING_CONTROL_REHEARSAL');
    expect(h.recorded).toHaveLength(0);
  });

  it('refuses without a reconciliation time and when the funding has not arrived or is above the run limit', async () => {
    const h = harness();
    const readiness = await createTurnkeyReadiness(h.options);
    h.state.reconciledAt = undefined;
    await expect(readiness.refresh(run())).rejects.toThrow('RECONCILIATION_REQUIRED');
    h.state.reconciledAt = new Date(NOW.getTime() - MIN).toISOString();
    h.state.balances = 100_000_000_000_000n; // needs 0.0003 for the run
    await expect(readiness.refresh(run())).rejects.toThrow('FUNDING_NOT_ARRIVED');
    h.state.balances = 5_000_000_000_000_000n; // above the 0.0041 run limit
    await expect(readiness.refresh(run())).rejects.toThrow(/WALLET_ABOVE_RUN_ENVELOPE|WALLET_ABOVE_LIMIT/);
    expect(h.recorded).toHaveLength(0);
  });

  it('the assurance exists only after a fresh refresh for the same chain, and goes stale after a minute', async () => {
    const h = harness();
    const readiness = await createTurnkeyReadiness(h.options);
    expect(() => readiness.assurance(run())).toThrow('READINESS_NOT_REFRESHED');
    await readiness.refresh(run());
    const config = readiness.assurance(run());
    expect(config.expected).toEqual({ recordDigest: DIGEST, walletSetDigest: computeWalletSetDigest([W1, W2]), lockfileDigest: LOCK });
    expect(config.minimumBalanceWei?.[W1]).toBe('300000000000000');
    expect(BigInt(config.runEnvelopeWei?.[W1] ?? '0')).toBeLessThanOrEqual(4_100_000_000_000_000n);
    expect(() => readiness.assurance(run({ chainId: 8453 }))).toThrow('READINESS_NOT_REFRESHED');
    h.state.now = new Date(NOW.getTime() + 61_000);
    expect(() => readiness.assurance(run())).toThrow('READINESS_NOT_REFRESHED');
  });

  it('a paid run above the run-time funding limit is refused with the plain funding code, and a run without a fee budget cannot arm', async () => {
    const h = harness();
    const readiness = await createTurnkeyReadiness(h.options);
    await readiness.refresh(run());
    expect(() => readiness.assurance(run({ campaign: campaign({ mintPriceWei: 4_100_000_000_000_000n }) }))).toThrow(/FUNDING_PLAN_BLOCKED:RUN_ENVELOPE_ABOVE_CHAIN_BOUND/);
    expect(() => readiness.assurance(run({ campaign: campaign({ feePolicy: { kind: 'free', configuredPriorityFeeWei: 0n } as never }) }))).toThrow('TOTAL_FEE_BUDGET_REQUIRED');
  });
});

describe('a failing readiness step names itself with a fixed code (the second live attempt)', () => {
  const stepFails = async (over: Partial<TurnkeyReadinessOptions>, expected: string) => {
    const h = harness(over);
    const readiness = await createTurnkeyReadiness(h.options);
    const error = await readiness.refresh(run()).then(() => undefined, (caught: Error) => caught);
    expect(error?.message).toBe(expected);
    expect(error?.message).not.toMatch(/https?:|secret|provider said|0x[0-9a-f]{8}/i);
    expect(h.recorded).toHaveLength(0);
  };

  it('each step that can fail with provider text is reported as that step, never as the text', async () => {
    await stepFails({ readBalances: async () => { throw new Error('HTTP request failed. URL: https://rpc.example/key123 Status: 429'); } }, 'READINESS_BALANCES_UNREADABLE');
    await stepFails({ lockfileDigest: async () => { throw new Error('ENOENT: no such file, open the lockfile'); } }, 'READINESS_LOCKFILE_UNREADABLE');
    await stepFails({ createSigner: async () => { throw new Error('could not read the settings file'); } }, 'READINESS_SIGNER_UNAVAILABLE');
    await stepFails({ record: async () => { throw new Error('some library said something'); } }, 'READINESS_RECORD_REJECTED');
  });

  it('a step that already raises a fixed code keeps it; the funding refusal shows its reason without the wallet address', async () => {
    await stepFails({ lockfileDigest: async () => { throw new Error('COMPENSATING_LOCKFILE_UNAVAILABLE'); } }, 'COMPENSATING_LOCKFILE_UNAVAILABLE');
    const h = harness();
    const readiness = await createTurnkeyReadiness(h.options);
    await readiness.refresh(run());
    h.state.balances = 5_000_000_000_000_000n;
    await expect(readiness.refresh(run())).rejects.toThrow(/^READINESS_RECORD_REJECTED$|^FUNDING_PLAN_BLOCKED:WALLET_ABOVE_RUN_ENVELOPE$/);
  });

  it('a record that cannot be read at refresh time is reported as such', async () => {
    let reads = 0;
    const h = harness({ readSigned: async () => { reads += 1; if (reads > 1) throw new Error('permission denied reading the policy record'); return { signed: {}, publicKey: 'pinned' }; } });
    const readiness = await createTurnkeyReadiness(h.options);
    await expect(readiness.refresh(run())).rejects.toThrow(/^READINESS_RECORD_UNREADABLE$/);
  });
});

describe('pinned approver key (digest in settings the service cannot change)', () => {
  const key = '-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----\n';
  const pin = createHash('sha256').update(key, 'utf8').digest('hex');
  it('accepts the key whose digest is pinned, in either letter case', () => {
    expect(() => assertApproverKeyPin(key, pin)).not.toThrow();
    expect(() => assertApproverKeyPin(key, pin.toUpperCase())).not.toThrow();
  });
  it('refuses a swapped key, a changed byte, and a malformed pin', () => {
    expect(() => assertApproverKeyPin(`${key} `, pin)).toThrow('TURNKEY_APPROVER_KEY_PIN_MISMATCH');
    expect(() => assertApproverKeyPin('other', pin)).toThrow('TURNKEY_APPROVER_KEY_PIN_MISMATCH');
    expect(() => assertApproverKeyPin(key, '')).toThrow('TURNKEY_APPROVER_KEY_PIN_MISMATCH');
    expect(() => assertApproverKeyPin(key, 'z'.repeat(64))).toThrow('TURNKEY_APPROVER_KEY_PIN_MISMATCH');
  });
});
