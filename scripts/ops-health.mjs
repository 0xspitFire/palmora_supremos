import { spawn } from 'node:child_process';

// The production health command is the reference-only probe. No operator
// supplied readiness booleans are accepted here.
const child = spawn(process.execPath, ['scripts/healthcheck.mjs'], {
  cwd: process.cwd(),
  stdio: 'inherit',
  windowsHide: true,
});
child.once('error', (error) => {
  console.error(error instanceof Error ? error.name : 'health_probe_error');
  process.exitCode = 1;
});
child.once('exit', (code) => { process.exitCode = code ?? 1; });
