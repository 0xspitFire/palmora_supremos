#!/usr/bin/env node
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { createCliRuntime } from './runtime.js';
import { ROBINHOOD_FREE_ACTIVE_PERIOD_CAP_WEI, ROBINHOOD_FREE_PER_WALLET_CAP_WEI } from '@mint-bot/backend';

const unavailableEngine = {
  prepare: async () => { throw new Error('ENGINE_ADAPTER_REQUIRED'); },
  execute: async () => { throw new Error('ENGINE_ADAPTER_REQUIRED'); },
  reconcile: async () => ({ result: 'unknown' as const, attempts: [], receipts: [] }),
};

const root = process.cwd();
const blocked = (error: unknown) => JSON.stringify({ state: 'Blocked', blockingReason: error instanceof Error ? error.message : String(error), retryable: false, policy: { robinhoodFreePerWalletCapWei: ROBINHOOD_FREE_PER_WALLET_CAP_WEI.toString(), robinhoodFreeActivePeriodCapWei: ROBINHOOD_FREE_ACTIVE_PERIOD_CAP_WEI.toString(), robinhoodPaidMintsEnabled: false } });
const cli = yargs(hideBin(process.argv)).strict().demandCommand(1).command('health', 'Read backend health', {}, async () => {
  const runtime = await createCliRuntime(root, unavailableEngine);
  const response = await runtime.application.command('health');
  process.stdout.write(`${JSON.stringify(response)}\n`);
}).command('kill <reason>', 'Stop future admissions; submitted transactions remain', y => y.positional('reason', { type: 'string', demandOption: true }), async args => {
  const runtime = await createCliRuntime(root, unavailableEngine);
  const response = await runtime.application.command('kill', { reason: args.reason });
  process.stdout.write(`${JSON.stringify(response)}\n`);
}).command('reconcile', 'Reconcile persisted in-flight runs before admission', {}, async () => {
  const runtime = await createCliRuntime(root, unavailableEngine);
  const response = await runtime.application.command('reconcile');
  process.stdout.write(`${JSON.stringify(response)}\n`);
}).command('validate', 'Validate a campaign through the configured engine adapter', {}, async () => {
  const runtime = await createCliRuntime(root, unavailableEngine);
  try { await runtime.application.command('validate'); } catch (error) { process.stdout.write(`${JSON.stringify({ state: 'Blocked', blockingReason: error instanceof Error ? error.message : String(error), retryable: false })}\n`); }
}).command('dry-run', 'Prepare a non-broadcast dry run', {}, async () => {
  const runtime = await createCliRuntime(root, unavailableEngine);
  try { await runtime.application.command('dry-run'); } catch (error) { process.stdout.write(`${JSON.stringify({ state: 'Blocked', blockingReason: error instanceof Error ? error.message : String(error), retryable: false })}\n`); }
}).command('arm', 'Arm a campaign through Backend admission', {}, async () => {
  const runtime = await createCliRuntime(root, unavailableEngine);
  try { await runtime.application.command('arm'); } catch (error) { process.stdout.write(`${blocked(error)}\n`); }
}).command('execute', 'Execute an admitted run through Backend admission', {}, async () => {
  const runtime = await createCliRuntime(root, unavailableEngine);
  try { await runtime.application.command('execute'); } catch (error) { process.stdout.write(`${JSON.stringify({ state: 'Blocked', blockingReason: error instanceof Error ? error.message : String(error), retryable: false })}\n`); }
});

await cli.parseAsync();
