#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createPublicClient, http } from 'viem';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import {
  generateAndEncryptWallets,
  MintEngine,
  getChainByName,
  getAllChains,
} from '@mint-bot/engine';
import type { MintJobConfig } from '@mint-bot/engine';

const DEFAULT_WALLET_FILE = join(homedir(), '.mint-bot', 'wallets.json');
const DEFAULT_KILL_FILE = join(homedir(), '.mint-bot', 'killswitch');

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function walletFile(value: string | undefined): string {
  return value ?? process.env.MINT_BOT_WALLET_FILE ?? DEFAULT_WALLET_FILE;
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
        const wallets = await generateAndEncryptWallets(args.count, requiredEnv('MINT_BOT_PASSPHRASE'), output);
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
  .command('health', 'Check configured RPC endpoints', (args) => args
    .option('chain', { type: 'string' }), async (args) => {
      try {
        const chains = args.chain ? [getChainByName(args.chain)] : getAllChains();
        for (const chain of chains) {
          for (const rpc of chain.rpcEndpoints) {
            try {
              const client = createPublicClient({ transport: http(rpc) });
              console.log(`${chain.name}\tOK\t${rpc}\tchainId=${await client.getChainId()}`);
            } catch (error) {
              console.log(`${chain.name}\tFAIL\t${rpc}\t${error instanceof Error ? error.message : String(error)}`);
            }
          }
        }
      } catch (error) { printError(error); }
    })
  .command('kill', 'Create or remove the global kill-switch file', (args) => args
    .option('file', { type: 'string', default: DEFAULT_KILL_FILE })
    .option('clear', { type: 'boolean', default: false }), async (args) => {
      try {
        if (args.clear) {
          if (existsSync(args.file)) await unlink(args.file);
          console.log(`Kill switch cleared: ${args.file}`);
          return;
        }
        await ensureParent(args.file);
        await writeFile(args.file, `killed at ${new Date().toISOString()}\n`, { flag: 'wx' });
        console.log(`Kill switch enabled: ${args.file}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') printError(new Error(`Kill switch already exists: ${args.file}`));
        printError(error);
      }
    })
  .command('mint', 'Run a public SeaDrop mint', (args) => args
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
        const chainName = args.chain as MintJobConfig['target']['chain'];
        const broadcastMode = args.broadcast as MintJobConfig['broadcast']['mode'];
        const endpoints = parseRpcEndpoints(args.rpc, chainName);
        const config: MintJobConfig = {
          target: { chain: chainName, contract: parseAddress(args.contract), strategy: 'seadrop-v1-public', quantity: args.quantity },
          fleet: { walletFile: walletFile(args.walletFile), maxWallets: args.maxWallets },
          timing: { mintStartUnix: 'auto' as const, armBeforeMs: 30_000 },
          fees: { maxFeePerGasGwei: args.maxFeeGwei, maxPriorityFeePerGasGwei: args.priorityFeeGwei, gasLimitPadding: args.gasPadding },
          safety: { maxSpendEth: args.maxSpendEth, dailySpendCapEth: args.dailyCapEth, maxReplacementBumps: 2, dryRun: args.dryRun, killSwitchFile: process.env.MINT_BOT_KILL_FILE ?? DEFAULT_KILL_FILE },
          broadcast: { mode: broadcastMode, rpcEndpoints: endpoints, blastParallel: broadcastMode === 'blast' },
          observability: { logLevel: 'info' as const, logFile: process.env.MINT_BOT_LOG_FILE ?? 'mint-bot.log' },
        };
        const result = await new MintEngine(config).execute(requiredEnv('MINT_BOT_PASSPHRASE'));
        console.log(JSON.stringify({ ...result, startedAt: result.startedAt.toISOString(), completedAt: result.completedAt.toISOString(), totalGasSpentWei: result.totalGasSpentWei.toString(), totalMintCostWei: result.totalMintCostWei.toString() }, null, 2));
      } catch (error) { printError(error); }
    })
  .fail((message, error) => {
    console.error(error?.message ?? message);
    process.exitCode = 1;
  });

void cli.parseAsync();
