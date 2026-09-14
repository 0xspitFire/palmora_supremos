import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SAFE_ENVIRONMENT = [
  'PATH', 'HOME', 'COREPACK_HOME', 'PNPM_HOME', 'TMPDIR', 'LANG', 'LC_ALL',
  'CI', 'NODE_ENV',
];

/**
 * Run one or more fork suites with a JSON report and reject skipped tests.
 * Only the local Anvil endpoint and explicit non-secret fixture metadata are
 * passed to Vitest; archive credentials remain in the launcher boundary.
 */
export async function runStrictVitest({ root, vitest, config, files, environment = {} }) {
  const reportDirectory = await mkdtemp(join(tmpdir(), 'mint-bot-vitest-'));
  const reportFile = join(reportDirectory, 'report.json');
  const childEnvironment = Object.fromEntries(
    SAFE_ENVIRONMENT
      .filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]]),
  );
  Object.entries(environment)
    .filter(([, value]) => value !== undefined)
    .forEach(([name, value]) => { childEnvironment[name] = value; });

  try {
    const exitCode = await runVitest({ root, vitest, config, files, reportFile, environment: childEnvironment });
    if (exitCode !== 0) return exitCode;

    let report;
    try {
      report = JSON.parse(await readFile(reportFile, 'utf8'));
    } catch {
      console.error('Strict fork replay could not read the Vitest report.');
      return 1;
    }
    const skipped = Math.max(
      countSkipped(report),
      Number(report.numPendingTests ?? 0) + Number(report.numTodoTests ?? 0),
    );
    if (skipped > 0) {
      console.error(`Strict fork replay rejected ${skipped} skipped or todo test(s).`);
      return 1;
    }
    console.log('Strict fork replay passed with no skipped tests.');
    return 0;
  } finally {
    await rm(reportDirectory, { recursive: true, force: true });
  }
}

function runVitest({ root, vitest, config, files, reportFile, environment }) {
  return new Promise((resolveCode) => {
    const child = spawn(process.execPath, [
      vitest,
      'run',
      ...files,
      '--config', config,
      '--reporter=json',
      '--outputFile', reportFile,
    ], {
      cwd: root,
      env: environment,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', () => resolveCode(1));
    child.once('exit', (code) => resolveCode(code ?? 1));
  });
}

function countSkipped(value) {
  if (Array.isArray(value)) return value.reduce((total, item) => total + countSkipped(item), 0);
  if (!value || typeof value !== 'object') return 0;
  const status = value.status;
  const own = status === 'pending' || status === 'skipped' || status === 'todo' ? 1 : 0;
  return own + Object.entries(value)
    .filter(([key]) => key !== 'status')
    .reduce((total, [, item]) => total + countSkipped(item), 0);
}
