import { describe, expect, it } from 'vitest';

const collector = await import('../../../scripts/ops-evidence-collect.mjs');

describe('heap/core evidence', () => {
  it('accepts coredumpctl reporting an empty store on stderr', async () => {
    const commit = 'a'.repeat(40);
    const responses: Record<string, { ok: boolean; stdout?: string; stderr?: string }> = {
      'systemctl show mint-bot.service -p LimitCORE --value': { ok: true, stdout: '0' },
      'systemctl show mint-bot.service -p MainPID --value': { ok: true, stdout: '4242' },
      'systemctl show mint-bot.service -p Environment --value': { ok: true, stdout: '' },
      'coredumpctl list --no-pager': { ok: false, stderr: 'No coredumps found.' },
      "/usr/bin/node -e console.log(require('v8').getHeapStatistics().heap_size_limit)": { ok: true, stdout: '1053032448' },
    };
    const io = {
      exec: async (command: string, args: string[]) => responses[[command, ...args].join(' ')] ?? { ok: false, stdout: '' },
      readText: async (path: string) => ({
        '/etc/mint-bot/mint-bot.env': 'MINT_BOT_HOST_ID=test-host\n',
        [`/opt/mint-bot/current/RELEASE`]: `commit=${commit}\n`,
        '/proc/4242/limits': 'Max core file size        0                    0                    bytes\n',
        '/proc/sys/kernel/core_pattern': '|/bin/false\n',
      }[path] ?? (() => { throw new Error('ENOENT'); })()),
      now: () => new Date('2026-10-29T20:00:00.000Z'),
    };
    const result = await collector.collect('heap_core_dump', io, {});
    expect(result.failed.map((check: { name: string }) => check.name)).not.toContain('no_coredumps');
  });
});
