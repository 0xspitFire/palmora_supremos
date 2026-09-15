import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const policy = fileURLToPath(new URL('./validate-policy.mjs', import.meta.url));
const policyVariables = [
  'EXECUTION_CHAIN', 'FLASHBOTS_CHAIN', 'LIVE_SPEND_CAP_WEI', 'ROBINHOOD_VERIFIED',
  'ROBINHOOD_LIVE', 'ROBINHOOD_MINT_PRICE_WEI', 'ROBINHOOD_PRIORITY_FEE_WEI',
  'ROBINHOOD_L2_EXECUTION_FEE_WEI', 'ROBINHOOD_L1_DATA_FEE_WEI', 'ROBINHOOD_MINT_TYPE',
  'ROBINHOOD_FREE_MINT_VALUE_WEI', 'ROBINHOOD_L2_GAS_RESERVE_WEI', 'ROBINHOOD_L1_DATA_GAS_RESERVE_WEI',
  'ROBINHOOD_FREE_WALLET_CAP_WEI', 'ROBINHOOD_FREE_PERIOD_CAP_WEI',
];
const runtimeVariables = [
  'SECRET_STORE_PATH', 'RPC_SECRET_NAMES', 'STORE_PATH', 'KILL_SWITCH_PATH',
  'SIGNER_HEALTH_URL', 'NOTIFICATION_HEALTH_URL', 'LAST_RECONCILIATION_AT',
  'BACKUP_DIR', 'BACKUP_ENCRYPTION_KEY', 'RESTORE_SNAPSHOT', 'MINT_BOT_SECRETS_ROOT',
  'ROBINHOOD_ARCHIVE_RPC', 'ETHEREUM_FORK_RPC', 'ETHEREUM_ARCHIVE_RPC',
  'ROBINHOOD_FORK_SOURCE', 'ETHEREUM_FORK_SOURCE', 'ARCHIVE_FORK_SOURCE',
  'MINT_BOT_ARCHIVE_REFERENCE', 'ETHEREUM_FORK_BLOCK', 'ETHEREUM_SEADROP_NFT',
  'ETHEREUM_SEADROP_FEE_RECIPIENT', 'ETHEREUM_SEADROP_MINT_VALUE_WEI',
];
const safeEnvironment = new Set(['PATH', 'HOME', 'COREPACK_HOME', 'PNPM_HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'CI', 'NODE_ENV']);
const cleanEnvironment = Object.fromEntries(Object.entries(process.env)
  .filter(([name]) => !policyVariables.includes(name) && !runtimeVariables.includes(name) && safeEnvironment.has(name)));

function run(environment) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [policy], {
      env: { ...cleanEnvironment, ...environment },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('error', (error) => resolve({ code: 1, output: error.message }));
    child.once('exit', (code) => resolve({ code: code ?? 1, output }));
  });
}

const cases = [
  ['paid Robinhood mint', { ROBINHOOD_MINT_PRICE_WEI: '1' }, false],
  ['FREE value cap', { ROBINHOOD_MINT_TYPE: 'FREE', ROBINHOOD_PRIORITY_FEE_WEI: '0', ROBINHOOD_FREE_MINT_VALUE_WEI: '1' }, false],
  ['independent L2 reserve', { ROBINHOOD_MINT_TYPE: 'FREE', ROBINHOOD_L2_EXECUTION_FEE_WEI: '2', ROBINHOOD_L2_GAS_RESERVE_WEI: '1' }, false],
  ['independent L1 reserve', { ROBINHOOD_MINT_TYPE: 'FREE', ROBINHOOD_L1_DATA_FEE_WEI: '2', ROBINHOOD_L1_DATA_GAS_RESERVE_WEI: '1' }, false],
  ['per-wallet FREE reserve cap', {
    ROBINHOOD_MINT_TYPE: 'FREE', ROBINHOOD_PRIORITY_FEE_WEI: '1', ROBINHOOD_L2_GAS_RESERVE_WEI: '200001',
    ROBINHOOD_FREE_WALLET_CAP_WEI: '200000',
  }, false],
  ['zero priority with independent reserves', {
    ROBINHOOD_MINT_TYPE: 'FREE', ROBINHOOD_PRIORITY_FEE_WEI: '0', ROBINHOOD_FREE_MINT_VALUE_WEI: '0',
    ROBINHOOD_L2_EXECUTION_FEE_WEI: '1', ROBINHOOD_L2_GAS_RESERVE_WEI: '1',
    ROBINHOOD_L1_DATA_FEE_WEI: '1', ROBINHOOD_L1_DATA_GAS_RESERVE_WEI: '1',
  }, true],
];

for (const [name, environment, shouldPass] of cases) {
  const result = await run(environment);
  const passed = (result.code === 0) === shouldPass;
  if (!passed) throw new Error(`Negative-case expectation failed: ${name}: ${result.output.trim()}`);
  console.log(`${name}: ${shouldPass ? 'pass' : 'blocked as expected'}`);
}

const health = await new Promise((resolve) => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./healthcheck.mjs', import.meta.url))], { env: cleanEnvironment, stdio: ['ignore', 'ignore', 'ignore'] });
  child.once('error', () => resolve(1));
  child.once('exit', (code) => resolve(code ?? 1));
});
if (health !== 1) throw new Error('Healthcheck must fail closed without host configuration');
console.log('healthcheck without host configuration: blocked as expected');

async function expectFailure(script, label, environment = {}) {
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL(`./${script}`, import.meta.url))], { env: { ...cleanEnvironment, ...environment }, stdio: ['ignore', 'ignore', 'ignore'] });
    child.once('error', () => resolve(1));
    child.once('exit', (exitCode) => resolve(exitCode ?? 1));
  });
  if (code === 0) throw new Error(`${label} must fail closed without configuration`);
  console.log(`${label} without configuration: blocked as expected`);
}

await expectFailure('backup.mjs', 'backup');
await expectFailure('backup.mjs', 'backup retention', { STORE_PATH: 'state.sqlite', BACKUP_DIR: 'backups', BACKUP_RETENTION_DAYS: '31' });
await expectFailure('restore-check.mjs', 'restore');
