import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Production evidence artifacts and the owner's acceptance (infrastructure design, "Evidence contract" and "Go/no-go conditions").
 * The collectors are driven here by a fake host; the rules they enforce are the point: an artifact exists only when every required
 * check passed, a check that cannot be made is a failure, and the acceptance stops counting the moment an artifact changes.
 */
const here = dirname(fileURLToPath(import.meta.url));
const scripts = join(here, '..', '..', '..', 'scripts');
interface Check { name: string; result: string; observed: string }
interface Lib {
  KINDS: string[];
  REQUIRED_CHECKS: Record<string, string[]>;
  OPS_EVIDENCE_ACCEPTANCE_VALIDITY_MS: number;
  OPS_EVIDENCE_ACCEPTANCE_VERSION: number;
  OPS_EVIDENCE_MAX_AGE_MS: Record<string, number>;
  sha256Hex(data: string): string;
  sanitize(text: string, max?: number): string;
  validateEvidence(value: unknown, kind: string, now?: Date): string[];
  acceptancePhrase(digests: Record<string, string>, design: string): string;
  buildAcceptance(input: { digests: Record<string, string>; designSha256: string; witness: string; acceptedAt: string }): Record<string, unknown>;
  verifyAcceptance(acceptance: unknown, artifacts: Record<string, unknown>, identity: { currentCommit: string; hostId: string; now?: Date }): string[];
}
interface Collector {
  collect(kind: string, io: unknown, env?: Record<string, string>, options?: { restoreDrill?: string; recoveryDrill?: string; rotationDrill?: string }): Promise<{ artifact: { kind: string; environment: string; hostId: string; release: { commit: string }; checks: Check[]; references: Array<{ name: string }> }; failed: Check[]; problems: string[] }>;
  hasRollback(entries: unknown): boolean;
  parseHistory(text: string): unknown;
}
const lib = (await import(join(scripts, 'ops-evidence-lib.mjs'))) as Lib;
const collector = (await import(join(scripts, 'ops-evidence-collect.mjs'))) as Collector;
const runtime = await import(join(scripts, 'ops-evidence-runtime.mjs')) as {
  evaluateOpsEvidence(options?: Record<string, unknown>): Promise<{ humanEvidenceComplete: boolean; missing: string[]; acceptanceProblems: string[] }>;
  assertOpsEvidenceAccepted(options?: Record<string, unknown>): Promise<unknown>;
};

const COMMIT = 'a'.repeat(40);
const NOW = new Date('2026-10-23T12:00:00.000Z');

type Responses = Record<string, string | { ok: false; stdout?: string }>;
function fakeIo(overrides: { exec?: Responses; files?: Record<string, string>; health?: { status: number; body: string } } = {}) {
  const exec: Responses = {
    'systemctl show mint-bot.service -p User --value': 'mintbot',
    'systemctl show mint-bot.service -p Group --value': 'mintbot',
    'systemctl show mint-bot.service -p SupplementaryGroups --value': 'mintbot-status',
    'systemctl show mint-bot.service -p NoNewPrivileges --value': 'yes',
    'systemctl show mint-bot.service -p ProtectSystem --value': 'strict',
    'systemctl show mint-bot.service -p LimitCORE --value': '0',
    'systemctl show mint-bot.service -p CapabilityBoundingSet --value': '',
    'systemctl show mint-bot.service -p UMask --value': '0077',
    'systemctl show mint-bot.service -p DropInPaths --value': '',
    'systemctl show mint-bot.service -p Restart --value': 'on-failure',
    'systemctl show mint-bot.service -p StartLimitBurst --value': '5',
    'systemctl show mint-bot.service -p StartLimitIntervalUSec --value': '5min',
    'systemctl show mint-bot.service -p MainPID --value': '4242',
    'systemctl show mint-bot.service -p Environment --value': '',
    'systemctl show mint-bot-backup.timer -p TimersCalendar --value': '*-*-* 00,06,12,18:15:00 UTC',
    'systemctl is-active mint-bot.service': 'active',
    'systemctl is-enabled mint-bot-backup.timer': 'enabled',
    'systemctl is-active mint-bot-backup.timer': 'active',
    'journalctl -u mint-bot.service --no-pager -o cat --since 30 days ago': 'Scheduled restart job, restart counter is at 5.\nStart request repeated too quickly.',
    'stat -c %U:%G %a /var/log/mint-bot': 'mintbot:mintbot 700',
    'stat -c %U:%G %a /opt/mint-bot/releases': 'root:root 755',
    [`stat -c %U:%G %a /opt/mint-bot/releases/${COMMIT}`]: 'root:root 755',
    'stat -c %U:%G %a /var/log/mint-bot/orchestrator.log': 'mintbot:mintbot 600',
    'coredumpctl list --no-pager': 'No coredumps found.',
    '/usr/bin/node -e console.log(require(\'v8\').getHeapStatistics().heap_size_limit)': '2197815296',
    ...overrides.exec,
  };
  const files: Record<string, string> = {
    '/etc/mint-bot/mint-bot.env': 'MINT_BOT_HOST_ID=palmora-prod-1\nMINT_BOT_SERVICE_MODE=dry-run\n',
    '/opt/mint-bot/current/RELEASE': `commit=${COMMIT}\nbuilt_at=2026-10-23T00:00:00Z\n`,
    '/opt/mint-bot/releases/.history': '2026-10-22T16:00:00Z none -> /r/aaa\n2026-10-22T17:00:00Z /r/aaa -> /r/bbb\n2026-10-22T18:00:00Z /r/bbb -> /r/aaa\n',
    '/proc/4242/limits': 'Max core file size        0                    0                    bytes\n',
    '/proc/sys/kernel/core_pattern': '|/usr/share/apport/apport -p%p\n',
    '/var/lib/mint-bot/backup-status/status.json': JSON.stringify({ status: 'ok', operation: 'backup', restoreVerified: true, offHost: true, remoteVerified: true, recordedAt: new Date(NOW.getTime() - 60 * 60_000).toISOString(), file: 'x.snapshot.enc' }),
    '/home/o/drill.json': 'warning line\n{"status":"ok","object":"mintbot.sqlite.2026-10-23T11-00-00.000Z.snapshot.enc","bytes":1224740,"downloadSeconds":0.3,"verifySeconds":0.1,"restoreSeconds":0.479,"backupAgeSecondsAtDrill":1689}\n',
    ...overrides.files,
  };
  return {
    exec: async (command: string, args: string[]) => {
      const answer = exec[[command, ...args].join(' ')];
      if (answer === undefined) return { ok: false, stdout: '' };
      return typeof answer === 'string' ? { ok: true, stdout: `${answer}\n` } : { ok: false, stdout: answer.stdout ?? '' };
    },
    readText: async (path: string) => { if (files[path] === undefined) throw new Error('ENOENT'); return files[path]; },
    readlink: async () => `/opt/mint-bot/releases/${COMMIT}`,
    stat: async () => ({ mtimeMs: NOW.getTime() }),
    fetchHealth: async () => overrides.health ?? { status: 200, body: '{"status":"ok","service":"mint-bot-orchestrator"}' },
    now: () => NOW,
  };
}

describe('evidence rules', () => {
  const good = () => ({ version: 1, kind: 'heap_core_dump', environment: 'production', hostId: 'palmora-prod-1', release: { commit: COMMIT }, startedAt: '2026-10-23T11:00:00.000Z', completedAt: '2026-10-23T11:01:00.000Z', checks: (lib.REQUIRED_CHECKS.heap_core_dump ?? []).map((name) => ({ name, result: 'pass', observed: 'ok' })), references: [] });
  it('accepts a complete passing artifact', () => { expect(lib.validateEvidence(good(), 'heap_core_dump', NOW)).toEqual([]); });
  it('accepts each artifact at its exact documented maximum age and rejects it one millisecond later', () => {
    for (const kind of lib.KINDS) {
      const maxAge = lib.OPS_EVIDENCE_MAX_AGE_MS[kind]!;
      const completedAt = new Date(NOW.getTime() - maxAge).toISOString();
      const value = { ...good(), kind, startedAt: completedAt, completedAt, checks: (lib.REQUIRED_CHECKS[kind] ?? []).map((name) => ({ name, result: 'pass', observed: 'ok' })) };
      expect(lib.validateEvidence(value, kind, NOW), kind).not.toContain('EVIDENCE_STALE');
      expect(lib.validateEvidence(value, kind, new Date(NOW.getTime() + 1)), kind).toContain('EVIDENCE_STALE');
    }
  });
  it('names every problem: wrong kind, environment, placeholder host, bad commit, failed or missing check, secret-shaped text, future time', () => {
    const bad = { ...good(), kind: 'recovery', environment: 'test', hostId: 'REPLACE-WITH-STABLE-HOST-ID', release: { commit: 'abc' }, completedAt: '2027-01-01T00:00:00.000Z' };
    bad.checks = [{ name: 'core_limit_unit', result: 'fail', observed: 'see https://example.test/x' }, { name: 'x', result: 'pass', observed: 'a'.repeat(70).replace(/a/g, 'b') }];
    const problems = lib.validateEvidence(bad, 'heap_core_dump', NOW);
    for (const code of ['EVIDENCE_KIND_MISMATCH', 'EVIDENCE_ENVIRONMENT', 'EVIDENCE_HOST_ID', 'EVIDENCE_RELEASE_COMMIT', 'EVIDENCE_TIMES', 'EVIDENCE_CHECK_FAILED:core_limit_unit', 'EVIDENCE_CHECK_MISSING:no_coredumps', 'EVIDENCE_CHECK_UNSAFE_TEXT:core_limit_unit']) expect(problems).toContain(code);
    expect(lib.validateEvidence(null, 'heap_core_dump', NOW)).toEqual(['EVIDENCE_NOT_AN_OBJECT']);
    expect(lib.validateEvidence({ ...good(), checks: [] }, 'heap_core_dump', NOW)).toContain('EVIDENCE_CHECKS_MISSING');
  });
  it('sanitizes web addresses and long hex out of observations', () => {
    expect(lib.sanitize('see https://rpc.example/key-abc and 0x' + 'ab'.repeat(30))).toBe('see [url] and [hex]');
    expect(lib.sanitize('x'.repeat(500)).length).toBe(300);
  });
});

describe('collectors (fake host)', () => {
  it('service supervision: every check passes on a correctly set-up, exercised host', async () => {
    const { artifact, failed, problems } = await collector.collect('service_supervision', fakeIo(), {});
    expect(failed).toEqual([]);
    expect(problems).toEqual([]);
    expect(artifact).toMatchObject({ kind: 'service_supervision', environment: 'production', hostId: 'palmora-prod-1', release: { commit: COMMIT } });
  });

  it('service supervision: each missing proof is a named failure, never a skip', async () => {
    const cases: Array<[string, Parameters<typeof fakeIo>[0]]> = [
      ['unit_identity', { exec: { 'systemctl show mint-bot.service -p User --value': 'root' } }],
      ['unit_hardening', { exec: { 'systemctl show mint-bot.service -p DropInPaths --value': '/etc/systemd/system/mint-bot.service.d/x.conf' } }],
      ['restart_policy', { exec: { 'systemctl show mint-bot.service -p StartLimitIntervalUSec --value': '10s' } }],
      ['restart_limit_exercised', { exec: { 'journalctl -u mint-bot.service --no-pager -o cat --since 30 days ago': 'nothing happened' } }],
      ['rollback_recorded', { files: { '/opt/mint-bot/releases/.history': '2026-10-22T16:00:00Z none -> /r/aaa\n2026-10-22T17:00:00Z /r/aaa -> /r/bbb\n' } }],
      ['loopback_health', { health: { status: 503, body: '{}' } }],
      ['loopback_health', { exec: { 'systemctl is-active mint-bot.service': { ok: false, stdout: 'inactive\n' } } }],
      ['release_identity', { exec: { 'stat -c %U:%G %a /opt/mint-bot/releases': 'mintbot:mintbot 775' } }],
      ['logs_private', { exec: { 'stat -c %U:%G %a /var/log/mint-bot/orchestrator.log': 'mintbot:mintbot 644' } }],
    ];
    for (const [name, overrides] of cases) {
      const { failed, problems } = await collector.collect('service_supervision', fakeIo(overrides), {});
      expect(failed.map((item) => item.name), name).toContain(name);
      expect(problems.some((problem) => problem.includes(name)), name).toBe(true);
    }
  });

  it('heap and core: passes with the process limit at zero and no dumps; fails when the service is stopped or a dump exists', async () => {
    expect((await collector.collect('heap_core_dump', fakeIo(), {})).problems).toEqual([]);
    const stopped = await collector.collect('heap_core_dump', fakeIo({ exec: { 'systemctl show mint-bot.service -p MainPID --value': '0' } }), {});
    expect(stopped.failed.map((item) => item.name)).toContain('core_limit_process');
    const dumped = await collector.collect('heap_core_dump', fakeIo({ exec: { 'coredumpctl list --no-pager': 'TIME PID ... 1 coredump' } }), {});
    expect(dumped.failed.map((item) => item.name)).toContain('no_coredumps');
    const processAllows = await collector.collect('heap_core_dump', fakeIo({ files: { '/proc/4242/limits': 'Max core file size        unlimited            unlimited            bytes\n' } }), {});
    expect(processAllows.failed.map((item) => item.name)).toContain('core_limit_process');
  });

  it('backup and restore: passes with a fresh verified off-host backup, a passing isolated drill and an active schedule', async () => {
    const result = await collector.collect('backup_restore', fakeIo(), {}, { restoreDrill: '/home/o/drill.json' });
    expect(result.problems).toEqual([]);
    expect(result.artifact.references.map((reference) => reference.name)).toEqual(['backup-status', 'restore-drill-output']);
  });

  it('backup and restore: no drill output, an old backup, no off-host verification or a disabled schedule each fail by name', async () => {
    const without = await collector.collect('backup_restore', fakeIo(), {}, {});
    expect(without.failed.map((item) => item.name)).toEqual(expect.arrayContaining(['restore_drill_ok', 'restore_seconds_recorded']));
    const old = await collector.collect('backup_restore', fakeIo({ files: { '/var/lib/mint-bot/backup-status/status.json': JSON.stringify({ status: 'ok', operation: 'backup', restoreVerified: true, offHost: true, remoteVerified: true, recordedAt: new Date(NOW.getTime() - 9 * 3_600_000).toISOString() }) } }), {}, { restoreDrill: '/home/o/drill.json' });
    expect(old.failed.map((item) => item.name)).toContain('backup_status_ok');
    const local = await collector.collect('backup_restore', fakeIo({ files: { '/var/lib/mint-bot/backup-status/status.json': JSON.stringify({ status: 'ok', operation: 'backup', restoreVerified: true, offHost: false, remoteVerified: false, recordedAt: new Date(NOW.getTime() - 60_000).toISOString() }) } }), {}, { restoreDrill: '/home/o/drill.json' });
    expect(local.failed.map((item) => item.name)).toContain('offhost_remote_verified');
    const unscheduled = await collector.collect('backup_restore', fakeIo({ exec: { 'systemctl is-enabled mint-bot-backup.timer': 'disabled', 'systemctl is-active mint-bot-backup.timer': { ok: false, stdout: 'inactive\n' } } }), {}, { restoreDrill: '/home/o/drill.json' });
    expect(unscheduled.failed.map((item) => item.name)).toContain('backup_schedule_active');
  });

  it('a host id that is still the placeholder, or no release marker, makes the artifact invalid', async () => {
    const placeholder = await collector.collect('heap_core_dump', fakeIo({ files: { '/etc/mint-bot/mint-bot.env': 'MINT_BOT_HOST_ID=REPLACE-WITH-STABLE-HOST-ID\n' } }), {});
    expect(placeholder.problems).toContain('EVIDENCE_HOST_ID');
    const unmarked = await collector.collect('heap_core_dump', fakeIo({ files: { '/opt/mint-bot/current/RELEASE': 'nothing\n' } }), {});
    expect(unmarked.problems).toContain('EVIDENCE_RELEASE_COMMIT');
  });

  it('recovery: passes with a recent passing drill output and the kill switch engaged; each gap fails by name', async () => {
    const drill = (overrides: Record<string, unknown> = {}) => JSON.stringify({ status: 'ok', object: 'x.snapshot.enc', completedAt: new Date(NOW.getTime() - 3_600_000).toISOString(), checks: { restored_from_offhost: { pass: true, observed: 'restored' }, integrity_ok: { pass: true, observed: 'journal wal, integrity ok' }, schema_current: { pass: true, observed: 'schema 29 of 29' }, post_recovery_reconciliation: { pass: true, observed: 'state Ready' } }, ...overrides });
    const withDrill = (text: string, exec: Responses = {}) => fakeIo({ files: { '/home/o/recovery.json': text }, exec: { 'test -f /var/lib/mint-bot/killswitch': '', ...exec } });
    expect((await collector.collect('recovery', withDrill(drill()), {}, { recoveryDrill: '/home/o/recovery.json' })).problems).toEqual([]);
    const killReleased = await collector.collect('recovery', withDrill(drill(), { 'test -f /var/lib/mint-bot/killswitch': { ok: false } }), {}, { recoveryDrill: '/home/o/recovery.json' });
    expect(killReleased.failed.map((item) => item.name)).toEqual(['kill_switch_engaged']);
    const stale = await collector.collect('recovery', withDrill(drill({ completedAt: new Date(NOW.getTime() - 25 * 3_600_000).toISOString() })), {}, { recoveryDrill: '/home/o/recovery.json' });
    expect(stale.failed.map((item) => item.name)).toEqual(expect.arrayContaining(['restored_from_offhost', 'integrity_ok', 'schema_current', 'post_recovery_reconciliation']));
    const oldSchema = await collector.collect('recovery', withDrill(drill({ status: 'failed', checks: { restored_from_offhost: { pass: true, observed: 'r' }, integrity_ok: { pass: true, observed: 'ok' }, schema_current: { pass: false, observed: 'schema 20 of 29' }, post_recovery_reconciliation: { pass: true, observed: 'Ready' } } })), {}, { recoveryDrill: '/home/o/recovery.json' });
    expect(oldSchema.failed.map((item) => item.name)).toContain('schema_current');
    expect((await collector.collect('recovery', withDrill(''), {}, {})).failed.map((item) => item.name)).toEqual(['restored_from_offhost', 'integrity_ok', 'schema_current', 'post_recovery_reconciliation']);
  });

  it('rotation and revocation accepts only a recent, independently supplied redacted drill with every supporting digest', async () => {
    const references = ['canonical-policy-record', 'production-wallet-map', 'bounded-funding-profile', 'no-broadcast-rehearsal', 'old-reference-exclusion']
      .map((name, index) => ({ name, sha256: String(index + 1).repeat(64) }));
    const drill = (overrides: Record<string, unknown> = {}) => JSON.stringify({
      version: 1,
      type: 'mintbot-rotation-revocation-drill',
      environment: 'production',
      status: 'ok',
      completedAt: new Date(NOW.getTime() - 3_600_000).toISOString(),
      checks: {
        fresh_wallet_inventory: { pass: true, observed: 'fresh wallet inventory matches the approved policy-bound record' },
        funding_profile_bounded: { pass: true, observed: 'wallet funding stays within the approved production envelope' },
        old_references_excluded: { pass: true, observed: 'old unattended wallet and policy references are excluded' },
      },
      references,
      ...overrides,
    });
    const withDrill = (text: string) => fakeIo({ files: { '/home/o/rotation.json': text } });
    const passed = await collector.collect('rotation_revocation', withDrill(drill()), {}, { rotationDrill: '/home/o/rotation.json' });
    expect(passed.problems).toEqual([]);
    expect(passed.artifact.references.map((reference) => reference.name)).toEqual(['rotation-revocation-drill-output', ...references.map((reference) => reference.name)]);

    const absent = await collector.collect('rotation_revocation', fakeIo(), {}, {});
    expect(absent.failed.map((item) => item.name)).toEqual(['fresh_wallet_inventory', 'funding_profile_bounded', 'old_references_excluded']);
    const stale = await collector.collect('rotation_revocation', withDrill(drill({ completedAt: new Date(NOW.getTime() - 25 * 3_600_000).toISOString() })), {}, { rotationDrill: '/home/o/rotation.json' });
    expect(stale.failed).toHaveLength(3);
    const missingReference = await collector.collect('rotation_revocation', withDrill(drill({ references: references.slice(1) })), {}, { rotationDrill: '/home/o/rotation.json' });
    expect(missingReference.failed).toHaveLength(3);
    const unredactedShape = await collector.collect('rotation_revocation', withDrill(drill({ providerResponse: { unexpected: 'must not be copied into this contract' } })), {}, { rotationDrill: '/home/o/rotation.json' });
    expect(unredactedShape.failed).toHaveLength(3);
    const unsafe = await collector.collect('rotation_revocation', withDrill(drill({ checks: { fresh_wallet_inventory: { pass: true, observed: 'see https://provider.example/secret' }, funding_profile_bounded: { pass: true, observed: 'bounded' }, old_references_excluded: { pass: true, observed: 'excluded' } } })), {}, { rotationDrill: '/home/o/rotation.json' });
    expect(unsafe.failed.map((item) => item.name)).toContain('fresh_wallet_inventory');
    const oneFailed = await collector.collect('rotation_revocation', withDrill(drill({ checks: { fresh_wallet_inventory: { pass: true, observed: 'fresh inventory' }, funding_profile_bounded: { pass: false, observed: 'not bounded' }, old_references_excluded: { pass: true, observed: 'excluded' } } })), {}, { rotationDrill: '/home/o/rotation.json' });
    expect(oneFailed.failed.map((item) => item.name)).toEqual(['funding_profile_bounded']);
  });

  it('history parsing: a rollback is a move back to the release the previous move left', () => {
    expect(collector.hasRollback(collector.parseHistory('t1 none -> A\nt2 A -> B\nt3 B -> A\n'))).toBe(true);
    expect(collector.hasRollback(collector.parseHistory('t1 none -> A\nt2 A -> B\nt3 B -> C\n'))).toBe(false);
    expect(collector.hasRollback(collector.parseHistory('garbage'))).toBe(false);
  });
});

describe('runtime acceptance API', () => {
  const artifact = (kind: string) => {
    const json = { version: 1, kind, environment: 'production', hostId: 'palmora-prod-1', release: { commit: COMMIT }, startedAt: '2026-10-23T11:00:00.000Z', completedAt: '2026-10-23T11:01:00.000Z', checks: (lib.REQUIRED_CHECKS[kind] ?? []).map((name) => ({ name, result: 'pass', observed: 'ok' })), references: [] };
    return { bytes: JSON.stringify(json), json };
  };
  const artifacts = Object.fromEntries(lib.KINDS.map((kind) => [kind, artifact(kind)]));
  const acceptance = lib.buildAcceptance({
    digests: Object.fromEntries(lib.KINDS.map((kind) => [kind, lib.sha256Hex(artifacts[kind]!.bytes)])),
    designSha256: 'd'.repeat(64),
    witness: 'Product Owner, 2026-10-23',
    acceptedAt: NOW.toISOString(),
  });
  const environment = {
    MINT_BOT_RECOVERY_EVIDENCE_PATH: '/e/recovery.json',
    MINT_BOT_ROTATION_REVOCATION_EVIDENCE_PATH: '/e/rotation.json',
    MINT_BOT_HEAP_CORE_POLICY_PATH: '/e/heap.json',
    MINT_BOT_BACKUP_RESTORE_EVIDENCE_PATH: '/e/backup.json',
    MINT_BOT_SERVICE_SUPERVISION_EVIDENCE_PATH: '/e/service.json',
    MINT_BOT_OPS_EVIDENCE_ACCEPTANCE_PATH: '/e/acceptance.json',
  };
  const regular = async () => ({ isFile: () => true, isSymbolicLink: () => false, size: 10 });
  const options = {
    environment,
    now: NOW,
    statPath: regular,
    readText: async () => JSON.stringify(acceptance),
    artifactsReader: async () => artifacts,
    identityReader: async () => ({ commit: COMMIT, hostId: 'palmora-prod-1' }),
  };

  it('is reusable at an unattended boundary and accepts only the exact current host/release evidence', async () => {
    await expect(runtime.evaluateOpsEvidence(options)).resolves.toMatchObject({ humanEvidenceComplete: true, missing: [], acceptanceProblems: [] });
    await expect(runtime.assertOpsEvidenceAccepted(options)).resolves.toMatchObject({ humanEvidenceComplete: true });
    await expect(runtime.assertOpsEvidenceAccepted({ ...options, identityReader: async () => ({ commit: 'b'.repeat(40), hostId: 'palmora-prod-1' }) })).rejects.toThrow(/OPS_EVIDENCE_NOT_ACCEPTED:ARTIFACT_NOT_FOR_INSTALLED_RELEASE/);
    await expect(runtime.assertOpsEvidenceAccepted({ ...options, now: new Date(NOW.getTime() + lib.OPS_EVIDENCE_ACCEPTANCE_VALIDITY_MS) })).rejects.toThrow(/OPS_EVIDENCE_NOT_ACCEPTED:ACCEPTANCE_EXPIRED/);
  });

  it('does not let a fresh weekly acceptance bless stale source artifacts', async () => {
    const stale = structuredClone(artifacts);
    const old = new Date(NOW.getTime() - lib.OPS_EVIDENCE_MAX_AGE_MS.recovery! - 1).toISOString();
    stale.recovery!.json.startedAt = old;
    stale.recovery!.json.completedAt = old;
    stale.recovery!.bytes = JSON.stringify(stale.recovery!.json);
    const freshlyAccepted = lib.buildAcceptance({
      digests: Object.fromEntries(lib.KINDS.map((kind) => [kind, lib.sha256Hex(stale[kind]!.bytes)])),
      designSha256: 'd'.repeat(64), witness: 'Product Owner, fresh witness', acceptedAt: NOW.toISOString(),
    });
    await expect(runtime.assertOpsEvidenceAccepted({ ...options, readText: async () => JSON.stringify(freshlyAccepted), artifactsReader: async () => stale })).rejects.toThrow(/recovery:EVIDENCE_STALE/);
  });

  it('fails closed for missing paths, symlinks, malformed acceptance and unreadable state without exposing paths', async () => {
    const missing = await runtime.evaluateOpsEvidence({ ...options, environment: { ...environment, MINT_BOT_RECOVERY_EVIDENCE_PATH: '' } });
    expect(missing).toMatchObject({ humanEvidenceComplete: false, missing: ['recovery'] });
    await expect(runtime.assertOpsEvidenceAccepted({ ...options, environment: { ...environment, MINT_BOT_RECOVERY_EVIDENCE_PATH: '' } })).rejects.toThrow('ARTIFACT_MISSING:recovery');
    const symlink = await runtime.evaluateOpsEvidence({ ...options, statPath: async (path: string) => ({ isFile: () => true, isSymbolicLink: () => path.endsWith('rotation.json'), size: 10 }) });
    expect(symlink.missing).toContain('rotation_revocation');
    const malformed = await runtime.evaluateOpsEvidence({ ...options, readText: async () => '{bad json' });
    expect(malformed.acceptanceProblems).toEqual(['ACCEPTANCE_INVALID']);
    const relativeAcceptance = await runtime.evaluateOpsEvidence({ ...options, environment: { ...environment, MINT_BOT_OPS_EVIDENCE_ACCEPTANCE_PATH: 'acceptance.json' } });
    expect(relativeAcceptance.acceptanceProblems).toEqual(['ACCEPTANCE_NOT_RECORDED']);
    const message = await runtime.assertOpsEvidenceAccepted({ ...options, environment: { ...environment, MINT_BOT_RECOVERY_EVIDENCE_PATH: '/secret/location.json\nforged' } }).catch((error: Error) => error.message);
    expect(message).toContain('OPS_EVIDENCE_NOT_ACCEPTED');
    expect(message).not.toContain('/secret/');
  });
});

describe('owner acceptance', () => {
  const artifact = (kind: string, commit = COMMIT, hostId = 'palmora-prod-1') => {
    const json = { version: 1, kind, environment: 'production', hostId, release: { commit }, startedAt: '2026-10-23T11:00:00.000Z', completedAt: '2026-10-23T11:01:00.000Z', checks: (lib.REQUIRED_CHECKS[kind] ?? []).map((name) => ({ name, result: 'pass', observed: 'ok' })), references: [] };
    return { bytes: JSON.stringify(json), json };
  };
  const all = () => Object.fromEntries(lib.KINDS.map((kind) => [kind, artifact(kind)]));
  const digests = (artifacts: ReturnType<typeof all>) => Object.fromEntries(lib.KINDS.map((kind) => [kind, lib.sha256Hex(artifacts[kind]!.bytes)]));
  const DESIGN = 'd'.repeat(64);
  const accept = (artifacts: ReturnType<typeof all>) => lib.buildAcceptance({ digests: digests(artifacts), designSha256: DESIGN, witness: 'Owner, 2026-10-23 evening', acceptedAt: NOW.toISOString() });
  const identity = { currentCommit: COMMIT, hostId: 'palmora-prod-1', now: NOW };

  it('accepts exactly the five artifacts it was given, for the installed release on this host', () => {
    const artifacts = all();
    expect(lib.verifyAcceptance(accept(artifacts), artifacts, identity)).toEqual([]);
  });

  it('stops counting when an artifact changes by one byte, goes missing, is for another release or host, or starts failing', () => {
    const artifacts = all();
    const acceptance = accept(artifacts);
    const changed = { ...artifacts, backup_restore: { ...artifacts.backup_restore!, bytes: `${artifacts.backup_restore!.bytes} ` } };
    expect(lib.verifyAcceptance(acceptance, changed, identity)).toContain('ARTIFACT_CHANGED_AFTER_ACCEPTANCE:backup_restore');
    const missing = { ...artifacts } as Record<string, unknown>; delete missing.recovery;
    expect(lib.verifyAcceptance(acceptance, missing as ReturnType<typeof all>, identity)).toContain('ARTIFACT_MISSING:recovery');
    expect(lib.verifyAcceptance(acceptance, artifacts, { ...identity, currentCommit: 'b'.repeat(40) })).toContain('ARTIFACT_NOT_FOR_INSTALLED_RELEASE:recovery');
    expect(lib.verifyAcceptance(acceptance, artifacts, { ...identity, hostId: 'other-host' })).toContain('ARTIFACT_OTHER_HOST:recovery');
    const failing = all();
    failing.recovery = { bytes: 'x', json: { ...failing.recovery!.json, checks: failing.recovery!.json.checks.map((check, index) => (index === 0 ? { ...check, result: 'fail' } : check)) } };
    expect(lib.verifyAcceptance(accept(failing), failing, identity).some((problem) => problem.startsWith('recovery:EVIDENCE_CHECK_FAILED'))).toBe(true);
  });

  it('refuses a record without a witness, with a bad design digest, from the future, or of the wrong type', () => {
    const artifacts = all();
    const base = accept(artifacts);
    expect(lib.verifyAcceptance({ ...base, witness: { reference: '' } }, artifacts, identity)).toContain('ACCEPTANCE_WITNESS_MISSING');
    expect(lib.verifyAcceptance({ ...base, design: { sha256: 'nope' } }, artifacts, identity)).toContain('ACCEPTANCE_DESIGN_DIGEST');
    expect(lib.verifyAcceptance({ ...base, acceptedAt: '2030-01-01T00:00:00.000Z' }, artifacts, identity)).toContain('ACCEPTANCE_TIME');
    expect(lib.verifyAcceptance({ type: 'other' }, artifacts, identity)).toEqual(['ACCEPTANCE_INVALID']);
    expect(lib.verifyAcceptance({ ...base, version: 1 }, artifacts, identity)).toEqual(['ACCEPTANCE_INVALID']);
    expect(lib.verifyAcceptance(null, artifacts, identity)).toEqual(['ACCEPTANCE_INVALID']);
  });

  it('acceptance is valid before its fixed weekly expiry and refused exactly at and after it', () => {
    const artifacts = all();
    for (const entry of Object.values(artifacts)) {
      entry.json.startedAt = NOW.toISOString();
      entry.json.completedAt = NOW.toISOString();
      entry.bytes = JSON.stringify(entry.json);
    }
    const acceptance = accept(artifacts);
    const expires = Date.parse(String(acceptance.expiresAt));
    expect(expires).toBe(NOW.getTime() + lib.OPS_EVIDENCE_ACCEPTANCE_VALIDITY_MS);
    expect(lib.verifyAcceptance(acceptance, artifacts, { ...identity, now: new Date(expires - 1) })).toEqual([]);
    expect(lib.verifyAcceptance(acceptance, artifacts, { ...identity, now: new Date(expires) })).toContain('ACCEPTANCE_EXPIRED');
    expect(lib.verifyAcceptance(acceptance, artifacts, { ...identity, now: new Date(expires + 1) })).toContain('ACCEPTANCE_EXPIRED');
    expect(lib.verifyAcceptance({ ...acceptance, expiresAt: new Date(expires + 1).toISOString() }, artifacts, identity)).toContain('ACCEPTANCE_EXPIRY');
    const withoutExpiry = { ...acceptance }; delete withoutExpiry.expiresAt;
    expect(lib.verifyAcceptance(withoutExpiry, artifacts, identity)).toContain('ACCEPTANCE_EXPIRY');
  });

  it('the typed phrase changes when any artifact or the design document changes', () => {
    const artifacts = all();
    const phrase = lib.acceptancePhrase(digests(artifacts), DESIGN);
    expect(phrase).toMatch(/^ACCEPT-OPS-EVIDENCE [0-9a-f]{12}$/);
    expect(lib.acceptancePhrase({ ...digests(artifacts), recovery: 'e'.repeat(64) }, DESIGN)).not.toBe(phrase);
    expect(lib.acceptancePhrase(digests(artifacts), 'f'.repeat(64))).not.toBe(phrase);
  });
});
