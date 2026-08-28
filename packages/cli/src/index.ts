#!/usr/bin/env node
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { createCliRuntime } from './runtime.js';

const unavailableEngine = {
  execute: async () => { throw new Error('ENGINE_ADAPTER_REQUIRED'); },
  reconcile: async () => 'unknown' as const,
};

const root = process.cwd();
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
});

await cli.parseAsync();
