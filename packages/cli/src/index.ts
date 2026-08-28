#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createPublicClient, http } from 'viem';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { generateAndEncryptWallets, MintEngine, getChainByName, getAllChains } from '@mint-bot/engine';
import type { MintJobConfig } from '@mint-bot/engine';
import { resolveWalletPath } from '@mint-bot/backend';
import { createCliRuntime } from './runtime.js';
import { withHiddenPassphrase } from './secure-prompt.js';

const projectRoot = process.cwd();
const walletRoot = resolveWalletPath(projectRoot);
const DEFAULT_WALLET_FILE = join(walletRoot, 'wallets.json');
const DEFAULT_KILL_FILE = join(projectRoot, 'Rets', 'state', 'killswitch');
const unavailableEngine = {
  execute: async () => { throw new Error('ENGINE_ADAPTER_REQUIRED'); },
  reconcile: async () => 'unknown' as const,
};

function walletFile(value: string | undefined): string {
  return resolveWalletPath(projectRoot, value ?? DEFAULT_WALLET_FILE);
}

function parseAddress(value: string): `0x${string}` {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`Invalid address: ${value}`);
  return value as `0x${string}`;
}

function parseRpcEndpoints(value: string | undefined, chainName: string): string[] {
  const configured = value ?? process.env.MINT_BOT_RPC_URLS;
  return configured
    ? configured.split(',').map((url) => url.trim()).filter(Boolean)
    : [...getChainByName(chainName).rpcEndpoints];
}

async function ensureParent(path: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
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
        const wallets = await withHiddenPassphrase(passphrase => generateAndEncryptWallets(args.count, passphrase, output));
        console.log(`Generated ${wallets.length} wallets in the approved keystore`);
        wallets.forEach((wallet) => console.log(`${wallet.index}\t${wallet.address}`));
      } catch (error) { printError(error); }
    })
  .command('wallet list', 'List wallet addresses without decrypting private keys', (args) => args
    .option('file', { type: 'string', default: DEFAULT_WALLET_FILE }), async (args) => {
      try {
        const content = JSON.parse(await readFile(walletFile(args.file), 'utf8')) as { wallets?: Array<{ index: number; address: string }> };
        if (!Array.isArray(content.wallets)) throw new Error('Wallet file has no valid public wallet list');
        content.wallets.forEach((wallet) => console.log(`${wallet.index}\t${wallet.address}`));
      } catch (error) { printError(error); }
    })
  .command('health', 'Check backend state and configured RPC endpoints', (args) => args
    .option('chain', { type: 'string' }), async (args) => {
      try {
        const runtime = await createCliRuntime(projectRoot, unavailableEngine);
        console.log(JSON.stringify(await runtime.application.command('health')));
        const chains = args.chain ? [getChainByName(args.chain)] : getAllChains();
        for (const chain of chains) {
          for (const [index, rpc] of chain.rpcEndpoints.entries()) {
            try {
              const client = createPublicClient({ transport: http(rpc) });
              console.log(`${chain.name}\tOK\tendpoint=${index}\tchainId=${await client.getChainId()}`);
            } catch {
              console.log(`${chain.name}\tFAIL\tendpoint=${index}`);
            }
          }
        }
      } catch (error) { printError(error); }
    })
  .command('kill <reason>', 'Stop future admissions; submitted transactions remain', (args) => args
    .positional('reason', { type: 'string', demandOption: true })
    .option('file', { type: 'string', default: DEFAULT_KILL_FILE }), async (args) => {
      try {
        const runtime = await createCliRuntime(projectRoot, unavailableEngine);
        await runtime.application.command('kill', { reason: args.reason });
        await ensureParent(args.file);
        if (!existsSync(args.file)) await writeFile(args.file, `killed at ${new Date().toISOString()}\n`, { flag: 'wx' });
        console.log('Kill switch enabled; submitted transactions still require reconciliation');
      } catch (error) { printError(error); }
    })
  .command('kill-file clear', 'Remove only the file kill signal; durable kill state remains', (args) => args
    .option('file', { type: 'string', default: DEFAULT_KILL_FILE }), async (args) => {
      try {
        if (existsSync(args.file)) await unlink(args.file);
        console.log('File kill signal cleared; durable backend kill state was not reset');
      } catch (error) { printError(error); }
    })
  .command('reconcile', 'Reconcile persisted in-flight runs before admission', {}, async () => {
    try {
      const runtime = await createCliRuntime(projectRoot, unavailableEngine);
      console.log(JSON.stringify(await runtime.application.command('reconcile')));
    } catch (error) { printError(error); }
  })
  .command('mint', 'Build a dry-run public SeaDrop mint', (args) => args
    .option('chain', { type: 'string', choices: ['ethereum', 'base', 'robinhood'] as const, default: 'ethereum' })
    .option('contract', { type: 'string', demandOption: true })
    .option('rpc', { type: 'string' })
    .option('wallet-file', { type: 'string', default: DEFAULT_WALLET_FILE })
    .option('quantity', { type: 'number', default: 1 })
    .option('max-wallets', { type: 'number', default: 10 })
    .option('max-spend-eth', { type: 'number', default: 1 })
    .option('daily-cap-eth', { type: 'number', default: 2 })
    .option('max-fee-gwei', { type: 'number', default: 100 })
    .option('priority-fee-gwei', { type: 'number', default: 2 })
    .option('gas-padding', { type: 'number', default: 1.2 })
    .option('broadcast', { type: 'string', choices: ['auto', 'public', 'blast', 'sequencer'] as const, default: 'auto' })
    .option('dry-run', { type: 'boolean', default: true }), async (args) => {
      try {
        if (!args.dryRun) throw new Error('LIVE_EXECUTION_REQUIRES_BACKEND_ADMISSION');
        const chainName = args.chain as MintJobConfig['target']['chain'];
        const broadcastMode = args.broadcast as MintJobConfig['broadcast']['mode'];
        const config: MintJobConfig = {
          target: { chain: chainName, contract: parseAddress(args.contract), strategy: 'seadrop-v1-public', quantity: args.quantity },
          fleet: { walletFile: walletFile(args.walletFile), maxWallets: args.maxWallets },
          timing: { mintStartUnix: 'auto', armBeforeMs: 30_000 },
          fees: { maxFeePerGasGwei: args.maxFeeGwei, maxPriorityFeePerGasGwei: args.priorityFeeGwei, gasLimitPadding: args.gasPadding },
          safety: { maxSpendEth: args.maxSpendEth, dailySpendCapEth: args.dailyCapEth, maxReplacementBumps: 2, dryRun: true, killSwitchFile: DEFAULT_KILL_FILE },
          broadcast: { mode: broadcastMode, rpcEndpoints: parseRpcEndpoints(args.rpc, chainName), blastParallel: broadcastMode === 'blast' },
          observability: { logLevel: 'info', logFile: join(projectRoot, 'Rets', 'state', 'mint-bot.log') },
        };
        const result = await withHiddenPassphrase(passphrase => new MintEngine(config).execute(passphrase));
        console.log(JSON.stringify({ ...result, startedAt: result.startedAt.toISOString(), completedAt: result.completedAt.toISOString(), totalGasSpentWei: result.totalGasSpentWei.toString(), totalMintCostWei: result.totalMintCostWei.toString() }, null, 2));
      } catch (error) { printError(error); }
    })
  .fail((message, error) => {
    console.error(error?.message ?? message);
    process.exitCode = 1;
  });

void cli.parseAsync();
