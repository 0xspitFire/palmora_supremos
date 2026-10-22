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
const unitDir = join(here, '..', '..', '..', 'ops', 'systemd');
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
    expect(provision).not.toMatch(/cat\s+\/etc\/mint-bot\/(Rets|secrets)/);
    // the only read of the secret store is the self-test's attempt AS the backup account, which must fail and whose output is discarded
    const reads = verify.split('\n').filter((line) => /(cat|head|tail|less|source)\s+\/etc\/mint-bot\/(Rets|secrets)/.test(line));
    expect(reads.length).toBeLessThanOrEqual(1);
    for (const line of reads) { expect(line).toContain('as mintbot-backup cat'); expect(line).toContain('>/dev/null'); }
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

  it('uses the agreed owners and modes for every folder, and verifies the same', () => {
    for (const line of [
      'ensure_dir /etc/mint-bot/secrets root:root 0700',
      'ensure_dir /etc/mint-bot/Rets root:mintbot 0750',
      'ensure_dir /var/lib/mint-bot mintbot:mintbot 0750',
      'ensure_dir /var/lib/mint-bot/db mintbot:mintbot 0750',
      'ensure_dir /var/lib/mint-bot/backups mintbot-backup:mintbot-backup 0700',
      'ensure_dir /var/lib/mint-bot/backup-status mintbot-backup:mintbot-status 0750',
      'ensure_dir /var/log/mint-bot mintbot:mintbot 0750',
    ]) expect(provision).toContain(line);
    for (const line of [
      'expect_dir /etc/mint-bot/secrets root:root 0700',
      'expect_dir /var/lib/mint-bot/db mintbot:mintbot 0750',
      'expect_dir /var/lib/mint-bot/backups mintbot-backup:mintbot-backup 0700',
      'expect_dir /var/lib/mint-bot/backup-status mintbot-backup:mintbot-status 0750',
    ]) expect(verify).toContain(line);
  });

  it('checks each secret file against its OWN owner, so a backup key owned by the application fails', () => {
    expect(verify).toContain('expect_file /etc/mint-bot/Rets/MINT_BOT_SECRETS.env mintbot:mintbot 0600');
    for (const name of ['backup-encryption-key', 'r2-access-key-id', 'r2-secret-access-key']) expect(verify).toContain(`expect_file /etc/mint-bot/secrets/${name} root:root 0600`);
  });

  it('grants the backup account only pass-through on the state folder and read on new files in the database folder, nothing wider', () => {
    expect(provision).toContain('setfacl -k /var/lib/mint-bot');
    expect(provision).toContain('setfacl -m u:mintbot-backup:--x /var/lib/mint-bot');
    expect(provision).toContain('setfacl -m u:mintbot-backup:--x /var/lib/mint-bot/db');
    expect(provision).toContain('setfacl -d -m u:mintbot-backup:r-- /var/lib/mint-bot/db');
    expect(provision).not.toMatch(/setfacl -d[^\n]*\/var\/lib\/mint-bot\s*$/m);
    expect(provision).not.toMatch(/mintbot-backup:[r-]w/); // the permission field never has the write bit
    expect(verify).toContain('has an inherited access rule');
  });

  it('refuses links where folders or database files should be, so root never follows one', () => {
    expect(provision).toContain('is a symbolic link, not a folder');
    expect(provision).toContain('is not a plain file owned by mintbot');
    expect(provision).toContain('chown -h');
  });

  it('pins the Node download checksum, unpacks it as root and checks the result', () => {
    expect(provision).toMatch(/DEFAULT_NODE_SHA256="[0-9a-f]{64}"/);
    expect(provision).toContain('b6c4cedfc81fc544b9993bc8a3628b5c0aa7a169fbaa293460abc0418d0fabb6');
    expect(provision).toContain('--no-same-owner');
    expect(provision).toContain('chown -R root:root');
    expect(provision).toContain('does not match the pinned checksum');
    expect(provision).not.toMatch(/SHASUMS256/);
    expect(provision).not.toMatch(/curl[^\n]*\|\s*(ba)?sh/);
  });

  it('sets the names the application AND the backup job read, and the database path inside its own folder', () => {
    for (const line of ['MINT_BOT_STATE_PATH=/var/lib/mint-bot/db/mintbot.sqlite', 'STORE_PATH=/var/lib/mint-bot/db/mintbot.sqlite', 'BACKUP_DIR=/var/lib/mint-bot/backups', 'BACKUP_STATUS_PATH=/var/lib/mint-bot/backup-status/status.json', 'MINT_BOT_BACKUP_STATUS_PATH=/var/lib/mint-bot/backup-status/status.json', 'KILL_SWITCH_PATH=/var/lib/mint-bot/killswitch', 'SECRET_STORE_PATH=/etc/mint-bot/Rets/MINT_BOT_SECRETS.env']) expect(provision).toContain(line);
  });

  it('the evidence report proves the separation by trying it, with a positive control for each negative, and fails the run on any FAIL', () => {
    expect(verify).toContain('--acl-selftest');
    for (const proof of ['mintbot-backup cannot write to the database', "mintbot-backup cannot read the application's secret store", 'mintbot cannot write into the backup-status folder', 'mintbot cannot read the backups folder', 'mintbot-backup cannot read other application files']) expect(verify).toContain(proof);
    for (const control of ['control: mintbot can write its own database', 'control: mintbot-backup can read its own backups folder', 'control: mintbot can read the application secret store', 'control: mintbot-backup can write the backup status folder']) expect(verify).toContain(control);
    expect(verify).toContain('write-ahead-log mode');
    expect(verify).toMatch(/\[ "\$FAIL" -eq 0 \]\s*\n\}/);
    expect(verify).toContain('sha256sum "$REPORT"');
    // root never creates or removes anything inside the application-writable folders during the self-test
    expect(verify).not.toMatch(/^\s*(rm|mkdir|install|setfacl)\b[^\n]*\/var\/lib\/mint-bot\/db/m);
  });

  it('the evidence report reads effective unit settings, rejects drop-ins and compares the installed unit with the checked-in one', () => {
    expect(verify).toContain('systemctl show');
    expect(verify).toContain('has a drop-in override');
    expect(verify).toContain('differs from the checked-in file');
    for (const setting of ['want mint-bot.service NoNewPrivileges yes', 'want mint-bot.service ProtectSystem strict', 'want mint-bot.service LimitCORE 0', 'want mint-bot.service CapabilityBoundingSet ""', 'want_has mint-bot.service ReadOnlyPaths /var/lib/mint-bot/backup-status']) expect(verify).toContain(setting);
  });

  it('the evidence report fails when it cannot list ports, and checks loopback, the kill switch and the status-folder protection under the service settings', () => {
    expect(verify).toContain('could not list listening TCP ports');
    expect(verify).toContain('127.0.0.1:8780');
    expect(verify).toContain('killswitch');
    expect(verify).toContain('-p ReadOnlyPaths=/var/lib/mint-bot/backup-status');
  });

  it('matches single-value unit settings exactly, asserts the umask the state folder privacy relies on, and checks the whole Node tree', () => {
    expect(verify).toContain('want() { # unit property expected-exact-value');
    expect(verify).toContain('want mint-bot.service UMask 0077');
    expect(verify).toContain('want mint-bot-backup.service UMask 0027');
    expect(verify).toContain('Node program tree');
    expect(provision).toContain('-perm /022');
    expect(verify).toContain('-perm /022');
  });

  it('refuses to provision while the service is running, and the move check must be refused for a read-only reason to count', () => {
    expect(provision).toContain('stop the MintBot service first');
    expect(verify).toContain("grep -qi 'read-only'");
    expect(verify).toContain('this check proves nothing');
  });

  it('asserts the backup account access rules even without the self-test, and no extended rule on the backups and status folders', () => {
    expect(verify).toContain("grep -qx 'user:mintbot-backup:--x' <<<\"$DB_ACL\"");
    expect(verify).toContain('has an extended access rule');
  });

  it('installs exactly the checked-in unit files, and the units still match the paths the scripts create', () => {
    for (const unit of ['mint-bot.service', 'mint-bot-backup.service', 'mint-bot-backup.timer']) expect(provision).toContain(unit);
    expect(provision).toContain('cmp -s');
    const app = readFileSync(join(unitDir, 'mint-bot.service'), 'utf8');
    const backup = readFileSync(join(unitDir, 'mint-bot-backup.service'), 'utf8');
    expect(app).toContain('ReadWritePaths=/var/lib/mint-bot /var/log/mint-bot');
    expect(app).toContain('ReadOnlyPaths=/var/lib/mint-bot/backup-status');
    expect(app).toContain('ExecStartPre=/usr/bin/test -f /var/lib/mint-bot/killswitch');
    expect(backup).toContain('ReadWritePaths=/var/lib/mint-bot/backups /var/lib/mint-bot/backup-status');
    for (const name of ['backup-encryption-key', 'r2-access-key-id', 'r2-secret-access-key']) expect(backup).toContain(`LoadCredential=${name}:/etc/mint-bot/secrets/${name}`);
  });
});
