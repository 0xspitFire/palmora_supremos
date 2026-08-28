import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const policy = fileURLToPath(new URL('./validate-policy.mjs', import.meta.url));
const policyVariables = [
  'EXECUTION_CHAIN', 'FLASHBOTS_CHAIN', 'LIVE_SPEND_CAP_WEI', 'ROBINHOOD_VERIFIED',
  'ROBINHOOD_LIVE', 'ROBINHOOD_MINT_PRICE_WEI', 'ROBINHOOD_PRIORITY_FEE_WEI',
  'ROBINHOOD_L2_EXECUTION_FEE_WEI', 'ROBINHOOD_L1_DATA_FEE_WEI', 'ROBINHOOD_MINT_TYPE',
  'ROBINHOOD_FREE_MINT_VALUE_WEI', 'ROBINHOOD_L2_GAS_RESERVE_WEI', 'ROBINHOOD_L1_DATA_GAS_RESERVE_WEI',
];
const cleanEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !policyVariables.includes(name)));

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
