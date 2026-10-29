#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { mkdir, readFile, readlink, stat, writeFile, rename, unlink } from 'node:fs/promises';
import { get } from 'node:http';
import { basename, dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { realpathSync } from 'node:fs';
import { REQUIRED_CHECKS, sanitize, sha256Hex, validateEvidence } from './ops-evidence-lib.mjs';

/**
 * Writes a production evidence artifact (infrastructure design, "Evidence contract") from checks made on THIS host, as root. It
 * reads systemd, the journal, file modes, the backup status and the output of the restore drill; it changes nothing and prints no
 * secret. An artifact is written only when every required check passes: a check that cannot be made is a failure, so no
 * placeholder or half-true file can exist. The owner's witness and approval are added later by ops-evidence-accept.mjs.
 *
 *   sudo node scripts/ops-evidence-collect.mjs service_supervision
 *   sudo node scripts/ops-evidence-collect.mjs heap_core_dump
 *   sudo node scripts/ops-evidence-collect.mjs backup_restore --restore-drill ~/restore-drill-output.json
 *   sudo node scripts/ops-evidence-collect.mjs rotation_revocation --rotation-drill ~/rotation-revocation-output.json
 */
const run = promisify(execFile);
const CURRENT = '/opt/mint-bot/current';
const RELEASES = '/opt/mint-bot/releases';
const SETTINGS = '/etc/mint-bot/mint-bot.env';
const BACKUP_STATUS = '/var/lib/mint-bot/backup-status/status.json';
const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const ROTATION_REFERENCE_NAMES = [
  'canonical-policy-record',
  'production-wallet-map',
  'bounded-funding-profile',
  'no-broadcast-rehearsal',
  'old-reference-exclusion',
];

export const ZEROIZATION_LIMITS = 'JavaScript strings and V8 heap objects cannot be reliably overwritten; transaction signing keys never enter this process (they stay in Turnkey), the process holds only the API credential, and core dumps are disabled.';

export function realIo() {
  return {
    exec: async (command, args) => {
      try {
        const { stdout, stderr } = await run(command, args, { maxBuffer: 32 * 1024 * 1024, timeout: 60_000 });
        return { ok: true, stdout: String(stdout), stderr: String(stderr ?? '') };
      }
      catch (error) { return { ok: false, stdout: String(error?.stdout ?? ''), stderr: String(error?.stderr ?? '') }; }
    },
    readText: (path) => readFile(path, 'utf8'),
    readlink: (path) => readlink(path),
    stat: async (path) => { const info = await stat(path); return { mtimeMs: info.mtimeMs }; },
    fetchHealth: (url) => new Promise((resolveHealth) => {
      const request = get(url, { timeout: 5_000 }, (response) => {
        let body = '';
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => resolveHealth({ status: response.statusCode ?? 0, body }));
      });
      request.on('error', () => resolveHealth({ status: 0, body: '' }));
      request.on('timeout', () => { request.destroy(); resolveHealth({ status: 0, body: '' }); });
    }),
    now: () => new Date(),
  };
}

const pass = (name, observed) => ({ name, result: 'pass', observed: sanitize(observed) });
const fail = (name, observed) => ({ name, result: 'fail', observed: sanitize(observed) });
const check = (name, ok, observedOk, observedFail) => (ok ? pass(name, observedOk) : fail(name, observedFail));
const hasExactKeys = (value, names) => Boolean(value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('\n') === [...names].sort().join('\n'));

async function show(io, unit, property) {
  const result = await io.exec('systemctl', ['show', unit, '-p', property, '--value']);
  return result.ok ? result.stdout.trim() : undefined;
}
async function modeOf(io, path) {
  const result = await io.exec('stat', ['-c', '%U:%G %a', path]);
  return result.ok ? result.stdout.trim() : undefined;
}

export function parseHistory(text) {
  return text.split('\n').flatMap((line) => {
    const match = /^(\S+)\s+(\S+)\s+->\s+(\S+)\s*$/.exec(line.trim());
    return match ? [{ at: match[1], from: match[2], to: match[3] }] : [];
  });
}
/** A rollback is a move back to the release the previous move left: A -> B, later B -> A. */
export function hasRollback(entries) {
  return entries.some((later, index) => later.from !== 'none' && entries.slice(0, index).some((earlier) => earlier.from === later.to && earlier.to === later.from));
}

async function context(io, env) {
  const settings = await io.readText(SETTINGS).catch(() => '');
  const hostId = /^MINT_BOT_HOST_ID=(.+)$/m.exec(settings)?.[1]?.trim() ?? env.MINT_BOT_HOST_ID ?? '';
  const releaseText = await io.readText(`${CURRENT}/RELEASE`).catch(() => '');
  const commit = /^commit=([0-9a-f]{40})$/m.exec(releaseText)?.[1] ?? '';
  return { hostId, commit };
}

async function serviceSupervision(io, commit) {
  const checks = [];
  const [user, group, supplementary, noNewPrivileges, protectSystem, limitCore, capabilities, umask, dropIns, restart, burst, interval] = await Promise.all(
    ['User', 'Group', 'SupplementaryGroups', 'NoNewPrivileges', 'ProtectSystem', 'LimitCORE', 'CapabilityBoundingSet', 'UMask', 'DropInPaths', 'Restart', 'StartLimitBurst', 'StartLimitIntervalUSec'].map((property) => show(io, 'mint-bot.service', property)));
  checks.push(check('unit_identity', user === 'mintbot' && group === 'mintbot' && (supplementary ?? '').split(/\s+/).includes('mintbot-status'), `User=${user} Group=${group} SupplementaryGroups=${supplementary}`, `unexpected identity: User=${user} Group=${group} SupplementaryGroups=${supplementary}`));
  checks.push(check('unit_hardening', noNewPrivileges === 'yes' && protectSystem === 'strict' && limitCore === '0' && (capabilities ?? '') === '' && umask === '0077' && (dropIns ?? '') === '', 'NoNewPrivileges=yes ProtectSystem=strict LimitCORE=0 CapabilityBoundingSet empty UMask=0077 no drop-in', `NoNewPrivileges=${noNewPrivileges} ProtectSystem=${protectSystem} LimitCORE=${limitCore} CapabilityBoundingSet=${capabilities} UMask=${umask} DropInPaths=${dropIns}`));
  checks.push(check('restart_policy', restart === 'on-failure' && burst === '5' && interval === '5min', 'Restart=on-failure, 5 starts in 5min', `Restart=${restart} StartLimitBurst=${burst} StartLimitIntervalUSec=${interval}`));
  const journal = await io.exec('journalctl', ['-u', 'mint-bot.service', '--no-pager', '-o', 'cat', '--since', '30 days ago']);
  const exercised = journal.ok && journal.stdout.includes('Scheduled restart job') && journal.stdout.includes('Start request repeated too quickly');
  checks.push(check('restart_limit_exercised', exercised, 'journal shows a restart after a crash and the start limit being hit', 'the journal (last 30 days) does not show both a restart and the start limit being hit; run the supervision drill'));
  const history = await io.readText(`${RELEASES}/.history`).catch(() => '');
  checks.push(check('rollback_recorded', hasRollback(parseHistory(history)), 'release history shows a rollback to an earlier release', 'release history shows no rollback; run the rollback drill'));
  const active = (await io.exec('systemctl', ['is-active', 'mint-bot.service'])).stdout.trim();
  const health = active === 'active' ? await io.fetchHealth('http://127.0.0.1:8780/healthz') : { status: 0, body: '' };
  let healthOk = false;
  try { healthOk = health.status === 200 && JSON.parse(health.body).status === 'ok'; } catch { healthOk = false; }
  checks.push(check('loopback_health', healthOk, '127.0.0.1 health answered ok', active === 'active' ? 'the loopback health answer was not ok' : 'the service is not running; collect this evidence while it runs'));
  const logDir = await modeOf(io, '/var/log/mint-bot');
  const logFile = await modeOf(io, '/var/log/mint-bot/orchestrator.log');
  checks.push(check('logs_private', logDir === 'mintbot:mintbot 700' && logFile === 'mintbot:mintbot 600', 'log folder mintbot 700, log file mintbot 600', `log folder ${logDir}, log file ${logFile}`));
  const target = await io.readlink(CURRENT).catch(() => '');
  const releasesMode = await modeOf(io, RELEASES);
  const releaseMode = await modeOf(io, `${RELEASES}/${commit}`);
  checks.push(check('release_identity', Boolean(commit) && basename(target) === commit && releasesMode === 'root:root 755' && releaseMode === 'root:root 755', `current points at release ${commit.slice(0, 7)}, root-owned and not writable by the service`, `current -> ${basename(target) || 'nothing'}; release marker ${commit.slice(0, 7) || 'missing'}; releases folder ${releasesMode}; release folder ${releaseMode}`));
  return checks;
}

async function heapCore(io) {
  const checks = [];
  checks.push(check('core_limit_unit', (await show(io, 'mint-bot.service', 'LimitCORE')) === '0', 'LimitCORE=0 in the installed unit', 'the installed unit does not set LimitCORE=0'));
  const pid = Number.parseInt(await show(io, 'mint-bot.service', 'MainPID') ?? '0', 10);
  let processLimit;
  if (pid > 0) processLimit = (await io.readText(`/proc/${pid}/limits`).catch(() => '')).split('\n').find((line) => line.startsWith('Max core file size'));
  checks.push(check('core_limit_process', Boolean(processLimit && /\s0\s+0\s+bytes/.test(processLimit)), 'running process: Max core file size 0 0', pid > 0 ? 'the running process allows core dumps' : 'the service is not running; collect this evidence while it runs'));
  const pattern = (await io.readText('/proc/sys/kernel/core_pattern').catch(() => '')).trim();
  checks.push(check('core_pattern_recorded', pattern.length > 0, `kernel core_pattern: ${pattern}`, 'the kernel core_pattern could not be read'));
  const dumps = await io.exec('coredumpctl', ['list', '--no-pager']);
  // Some systemd versions report an empty store on stderr and exit non-zero.
  // The evidence rule is about the store contents, so accept the explicit
  // "No coredumps found" result from either stream while still failing closed
  // for command-not-found or any actual listing.
  const dumpOutput = `${dumps.stdout ?? ''}\n${dumps.stderr ?? ''}`;
  checks.push(check('no_coredumps', /No coredumps found/i.test(dumpOutput), 'coredumpctl: no coredumps found', 'coredumpctl found a core dump or could not be run'));
  const heap = await io.exec('/usr/bin/node', ['-e', "console.log(require('v8').getHeapStatistics().heap_size_limit)"]);
  const heapLimit = Number.parseInt(heap.stdout.trim(), 10);
  const environment = (await show(io, 'mint-bot.service', 'Environment')) ?? '';
  const settings = await io.readText(SETTINGS).catch(() => '');
  checks.push(check('heap_limit_recorded', Number.isSafeInteger(heapLimit) && heapLimit > 0 && !/NODE_OPTIONS/.test(environment) && !/NODE_OPTIONS/.test(settings), `V8 heap limit ${heapLimit} bytes, no NODE_OPTIONS override`, 'the heap limit could not be read or NODE_OPTIONS is set'));
  checks.push(pass('zeroization_limits_documented', ZEROIZATION_LIMITS));
  return checks;
}

async function backupRestore(io, options) {
  const checks = [];
  const references = [];
  let status;
  const statusText = await io.readText(BACKUP_STATUS).catch(() => '');
  try { status = JSON.parse(statusText); } catch { status = undefined; }
  if (statusText) references.push({ name: 'backup-status', sha256: sha256Hex(statusText) });
  const age = status ? io.now().getTime() - Date.parse(status.recordedAt) : Number.NaN;
  checks.push(check('backup_status_ok', Boolean(status && status.status === 'ok' && status.operation === 'backup' && status.restoreVerified === true && age >= 0 && age <= EIGHT_HOURS_MS), `latest backup ok and restore-verified, ${Math.round(age / 60000)} minutes old`, 'the latest backup is missing, failed, unverified or older than eight hours'));
  checks.push(check('offhost_remote_verified', Boolean(status && status.offHost === true && status.remoteVerified === true), 'uploaded off-host and read back byte for byte', 'the latest backup was not uploaded and verified off-host'));
  let drill;
  let drillText = '';
  if (options.restoreDrill) drillText = await io.readText(options.restoreDrill).catch(() => '');
  try { drill = JSON.parse(drillText.trim().split('\n').filter((line) => line.startsWith('{')).at(-1) ?? ''); } catch { drill = undefined; }
  if (drillText) references.push({ name: 'restore-drill-output', sha256: sha256Hex(drillText) });
  checks.push(check('restore_drill_ok', Boolean(drill && drill.status === 'ok' && /\.snapshot\.enc$/.test(String(drill.object)) && Number(drill.backupAgeSecondsAtDrill) <= EIGHT_HOURS_MS / 1000), `isolated restore from off-host passed (backup ${drill?.backupAgeSecondsAtDrill}s old when drilled)`, 'no passing isolated restore drill output was given, or its backup was older than eight hours'));
  checks.push(check('restore_seconds_recorded', Boolean(drill && Number(drill.restoreSeconds) > 0), `measured restore time ${drill?.restoreSeconds}s for ${drill?.bytes} bytes`, 'the restore time was not measured'));
  const enabled = (await io.exec('systemctl', ['is-enabled', 'mint-bot-backup.timer'])).stdout.trim();
  const active = (await io.exec('systemctl', ['is-active', 'mint-bot-backup.timer'])).stdout.trim();
  const calendar = await show(io, 'mint-bot-backup.timer', 'TimersCalendar');
  checks.push(check('backup_schedule_active', enabled === 'enabled' && active === 'active', `backup timer enabled and active (${calendar ?? 'every six hours'})`, `backup timer is ${enabled}/${active}; backups are not scheduled`));
  return { checks, references };
}

const KILL_SWITCH = '/var/lib/mint-bot/killswitch';

/** Reads the recovery drill's output (r2-recovery-drill.mjs) and checks the live kill switch on this host. */
async function recovery(io, options) {
  const checks = [];
  const references = [];
  let drill;
  let drillText = '';
  if (options.recoveryDrill) drillText = await io.readText(options.recoveryDrill).catch(() => '');
  try { drill = JSON.parse(drillText.trim().split('\n').filter((line) => line.startsWith('{')).at(-1) ?? ''); } catch { drill = undefined; }
  if (drillText) references.push({ name: 'recovery-drill-output', sha256: sha256Hex(drillText) });
  const age = drill ? io.now().getTime() - Date.parse(drill.completedAt) : Number.NaN;
  const recent = age >= 0 && age <= TWENTY_FOUR_HOURS_MS;
  for (const name of ['restored_from_offhost', 'integrity_ok', 'schema_current', 'post_recovery_reconciliation']) {
    const result = drill?.checks?.[name];
    checks.push(check(name, Boolean(drill && drill.status === 'ok' && recent && result?.pass === true), String(result?.observed ?? ''), drill ? (recent ? `recovery drill reported: ${result?.observed ?? 'no result'}` : 'the recovery drill output is older than 24 hours; run it again') : 'no recovery drill output was given'));
  }
  const killFile = await io.exec('test', ['-f', KILL_SWITCH]);
  checks.push(check('kill_switch_engaged', killFile.ok, 'the kill switch is engaged on this host during the recovery', 'the kill switch file is missing on this host'));
  return { checks, references };
}

/**
 * Consume a redacted result produced outside this collector after the owner/provider rotation ceremony.
 * The collector does not call the custody provider or infer revocation from local configuration. Every
 * required conclusion must be stated independently and bound to the digests of its supporting records.
 */
async function rotationRevocation(io, options) {
  const checks = [];
  const references = [];
  let drill;
  let drillText = '';
  if (options.rotationDrill) drillText = await io.readText(options.rotationDrill).catch(() => '');
  try { drill = JSON.parse(drillText); } catch { drill = undefined; }
  if (drillText) references.push({ name: 'rotation-revocation-drill-output', sha256: sha256Hex(drillText) });

  const age = drill ? io.now().getTime() - Date.parse(drill.completedAt) : Number.NaN;
  const recent = age >= 0 && age <= TWENTY_FOUR_HOURS_MS;
  const contractOk = Boolean(
    drill
    && hasExactKeys(drill, ['version', 'type', 'environment', 'status', 'completedAt', 'checks', 'references'])
    && drill.version === 1
    && drill.type === 'mintbot-rotation-revocation-drill'
    && drill.environment === 'production'
    && drill.status === 'ok'
    && hasExactKeys(drill.checks, ['fresh_wallet_inventory', 'funding_profile_bounded', 'old_references_excluded'])
    && recent,
  );
  const suppliedReferences = Array.isArray(drill?.references) ? drill.references : [];
  const referenceByName = new Map(suppliedReferences.map((reference) => [reference?.name, reference]));
  const referencesOk = suppliedReferences.length === ROTATION_REFERENCE_NAMES.length
    && ROTATION_REFERENCE_NAMES.every((name) => {
      const reference = referenceByName.get(name);
      return hasExactKeys(reference, ['name', 'sha256']) && typeof reference.sha256 === 'string' && /^[0-9a-f]{64}$/.test(reference.sha256);
    });
  if (referencesOk) references.push(...ROTATION_REFERENCE_NAMES.map((name) => ({ name, sha256: referenceByName.get(name).sha256 })));

  for (const name of ['fresh_wallet_inventory', 'funding_profile_bounded', 'old_references_excluded']) {
    const result = drill?.checks?.[name];
    const observed = typeof result?.observed === 'string' ? result.observed : '';
    const safeObservation = observed.length >= 3 && observed.length <= 300 && sanitize(observed) === observed.trim();
    checks.push(check(
      name,
      Boolean(contractOk && referencesOk && hasExactKeys(result, ['pass', 'observed']) && result.pass === true && safeObservation),
      observed,
      !drill
        ? 'no redacted rotation/revocation drill result was supplied'
        : !recent
          ? 'the rotation/revocation drill result is older than 24 hours; run it again'
          : !referencesOk
            ? 'the drill is missing one or more required supporting-record digests'
            : `the independent drill did not prove ${name}`,
    ));
  }
  return { checks, references };
}

const COLLECTORS = {
  recovery: (io, options) => recovery(io, options),
  rotation_revocation: (io, options) => rotationRevocation(io, options),
  service_supervision: async (io, _options, commit) => ({ checks: await serviceSupervision(io, commit), references: [] }),
  heap_core_dump: async (io) => ({ checks: await heapCore(io), references: [] }),
  backup_restore: (io, options) => backupRestore(io, options),
};

/** Builds one artifact. Returns the artifact, the failing checks and the validation problems; the caller decides whether to write it. */
export async function collect(kind, io, env = process.env, options = {}) {
  const collector = COLLECTORS[kind];
  if (!collector) throw new Error(`COLLECTOR_NOT_AVAILABLE:${kind}`);
  const startedAt = io.now().toISOString();
  const { hostId, commit } = await context(io, env);
  const { checks, references } = await collector(io, options, commit);
  const artifact = { version: 1, kind, environment: 'production', hostId, release: { commit }, startedAt, completedAt: io.now().toISOString(), checks, references };
  return { artifact, failed: checks.filter((item) => item.result !== 'pass'), problems: validateEvidence(artifact, kind, io.now()) };
}

export const DEFAULT_PATHS = {
  service_supervision: '/var/lib/mint-bot/evidence/service-supervision.json',
  backup_restore: '/var/lib/mint-bot/evidence/backup-restore.json',
  recovery: '/var/lib/mint-bot/evidence/recovery.json',
  rotation_revocation: '/var/lib/mint-bot/evidence/rotation-revocation.json',
  heap_core_dump: '/etc/mint-bot/heap-core-policy.json',
};

async function main() {
  const [kind, ...rest] = process.argv.slice(2);
  const option = (name) => { const index = rest.indexOf(name); return index >= 0 ? rest[index + 1] : undefined; };
  if (!kind || !Object.hasOwn(REQUIRED_CHECKS, kind)) { console.error(`Usage: node ops-evidence-collect.mjs <${Object.keys(REQUIRED_CHECKS).join('|')}> [--restore-drill FILE] [--recovery-drill FILE] [--rotation-drill FILE] [--out FILE]`); process.exitCode = 2; return; }
  if (typeof process.getuid === 'function' && process.getuid() !== 0) { console.error('Run this as root: sudo node scripts/ops-evidence-collect.mjs <kind>'); process.exitCode = 2; return; }
  const { artifact, failed, problems } = await collect(kind, realIo(), process.env, { restoreDrill: option('--restore-drill'), recoveryDrill: option('--recovery-drill'), rotationDrill: option('--rotation-drill') });
  for (const item of artifact.checks) console.log(`${item.result === 'pass' ? 'PASS' : 'FAIL'}  ${item.name}: ${item.observed}`);
  if (failed.length > 0 || problems.length > 0) {
    console.log(`\nNot written: ${failed.length} check(s) failed${problems.length ? `; problems: ${problems.join(', ')}` : ''}. Fix what is listed and run it again.`);
    if (kind === 'rotation_revocation') {
      console.log('Supply --rotation-drill FILE with redacted JSON: version 1, type mintbot-rotation-revocation-drill, environment production, status ok, and completedAt within 24 hours.');
      console.log(`It must pass all three named checks and contain SHA-256 references named: ${ROTATION_REFERENCE_NAMES.join(', ')}.`);
    }
    process.exitCode = 1;
    return;
  }
  const out = resolve(option('--out') ?? DEFAULT_PATHS[kind]);
  const text = `${JSON.stringify(artifact, null, 2)}\n`;
  const temporary = `${out}.${process.pid}.tmp`;
  await mkdir(dirname(out), { recursive: true, mode: 0o755 });
  try {
    await writeFile(temporary, text, { mode: 0o644, flag: 'wx' });
    await rename(temporary, out);
  } finally { await unlink(temporary).catch(() => undefined); }
  console.log(`\nWritten: ${out}\nSHA-256: ${sha256Hex(text)}`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(new URL(import.meta.url).pathname)) {
  main().catch((error) => { console.error(`FAILED: ${sanitize(error instanceof Error ? error.message : error)}`); process.exitCode = 1; });
}
