import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '@mint-bot/database';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const installer = readFileSync(join(root, 'ops/host/install-release.sh'), 'utf8');
const checker = installer.slice(installer.indexOf('rollback_schema_compatible()'), installer.indexOf('\ncase "${1:-}"'));
const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const old = `/opt/mint-bot/releases/${'1'.repeat(40)}`;
const next = `/opt/mint-bot/releases/${'2'.repeat(40)}`;

function scratch(work: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'deployment-recovery-'));
  try { work(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

const mock = `#!${process.execPath}
const fs = require('node:fs');
const command = require('node:path').basename(process.argv[1]);
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(process.env.MOCK_STATE, 'utf8'));
const trace = action => fs.appendFileSync(process.env.MOCK_TRACE, action + '\\n');
const save = () => fs.writeFileSync(process.env.MOCK_STATE, JSON.stringify(state));
if (command === 'readlink') { console.log(state.current); process.exit(0); }
if (command === 'find') { console.log('001_initial.sql'); process.exit(0); }
if (command === 'sha256sum') {
  if (args.includes('--check')) { fs.readFileSync(0); trace('hash-check'); process.exit(0); }
  if (!args.length) fs.readFileSync(0);
  console.log((process.env.SCENARIO === 'migration-change' ? 'c' : 'b').repeat(64) + '  fixture'); process.exit(0);
}
if (command === 'seq') { console.log('1'); process.exit(0); }
if (command === 'sleep') process.exit(0);
if (command === 'curl') process.exit(state.current !== process.env.OLD && ['health-fail', 'incompatible', 'recovery-reset-fail'].includes(process.env.SCENARIO) ? 1 : 0);
if (command === 'sudo' && args[0] === '-u') {
  if (args[2] === 'touch') { trace('kill'); process.exit(0); }
  fs.readFileSync(0); trace('quiescent'); process.exit(process.env.SCENARIO === 'exposure' ? 1 : 0);
}
const call = command === 'sudo' ? args : [command, ...args];
if (call[0] === 'systemctl') {
  trace(call[1]);
  if (call[1] === 'reset-failed') { state.resets++; save(); if (process.env.SCENARIO === 'recovery-reset-fail' && state.resets === 2) process.exit(1); }
  if (call[1] === 'start') { state.starts++; save(); if (process.env.SCENARIO === 'recovery-start-fail' || process.env.SCENARIO === 'start-fail' && state.starts === 1) process.exit(1); }
  process.exit(0);
}
if (call[0] === 'bash') {
  if (call.includes('--rollback') || call.includes('--rollback-to')) {
    trace('rollback'); if (process.env.SCENARIO === 'incompatible') process.exit(1);
    state.current = call.includes('--rollback-to') ? call[call.indexOf('--rollback-to') + 1] : state.previous; save(); process.exit(0);
  }
  trace('install');
  if (process.env.SCENARIO === 'install-fail') process.exit(1);
  if (process.env.SCENARIO !== 'partial-install-fail') state.previous = state.current;
  state.current = process.env.NEXT; save(); process.exit(process.env.SCENARIO === 'partial-install-fail' ? 1 : 0);
}
throw new Error('unmocked command');
`;

function cutover(dir: string, scenario: string, allow = false) {
  const bin = join(dir, 'bin'); mkdirSync(bin);
  for (const name of ['sudo', 'systemctl', 'readlink', 'find', 'sha256sum', 'curl', 'seq', 'sleep']) writeFileSync(join(bin, name), mock, { mode: 0o700 });
  const state = join(dir, 'state.json'), trace = join(dir, 'trace');
  writeFileSync(state, JSON.stringify({ current: old, previous: `/opt/mint-bot/releases/${'3'.repeat(40)}`, starts: 0, resets: 0 })); writeFileSync(trace, '');
  const result = spawnSync('bash', [join(root, 'ops/host/cutover-release.sh'), '/tmp/synthetic-archive', 'a'.repeat(64), '/tmp/synthetic-installer', 'a'.repeat(64), 'b'.repeat(64), allow ? '1' : '0'], {
    encoding: 'utf8', env: { PATH: `${bin}:${process.env.PATH}`, MOCK_STATE: state, MOCK_TRACE: trace, SCENARIO: scenario, OLD: old, NEXT: next },
  });
  return { ...result, state: JSON.parse(readFileSync(state, 'utf8')) as { current: string; starts: number }, trace: readFileSync(trace, 'utf8').trim().split('\n') };
}

describe('schema-aware release recovery', () => {
  it('refuses old code against schema39 and preserves every canonical byte', () => scratch(dir => {
    const dbPath = join(dir, 'canonical.sqlite'); const db = openDatabase(dbPath);
    db.exec("CREATE TABLE retained_fact(id TEXT PRIMARY KEY); INSERT INTO retained_fact VALUES ('must-survive')"); db.close();
    const candidate = join(dir, 'candidate'), migrations = join(candidate, 'packages/database/migrations'); mkdirSync(migrations, { recursive: true });
    for (const name of readdirSync(join(root, 'packages/database/migrations')).filter(name => /^0(?:0|[12]|3[0-8])/.test(name))) {
      cpSync(join(root, 'packages/database/migrations', name), join(migrations, name));
    }
    const before = digest(dbPath);
    const result = spawnSync('bash', ['-c', `${checker}\nrollback_schema_compatible "$1" "$2"`, '_', candidate, dbPath], { encoding: 'utf8' });
    expect(result.status).toBe(1); expect(result.stderr).toContain('ROLLBACK_SCHEMA_INCOMPATIBLE'); expect(digest(dbPath)).toBe(before);
    cpSync(join(root, 'packages/database/migrations/039_native_funding.sql'), join(migrations, '039_native_funding.sql'));
    expect(spawnSync('bash', ['-c', `${checker}\nrollback_schema_compatible "$1" "$2"`, '_', candidate, dbPath]).status).toBe(0);
    writeFileSync(join(migrations, '039_native_funding.sql'), '-- altered migration');
    expect(spawnSync('bash', ['-c', `${checker}\nrollback_schema_compatible "$1" "$2"`, '_', candidate, dbPath]).status).toBe(1);
    expect(digest(dbPath)).toBe(before);
  }));

  it('refuses a missing canonical database without creating one', () => scratch(dir => {
    const missing = join(dir, 'missing.sqlite');
    expect(spawnSync('bash', ['-c', `${checker}\nrollback_schema_compatible "$1" "$2"`, '_', dir, missing]).status).toBe(1);
    expect(existsSync(missing)).toBe(false);
  }));

  it.each(['null-checksum', 'malformed-checksum', 'changed-name'])('refuses %s without changing canonical data', scenario => scratch(dir => {
    const dbPath = join(dir, 'canonical.sqlite'); const db = openDatabase(dbPath);
    if (scenario === 'changed-name') db.prepare('UPDATE schema_migrations SET name=? WHERE version=39').run('039_unverified.sql');
    else db.prepare('UPDATE schema_migrations SET checksum=? WHERE version=39').run(scenario === 'null-checksum' ? null : 'unknown');
    db.close();
    const candidate = join(dir, 'candidate');
    cpSync(join(root, 'packages/database/migrations'), join(candidate, 'packages/database/migrations'), { recursive: true });
    const before = digest(dbPath);
    const result = spawnSync('bash', ['-c', `${checker}\nrollback_schema_compatible "$1" "$2"`, '_', candidate, dbPath], { encoding: 'utf8' });
    expect(result.status).toBe(1); expect(result.stderr).toContain('ROLLBACK_SCHEMA_INCOMPATIBLE'); expect(digest(dbPath)).toBe(before);
  }));

  it('requires explicit migration acknowledgement before changing kill or service state', () => scratch(dir => {
    const result = cutover(dir, 'migration-change');
    expect(result.status).toBe(1); expect(result.trace).not.toContain('kill'); expect(result.trace).not.toContain('stop');
    expect(result.stderr).toContain('forward-repair plan');
  }));

  it('allows a reviewed migration acknowledgement while retaining both quiescence checks', () => scratch(dir => {
    const result = cutover(dir, 'migration-change', true);
    expect(result.status, result.stderr).toBe(0); expect(result.trace).toContain('kill');
    expect(result.trace.filter(action => action === 'quiescent')).toHaveLength(2);
  }));

  it('keeps kill engaged and refuses unresolved exposure before stopping or installing', () => scratch(dir => {
    const result = cutover(dir, 'exposure');
    expect(result.status).toBe(1); expect(result.trace).toContain('kill'); expect(result.trace).not.toContain('stop'); expect(result.trace).not.toContain('install');
  }));

  it.each(['install-fail', 'partial-install-fail', 'start-fail', 'health-fail'])('recovers %s without selecting an unrelated older release', scenario => scratch(dir => {
    const result = cutover(dir, scenario);
    expect(result.status, result.stderr).toBe(1); expect(result.state.current).toBe(old); expect(result.stdout).toContain('RECOVERED_PREVIOUS_RELEASE');
    expect(result.trace.filter(action => action === 'rollback')).toHaveLength(scenario === 'install-fail' ? 0 : 1);
    expect(result.trace.indexOf('kill')).toBeLessThan(result.trace.indexOf('install'));
  }));

  it('preserves the migrated database and stops for forward repair when rollback is incompatible', () => scratch(dir => {
    const result = cutover(dir, 'incompatible', true);
    expect(result.status).toBe(1); expect(result.state.current).toBe(next); expect(result.state.starts).toBe(1);
    expect(result.stderr).toContain('canonical database preserved'); expect(result.trace.at(-1)).toBe('rollback');
  }));

  it.each(['recovery-start-fail', 'recovery-reset-fail'])('stops instead of leaving an automatic restart loop after %s', scenario => scratch(dir => {
    const result = cutover(dir, scenario);
    expect(result.status).toBe(1); expect(result.state.current).toBe(old); expect(result.trace.at(-1)).toBe('stop');
    expect(result.stderr).toContain('FORWARD_REPAIR_REQUIRED'); expect(result.stdout).not.toContain('RECOVERED_PREVIOUS_RELEASE');
  }));

  it('starts a healthy release only after kill and both quiescence checks', () => scratch(dir => {
    const result = cutover(dir, 'success');
    expect(result.status, result.stderr).toBe(0); expect(result.state.current).toBe(next); expect(result.stdout).toContain('DEPLOYMENT_HEALTHY');
    expect(result.trace.filter(action => action === 'quiescent')).toHaveLength(2); expect(result.trace).not.toContain('rollback');
  }));
});
