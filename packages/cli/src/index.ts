#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseEther, parseGwei } from 'viem';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { generateAndEncryptWallets } from '@mint-bot/engine';
import { createCliRuntime } from './runtime.js';
import { resolveWalletPath, ROBINHOOD_FREE_ACTIVE_PERIOD_CAP_WEI, ROBINHOOD_FREE_PER_WALLET_CAP_WEI } from '@mint-bot/backend';
import { withHiddenPassphrase } from './secure-prompt.js';

const runtimeRoot = process.cwd();
const blocked = (error: unknown) => JSON.stringify({ state: 'Blocked', blockingReason: error instanceof Error ? error.message : String(error), retryable: false, policy: { robinhoodFreePerWalletCapWei: ROBINHOOD_FREE_PER_WALLET_CAP_WEI.toString(), robinhoodFreeActivePeriodCapWei: ROBINHOOD_FREE_ACTIVE_PERIOD_CAP_WEI.toString(), robinhoodPaidMintsEnabled: false } });

const DEFAULT_WALLET_FILE = join(runtimeRoot, 'Rets', 'wallets', 'wallets.json');
const DEFAULT_KILL_FILE = join(runtimeRoot, 'Rets', 'state', 'killswitch');

function walletFile(value: string | undefined): string {
  return resolveWalletPath(runtimeRoot, value ?? process.env.MINT_BOT_WALLET_FILE ?? './Rets/wallets/wallets.json');
}

async function ensureParent(path: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
}

async function publicWallets(path: string): Promise<string[]> {
  const content = JSON.parse(await readFile(path, 'utf8')) as { wallets?: Array<{ address?: string }> };
  if (!Array.isArray(content.wallets) || content.wallets.length === 0 || content.wallets.some((wallet) => !wallet.address)) throw new Error('Wallet file has no valid public wallet list');
  return content.wallets.map((wallet) => wallet.address!);
}

function printError(error: unknown): never {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
  throw error;
}

const cli = yargs(hideBin(process.argv))
  .scriptName('mint-bot')
  .strict()
  .demandCommand(1)
  .help()
  .command('wallet generate', 'Generate independently encrypted wallets', (args) => args
    .option('count', { type: 'number', demandOption: true })
    .option('output', { type: 'string', default: DEFAULT_WALLET_FILE }), async (args) => {
      try {
        const output = walletFile(args.output);
        await ensureParent(output);
        const wallets = await withHiddenPassphrase((passphrase) => generateAndEncryptWallets(args.count, passphrase, output));
        console.log(`Generated ${wallets.length} wallets in ${output}`);
        wallets.forEach((wallet) => console.log(`${wallet.index}\t${wallet.address}`));
      } catch (error) { printError(error); }
    })
  .command('wallet list', 'List wallet addresses without decrypting private keys', (args) => args
    .option('file', { type: 'string', default: DEFAULT_WALLET_FILE }), async (args) => {
      try {
        const content = JSON.parse(await readFile(walletFile(args.file), 'utf8')) as {
          wallets?: Array<{ index: number; address: string }>;
        };
        if (!Array.isArray(content.wallets)) throw new Error('Wallet file has no valid public wallet list');
        content.wallets.forEach((wallet) => console.log(`${wallet.index}\t${wallet.address}`));
      } catch (error) { printError(error); }
    })
  .command('health', 'Check backend and operational readiness', {}, async () => {
    try {
      const runtime = await createCliRuntime(runtimeRoot);
      const response = await runtime.application.command('health');
      process.stdout.write(`${JSON.stringify(response)}\n`);
    } catch (error) { printError(error); }
  })
  .command('kill', 'Create or remove the global kill-switch file', (args) => args
    .option('file', { type: 'string', default: DEFAULT_KILL_FILE })
    .option('clear', { type: 'boolean', default: false }), async (args) => {
      try {
        if (args.clear) {
          throw new Error('KILL_SWITCH_RESET_REQUIRES_RECOVERY_APPROVAL');
        }
        await ensureParent(args.file);
        await writeFile(args.file, `killed at ${new Date().toISOString()}\n`, { flag: 'wx' });
        const runtime = await createCliRuntime(runtimeRoot);
        await runtime.application.command('kill', { reason: 'operator CLI kill switch' });
        console.log(`Kill switch enabled: ${args.file}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') printError(new Error(`Kill switch already exists: ${args.file}`));
        printError(error);
      }
    })
  .command('mint', 'Create and execute a backend-admitted SeaDrop dry run', (args) => args
    .option('chain', { type: 'string', choices: ['ethereum', 'robinhood'] as const, default: 'ethereum' })
    .option('contract', { type: 'string', demandOption: true })
    .option('wallet-file', { type: 'string', default: DEFAULT_WALLET_FILE })
    .option('quantity', { type: 'number', default: 1 })
    .option('max-wallets', { type: 'number', default: 10 })
    .option('max-spend-eth', { type: 'number', default: 1 })
    .option('daily-cap-eth', { type: 'number', default: 2 })
    .option('max-fee-gwei', { type: 'number', default: 100 })
    .option('priority-fee-gwei', { type: 'number', default: 2 })
    .option('gas-padding', { type: 'number', default: 1.2 })
    .option('dry-run', { type: 'boolean', default: true }), async (args) => {
      try {
        const file = walletFile(args.walletFile);
        const wallets = (await publicWallets(file)).slice(0, args.maxWallets);
        if (wallets.length === 0) throw new Error('EMPTY_EXECUTION_FLEET');
        const chainId = args.chain === 'ethereum' ? 1 : 4663;
        const priorityFee = parseGwei(args.priorityFeeGwei.toString());
        const feePolicy = { kind: 'free' as const, configuredPriorityFeeWei: priorityFee, freeTotalSpendCapWei: priorityFee * 2n, l2ExecutionGasBudgetWei: 0n, l1DataGasBudgetWei: 0n, totalFeeBudgetWei: priorityFee };
        const runtime = await createCliRuntime(runtimeRoot, undefined, process.env.MINT_BOT_STATE_PATH ?? './Rets/state/backend.sqlite', { walletFile: file, maxFeePerGasGwei: args.maxFeeGwei, gasLimitPadding: args.gasPadding, killSwitchFile: DEFAULT_KILL_FILE, logFile: join(runtimeRoot, 'Rets', 'state', 'mint-bot.log') });
        const campaign = await runtime.application.createCampaign({
          chainId,
          contract: args.contract,
          strategy: 'seadrop-v1-public',
          quantity: args.quantity,
          dryRun: args.dryRun,
          maxRunWei: parseEther(args.maxSpendEth.toString()),
          dailyCapWei: parseEther(args.dailyCapEth.toString()),
          gasCeilingWei: parseEther(args.maxSpendEth.toString()),
          broadcastMode: chainId === 1 ? 'flashbots' : 'sequencer',
          chainVerification: { chainId, status: chainId === 1 ? 'verified' : 'unverified', seaDropCompatible: chainId === 1, endpointReference: chainId === 1 ? 'ETHEREUM_RPC_REFERENCE' : 'ROBINHOOD_RPC_REFERENCE' },
          mintPriceWei: 0n,
          feePolicy,
        });
        const mode = args.dryRun ? 'dry-run' : 'live';
        const armed = await runtime.application.command('arm', { validated: { campaign, wallets, evidenceAt: new Date().toISOString() }, mode });
        const result = await runtime.application.command('execute', { runId: armed.id, wallets });
        process.stdout.write(`${JSON.stringify(result, (_key, value) => typeof value === 'bigint' ? `${value}n` : value, 2)}\n`);
      } catch (error) { process.stdout.write(`${blocked(error)}\n`); }
    })
  .command('reconcile', 'Reconcile persisted in-flight runs before admission', {}, async () => {
    const runtime = await createCliRuntime(runtimeRoot);
    const response = await runtime.application.command('reconcile');
    process.stdout.write(`${JSON.stringify(response)}\n`);
  })
  .command('validate', 'Validate a campaign through the configured engine adapter', {}, async () => {
    const runtime = await createCliRuntime(runtimeRoot);
    try { await runtime.application.command('validate'); } catch (error) { process.stdout.write(`${blocked(error)}\n`); }
  })
  .command('dry-run', 'Prepare a non-broadcast dry run', {}, async () => {
    const runtime = await createCliRuntime(runtimeRoot);
    try { await runtime.application.command('dry-run'); } catch (error) { process.stdout.write(`${blocked(error)}\n`); }
  })
  .command('arm', 'Arm a campaign through Backend admission', {}, async () => {
    const runtime = await createCliRuntime(runtimeRoot);
    try { await runtime.application.command('arm'); } catch (error) { process.stdout.write(`${blocked(error)}\n`); }
  })
  .command('execute', 'Execute an admitted run through Backend admission', {}, async () => {
    const runtime = await createCliRuntime(runtimeRoot);
    try { await runtime.application.command('execute'); } catch (error) { process.stdout.write(`${blocked(error)}\n`); }
  })
  .fail((message, error) => {
    console.error(error?.message ?? message);
    process.exitCode = 1;
  });

void cli.parseAsync();
