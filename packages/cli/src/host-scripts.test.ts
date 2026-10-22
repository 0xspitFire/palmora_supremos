import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * T-045: the production host scripts (ops/host). They need root and systemd, so the full behaviour is proven by running them
 * in a clean Ubuntu container and then on the real host (the evidence report). These tests pin what can be checked anywhere:
 * the scripts parse, and the safety properties that must never be edited away are still in the text.
 */
const here = dirname(fileURLToPath(import.meta.url));
const hostDir = join(here, '..', '..', '..', 'ops', 'host');
const read = (name: string): string => readFileSync(join(hostDir, name), 'utf8');
const provision = read('provision-host.sh');
const verify = read('verify-host.sh');

describe('production host scripts (T-045)', () => {
  it('both scripts are valid bash', () => {
    for (const name of ['provision-host.sh', 'verify-host.sh']) {
      const result = spawnSync('bash', ['-n', join(hostDir, name)], { encoding: 'utf8' });
      expect(result.status, `${name}: ${result.stderr}`).toBe(0);
    }
  });

  it('refuse to run unless root, and provisioning also requires Ubuntu on x86-64', () => {
    expect(provision).toContain('[ "$(id -u)" -eq 0 ]');
    expect(verify).toContain('[ "$(id -u)" -eq 0 ]');
    expect(provision).toContain('[ "${ID:-}" = ubuntu ]');
    expect(provision).toContain('x86_64');
  });

  it('provisioning has a check-only mode that changes nothing', () => {
    expect(provision).toContain('--check');
    expect(provision).toMatch(/act\(\) \{[\s\S]*"\$MODE" = check[\s\S]*would run/);
  });

  it('never starts the service, never releases the kill switch, and never reads or creates a secret', () => {
    expect(provision).not.toMatch(/systemctl\s+(start|enable|restart)/);
    expect(provision).not.toMatch(/rm\s+.*killswitch/);
    expect(verify).not.toMatch(/systemctl\s+(start|enable|restart|stop)/);
    expect(provision).toContain('kill switch ENGAGED');
    // the secret locations are only named, never read, printed or written
    expect(provision).not.toMatch(/cat\s+\/etc\/mint-bot\/(Rets|secrets)/);
    // the only read of the secret store is the self-test's attempt AS the backup account, which must fail and whose output is discarded
    const reads = verify.split('\n').filter((line) => /(cat|head|tail|less|source)\s+\/etc\/mint-bot\/(Rets|secrets)/.test(line));
    expect(reads.length).toBeLessThanOrEqual(1);
    for (const line of reads) { expect(line).toContain('runuser -u mintbot-backup --'); expect(line).toContain('>/dev/null'); }
    // the settings file written by the script contains names and paths only
    expect(provision).not.toMatch(/(TOKEN|PASSWORD|PRIVATE_KEY|API_KEY|ENCRYPTION_KEY|ACCESS_KEY)=\S/);
  });

  it('keeps the accounts separated: no login, locked password, backup account outside the application group, nobody in an admin group', () => {
    expect(provision).toContain('--shell /usr/sbin/nologin');
    expect(provision).toContain('passwd -l');
    expect(provision).toMatch(/mintbot-backup is in the mintbot group/);
    expect(provision).toMatch(/for admin_group in sudo adm google-sudoers/);
    expect(verify).toMatch(/mintbot-backup is NOT in the mintbot group/);
  });

  it('uses the agreed owners and modes for every folder', () => {
    for (const line of [
      'ensure_dir /etc/mint-bot/secrets root:root 0700',
      'ensure_dir /etc/mint-bot/Rets root:mintbot 0750',
      'ensure_dir /var/lib/mint-bot mintbot:mintbot 0750',
      'ensure_dir /var/lib/mint-bot/backups mintbot-backup:mintbot-backup 0700',
      'ensure_dir /var/lib/mint-bot/backup-status mintbot-backup:mintbot-status 0750',
      'ensure_dir /var/log/mint-bot mintbot:mintbot 0750',
    ]) expect(provision).toContain(line);
    for (const line of [
      'expect_dir /etc/mint-bot/secrets root:root 0700',
      'expect_dir /var/lib/mint-bot/backups mintbot-backup:mintbot-backup 0700',
      'expect_dir /var/lib/mint-bot/backup-status mintbot-backup:mintbot-status 0750',
    ]) expect(verify).toContain(line);
  });

  it('grants the backup account only traverse on the state folder and read on new database files', () => {
    expect(provision).toContain('setfacl -m u:mintbot-backup:--x /var/lib/mint-bot');
    expect(provision).toContain('setfacl -d -m u:mintbot-backup:r-- /var/lib/mint-bot');
    expect(provision).not.toMatch(/setfacl[^\n]*mintbot-backup:[^\n]*w/);
  });

  it('the evidence report proves the separation by trying it, and fails the run on any FAIL', () => {
    expect(verify).toContain('--acl-selftest');
    for (const proof of ['mintbot-backup cannot write to the database', "mintbot-backup cannot read the application's secret store", 'mintbot cannot write into the backup-status folder', 'mintbot cannot read the backups folder']) expect(verify).toContain(proof);
    expect(verify).toMatch(/\[ "\$FAIL" -eq 0 \]\s*$/);
    expect(verify).toContain('sha256sum');
  });

  it('the evidence report checks that only loopback listens (apart from SSH), the kill switch file and the unit hardening settings', () => {
    expect(verify).toContain('127.0.0.1:8780');
    expect(verify).toContain('killswitch');
    for (const setting of ['NoNewPrivileges=true', 'ProtectSystem=strict', 'LimitCORE=0', 'CapabilityBoundingSet=', 'ReadOnlyPaths=/var/lib/mint-bot/backup-status']) expect(verify).toContain(setting);
  });

  it('installs exactly the checked-in unit files', () => {
    for (const unit of ['mint-bot.service', 'mint-bot-backup.service', 'mint-bot-backup.timer']) expect(provision).toContain(unit);
    expect(provision).toContain('cmp -s');
  });
});
