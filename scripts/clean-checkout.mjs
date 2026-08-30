import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const { stdout } = await run('git', ['status', '--porcelain=v1', '--untracked-files=all'], { encoding: 'utf8' });
if (stdout.trim()) {
  console.error('Checkout is not clean; refusing CI validation.');
  process.exitCode = 1;
} else {
  console.log('Clean checkout confirmed.');
}
