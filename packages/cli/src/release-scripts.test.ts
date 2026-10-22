import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * T-047: release build and install scripts (ops/host). The full behaviour is proven by building a real release and installing it
 * in a clean Ubuntu container (install, make current, roll back, and the refusals), then on the real host. These tests pin what can
 * be checked anywhere: the scripts parse and the safety properties are still in the text.
 */
const here = dirname(fileURLToPath(import.meta.url));
const hostDir = join(here, '..', '..', '..', 'ops', 'host');
const read = (name: string): string => readFileSync(join(hostDir, name), 'utf8');
const build = read('build-release.sh');
const install = read('install-release.sh');
const provision = read('provision-host.sh');

describe('release scripts (T-047)', () => {
  it('are valid bash', () => {
    for (const name of ['build-release.sh', 'install-release.sh', 'provision-host.sh']) {
      const result = spawnSync('bash', ['-n', join(hostDir, name)], { encoding: 'utf8' });
      expect(result.status, `${name}: ${result.stderr}`).toBe(0);
    }
  });

  it('the builder uses committed files only, the same Node version as the server, and refuses secret-looking files in the source and in the result', () => {
    expect(build).toContain('git -C "$REPO" archive "$COMMIT"');
    expect(build).toContain('node:20.19.1-bookworm-slim');
    expect(build).toContain('--target build');
    expect(build).toMatch(/STOP: the source has a file that looks like a secret/);
    expect(build).toMatch(/STOP: the built release has a file that looks like a secret/);
    for (const pattern of ["'*.env'", "'*.key'", "'*.pem'", "'*keystore*.json'", "'*wallet*.json'"]) expect(build).toContain(pattern);
    // it checks the result is complete before packing and records how it was built
    for (const required of ['packages/cli/dist/orchestrator-service.js', 'scripts/backup-service.mjs', 'scripts/r2-upload.mjs']) expect(build).toContain(required);
    expect(build).toContain('method=%s');
  });

  it('the installer checks the SHA-256, looks inside the archive before unpacking, and refuses paths outside release/ and parent-folder paths', () => {
    expect(install).toContain('sha256sum "$TARBALL"');
    expect(install).toContain('[[ "$EXPECTED" =~ ^[0-9a-f]{64}$ ]]');
    expect(install).toContain('the archive has files outside the release folder');
    expect(install).toContain('the archive has a parent-folder path');
    expect(install).toContain('--no-same-owner --no-same-permissions');
  });

  it('the installer makes the tree root-owned, refuses anything not root-only writable or set-id, and any link that leaves the release', () => {
    expect(install).toContain('chown -R root:root');
    expect(install).toContain('-perm /022');
    expect(install).toContain('-perm /6000');
    expect(install).toContain('realpath -m');
    expect(install).toContain('the release has a link that points outside itself');
  });

  it('the installer proves the release starts as the unprivileged account before making it current', () => {
    expect(install).toContain('smoke_test');
    expect(install).toContain('runuser -u mintbot');
    expect(install).toContain('openDatabase');
    expect(install.indexOf('smoke_test "$STAGE/release"')).toBeLessThan(install.indexOf('link_current "$TARGET"'));
  });

  it('never starts or stops the service, never touches the kill switch, never reads a secret, and never deletes an installed release', () => {
    expect(install).not.toMatch(/^\s*(sudo\s+)?systemctl\s+(start|enable|restart|stop)\b/m); // only ever mentioned inside a message to the owner
    expect(install).not.toMatch(/(rm|mv)\s+[^\n]*killswitch/);
    expect(install).toContain('the kill switch file is missing');
    expect(install).not.toMatch(/\/etc\/mint-bot\/(Rets|secrets)/);
    // the only removal is of its own temporary staging folder
    const removals = install.split('\n').filter((line) => /\brm\s+-rf?\b/.test(line));
    expect(removals).toHaveLength(1);
    expect(removals[0]).toContain('"$STAGE"');
  });

  it('refuses to install or roll back while the service is running, and to roll back to a release that does not start', () => {
    expect(install.match(/service_running && stop/g)?.length).toBeGreaterThanOrEqual(2);
    expect(install).toContain('the previous release does not start');
    expect(install).toContain('valid_release_dir');
  });

  it('makes the current release switch atomic and records history', () => {
    expect(install).toContain('mv -Tf "$CURRENT.new" "$CURRENT"');
    expect(install).toContain('.history');
    expect(install).toContain('.previous');
  });

  it('the provisioning script can use a Node download made elsewhere, which must still match the pinned checksum', () => {
    expect(provision).toContain('MINT_BOT_NODE_TARBALL');
    expect(provision).toContain('does not match the pinned checksum');
    expect(provision).toContain('--retry 5');
  });
});
