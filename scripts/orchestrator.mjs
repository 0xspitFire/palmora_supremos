import { startOrchestratorService } from '../packages/cli/dist/orchestrator-service.js';

let service;
let stopping = false;

const shutdown = () => {
  if (stopping) return;
  stopping = true;
  void service?.stop().finally(() => process.exit(0));
};

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

try {
  service = await startOrchestratorService();
  await new Promise(() => undefined);
} catch (error) {
  // Error messages are produced from typed/redacted service boundaries.
  process.stderr.write(`${error instanceof Error ? error.message : 'SERVICE_START_FAILED'}\n`);
  process.exitCode = 1;
}
