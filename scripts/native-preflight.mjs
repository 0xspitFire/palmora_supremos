import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const WORKSPACE_PREFIX = '/home/Junayd/W3/';
const EXPECTED = Object.freeze({
  node: '20.19.1',
  pnpm: '9.15.4',
  foundry: '1.8.1',
  anvil: '1.8.1',
});

const root = resolve(process.cwd());
const failures = [];
const checks = {};
const commandEnvironment = Object.fromEntries(
  ['PATH', 'HOME', 'COREPACK_HOME', 'PNPM_HOME', 'TMPDIR', 'LANG', 'LC_ALL']
    .filter((name) => process.env[name] !== undefined)
    .map((name) => [name, process.env[name]]),
);

const kernelRelease = readKernelFile('/proc/sys/kernel/osrelease');
const procVersion = readKernelFile('/proc/version');
const nativeWsl = process.platform === 'linux'
  && /(?:microsoft|wsl)/i.test(`${kernelRelease}\n${procVersion}`);

checks.workspace = root === '/home/Junayd/W3' || root.startsWith(WORKSPACE_PREFIX)
  ? { status: 'ok', path: root }
  : { status: 'failed', reason: 'WORKSPACE_MUST_BE_UNDER_HOME_JUNAYD_W3' };
checks.nativeWsl = nativeWsl
  ? { status: 'ok', platform: 'linux', kernel: 'WSL' }
  : { status: 'failed', reason: 'NATIVE_WSL_REQUIRED' };

recordVersion('node', process.versions.node, EXPECTED.node, process.execPath);
recordCommandVersion('pnpm', 'corepack', ['pnpm', '--version'], EXPECTED.pnpm, /^\d+\.\d+\.\d+$/m);
recordCommandVersion('foundry', 'forge', ['--version'], EXPECTED.foundry, /Version:\s*([^\s]+)/);
recordCommandVersion('anvil', 'anvil', ['--version'], EXPECTED.anvil, /Version:\s*([^\s]+)/);

const report = {
  status: failures.length === 0 ? 'ok' : 'failed',
  checks,
  checkedAt: new Date().toISOString(),
};
console.log(JSON.stringify(report));
if (failures.length > 0) process.exitCode = 1;

function recordVersion(name, actual, expected, executable) {
  const executablePath = nativeExecutable(executable);
  const passed = actual === expected && executablePath !== undefined;
  checks[name] = passed
    ? { status: 'ok', version: actual, executable: executablePath }
    : { status: 'failed', expected, observed: actual || 'unavailable' };
  if (!passed) failures.push(name);
}

function recordCommandVersion(name, command, args, expected, pattern) {
  const executable = findExecutable(command);
  const output = executable ? run(command, args) : undefined;
  const match = output?.match(pattern);
  const actual = match?.[1] ?? match?.[0];
  const passed = actual === expected && executable !== undefined;
  checks[name] = passed
    ? { status: 'ok', version: actual, executable }
    : { status: 'failed', expected, observed: actual || 'unavailable' };
  if (!passed) failures.push(name);
}

function findExecutable(command) {
  try {
    const path = execFileSync('which', [command], {
      cwd: root,
      env: commandEnvironment,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return nativeExecutable(path);
  } catch {
    return undefined;
  }
}

function nativeExecutable(path) {
  if (!path || /\.exe$/i.test(path) || /^\/mnt\/[a-z]\//i.test(path)) return undefined;
  return path;
}

function run(command, args) {
  try {
    return execFileSync(command, args, {
      cwd: root,
      env: commandEnvironment,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return undefined;
  }
}

function readKernelFile(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}
