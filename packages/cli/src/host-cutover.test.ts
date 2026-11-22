import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../../../ops/host/cutover-release.sh', import.meta.url), 'utf8');
const health = /^wait_healthy\(\) \{[\s\S]+?^\}/m.exec(source)?.[0];
if (!health) throw new Error('Missing cutover health function');

function simulateStartup(mode: 'slow-listener' | 'no-listener' | 'kill-lost') {
  // Run the actual polling function with fake service and HTTP operations.
  const program = `
    attempts=0
    marker=present
    sudo() {
      [ "$*" = "-u mintbot test -f /var/lib/mint-bot/killswitch" ] &&
      [ "$marker" = present ]
    }
    systemctl() { [ "$*" = "is-active --quiet mint-bot.service" ]; }
    curl() {
      for last in "$@"; do :; done
      [ "$last" = http://127.0.0.1:8780/healthz ] || return 2
      case "$FIXTURE_MODE" in
        slow-listener) attempts=$((attempts + 1)); [ "$attempts" -gt 40 ];;
        no-listener) return 7;;
        kill-lost) marker=missing; return 0;;
      esac
    }
    sleep() {
      if [ "$FIXTURE_MODE" = no-listener ]; then /usr/bin/sleep 0.02; fi
    }
    timeout() {
      [ "$1" = --kill-after=5s ] && [ "$2" = 180s ] || return 3
      shift 2
      /usr/bin/timeout --kill-after=1s 1s "$@"
    }
    export attempts marker
    export -f sudo systemctl curl sleep
    ${health}
    wait_healthy
  `;
  const result = spawnSync('/bin/bash', ['-c', program], {
    env: { PATH: '/usr/bin:/bin', FIXTURE_MODE: mode },
    encoding: 'utf8',
    timeout: 5000,
  });
  if (result.error) throw result.error;
  return result.status;
}

describe('release startup health window', () => {
  it('keeps probing after more immediate connection refusals than the old attempt limit', () => {
    expect(simulateStartup('slow-listener')).toBe(0);
  });

  it('ends with the elapsed deadline when the listener never appears', () => {
    expect(simulateStartup('no-listener')).toBe(124);
  });

  it('rejects a successful response if the kill marker disappeared', () => {
    expect(simulateStartup('kill-lost')).toBe(1);
  });
});
