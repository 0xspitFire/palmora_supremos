import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const { stdout } = await run('git', ['ls-files', '-z'], { encoding: 'utf8' });
const forbidden = /(?:^|\/)(?:\.env\/|Rets\/|MINT_BOT_SECRETS(?:\.env)?$|TEST_BOT(?:\.env)?$)/;
const trackedSecretFiles = stdout.split('\0').filter(Boolean).filter((file) => forbidden.test(file));

if (trackedSecretFiles.length) {
  console.error(`Secret-store files must not be tracked: ${trackedSecretFiles.join(', ')}`);
  process.exitCode = 1;
  process.exit();
}

const ignoredPaths = ['.env/MINT_BOT_SECRETS', '.env/TEST_BOT', 'Rets/MINT_BOT_SECRETS.env', 'Rets/TEST_BOT.env', 'Rets/wallets'];
for (const path of ignoredPaths) {
  try {
    await run('git', ['check-ignore', '--no-index', '--quiet', path]);
  } catch {
    console.error(`Secret boundary is not ignored by Git: ${path}`);
    process.exitCode = 1;
  }
}
if (!process.exitCode) console.log('Secret boundary passed: stores and wallet path are not tracked.');
