import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildCompensatingEvidence,
  engageKillSwitchFile,
  evaluateStatus,
  lockfileDigest,
  parseRehearsalEvidence,
  probeOrEngageKillSwitch,
  walletSetDigest,
} from './compensating-controls-cli.js';

const NOW = new Date('2026-10-22T12:00:00.000Z');
const W1 = '0x1111111111111111111111111111111111111111';
const W2 = '0x2222222222222222222222222222222222222222';
const RECORD = `sha256:${'a'.repeat(64)}`;

describe('compensating controls evidence assembly (D-058, D-059)', () => {
  it('digests the wallet set independent of order, case and duplicates, and refuses bad input', () => {
    expect(walletSetDigest([W2, W1])).toBe(walletSetDigest([W1.toUpperCase().replace('0X', '0x'), W2, W1]));
    expect(walletSetDigest([W1])).not.toBe(walletSetDigest([W1, W2]));
    expect(() => walletSetDigest([])).toThrow('COMPENSATING_WALLET_SET_EMPTY');
    expect(() => walletSetDigest(['nope'])).toThrow('COMPENSATING_WALLET_ADDRESS_INVALID');
  });

  it('digests the lockfile and fails closed when it is missing or changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mint-lock-'));
    try {
      await expect(lockfileDigest(root)).rejects.toThrow('COMPENSATING_LOCKFILE_UNAVAILABLE');
      await writeFile(join(root, 'pnpm-lock.yaml'), 'a: 1\n');
      const first = await lockfileDigest(root);
      await writeFile(join(root, 'pnpm-lock.yaml'), 'a: 2\n');
      expect(await lockfileDigest(root)).not.toBe(first);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects rehearsal evidence written before the two digests existed, so the rehearsal must be repeated', () => {
    const old = { type: 'turnkey-signing-rehearsal', recordedAt: NOW.toISOString(), policyRecordDigest: RECORD, safety: { broadcastAttempted: false } };
    expect(() => parseRehearsalEvidence(old)).toThrow('REHEARSAL_EVIDENCE_NEEDS_REPEAT');
    expect(() => parseRehearsalEvidence({ type: 'other' })).toThrow('REHEARSAL_EVIDENCE_INVALID');
    expect(parseRehearsalEvidence({ ...old, walletSetDigest: RECORD, lockfileDigest: RECORD }).broadcastAttempted).toBe(false);
    expect(parseRehearsalEvidence({ ...old, walletSetDigest: RECORD, lockfileDigest: RECORD, safety: {} }).broadcastAttempted).toBe(true);
  });

  it('engages the kill switch on any probe failure and never reports success after it', async () => {
    const engaged: string[] = [];
    const good = await probeOrEngageKillSwitch(async () => ({ status: 'ok', policyRecordDigest: RECORD }), async (reason) => { engaged.push(reason); }, () => NOW);
    expect(good).toEqual({ observedAt: NOW.toISOString(), status: 'ok', policyRecordDigest: RECORD });
    expect(engaged).toEqual([]);
    await expect(probeOrEngageKillSwitch(async () => { throw new Error('TURNKEY_POLICY_DRIFT'); }, async (reason) => { engaged.push(reason); })).rejects.toThrow('TURNKEY_PROVIDER_DRIFT_KILL_SWITCH_ENGAGED');
    expect(engaged).toHaveLength(1);
    expect(engaged[0]).toBe('provider-probe-failed'); // a fixed code: provider error text never reaches the kill-switch file
    // even when engaging itself fails, the caller still gets the failure and no success evidence
    await expect(probeOrEngageKillSwitch(async () => { throw new Error('x'); }, async () => { throw new Error('disk'); })).rejects.toThrow('TURNKEY_PROVIDER_DRIFT_KILL_SWITCH_ENGAGED');
    await expect(probeOrEngageKillSwitch(async () => ({ status: 'bad' as never, policyRecordDigest: RECORD }), async (reason) => { engaged.push(reason); })).rejects.toThrow('TURNKEY_PROVIDER_DRIFT_KILL_SWITCH_ENGAGED');
  });

  it('creates the kill-switch file with owner-only mode and never overwrites an existing one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mint-kill-'));
    try {
      const path = join(root, 'killswitch');
      await engageKillSwitchFile(path, 'first');
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      await engageKillSwitchFile(path, 'second');
      expect((await readFile(path, 'utf8')).trim()).toBe('first');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  describe('assembled evidence', () => {
    const build = (over: Partial<Parameters<typeof buildCompensatingEvidence>[0]> = {}) => buildCompensatingEvidence({
      chainId: 1,
      record: { digest: RECORD, issuedAt: '2026-10-20T00:00:00.000Z', expiresAt: '2026-10-29T00:00:00.000Z', wallets: [W1, W2] },
      lockfileDigest: `sha256:${'c'.repeat(64)}`,
      probe: { observedAt: NOW.toISOString(), status: 'ok', policyRecordDigest: RECORD },
      balances: [{ address: W1, balanceWei: 300_000_000_000_000n }, { address: W2, balanceWei: 0n }],
      rehearsal: { recordedAt: '2026-10-21T00:00:00.000Z', policyRecordDigest: RECORD, walletSetDigest: walletSetDigest([W1, W2]), lockfileDigest: `sha256:${'c'.repeat(64)}`, broadcastAttempted: false },
      now: NOW,
      ...over,
    });
    const config = { ceilings: { 1: { walletMaxWei: 400_000_000_000_000n, fleetMaxWei: 2_000_000_000_000_000n } }, expected: { recordDigest: RECORD, walletSetDigest: walletSetDigest([W1, W2]), lockfileDigest: `sha256:${'c'.repeat(64)}` } };

    it('is valid with all six inputs and the status text never says TVC verified', () => {
      const status = evaluateStatus(build(), config, NOW);
      expect(status.valid).toBe(true);
      expect(status.text).toContain('NOT Turnkey TVC attestation');
      expect(status.text).not.toMatch(/TVC verified/i);
    });

    it('names the missing control in plain words when the rehearsal or the review is absent', () => {
      const missingRehearsal = evaluateStatus(build({ rehearsal: undefined }), config, NOW);
      expect(missingRehearsal.valid).toBe(false);
      expect(missingRehearsal.text).toContain('MISSING No-broadcast rehearsal');
      expect(evaluateStatus(build(), config, NOW).text).not.toContain('Trust Center');
      expect(evaluateStatus(undefined, config, NOW).valid).toBe(false);
    });

    it('flags an over-funded wallet and a rehearsal made for different dependencies', () => {
      expect(evaluateStatus(build({ balances: [{ address: W1, balanceWei: 400_000_000_000_001n }] }), config, NOW).text).toContain('WALLET_ABOVE_LIMIT');
      expect(evaluateStatus(build({ lockfileDigest: `sha256:${'9'.repeat(64)}` }), { ...config, expected: { ...config.expected, lockfileDigest: `sha256:${'9'.repeat(64)}` } }, NOW).text).toContain('DEPENDENCIES_CHANGED');
    });
  });
});
