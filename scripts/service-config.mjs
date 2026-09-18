import { loadServiceConfig, summarizeServiceConfig } from '../packages/backend/dist/index.js';

try {
  process.stdout.write(`${JSON.stringify(summarizeServiceConfig(loadServiceConfig()))}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'SERVICE_CONFIG_INVALID'}\n`);
  process.exitCode = 1;
}
