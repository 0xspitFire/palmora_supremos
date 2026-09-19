#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  AlertManager,
  CanonicalStoreBridge,
  CanonicalJobStore,
  loadHostSecretStore,
  loadServiceConfig,
  MetricsRegistry,
  NotificationDispatcher,
  OrchestratorService,
  pathKillSwitchProbe,
  RedactedLogger,
  ServiceHttpServer,
  summarizeServiceConfig,
  TelegramNotifier,
} from '@mint-bot/backend';
import { createCliRuntime, configuredSecretRoot } from './runtime.js';

export interface RunningOrchestratorService {
  orchestrator: OrchestratorService;
  http: ServiceHttpServer;
  stop(): Promise<void>;
}

async function incrementRestartCounter(path: string): Promise<number> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let current = 0;
  try {
    const parsed = Number.parseInt(await readFile(path, 'utf8'), 10);
    if (Number.isSafeInteger(parsed) && parsed >= 0) current = parsed;
  } catch { /* First start or a rotated counter starts at zero. */ }
  const next = current + 1;
  await writeFile(path, `${next}\n`, { encoding: 'utf8', mode: 0o600 });
  return next;
}

/** Start the supervised local/host service without accepting control commands. */
export async function startOrchestratorService(environment: NodeJS.ProcessEnv = process.env): Promise<RunningOrchestratorService> {
  const config = loadServiceConfig(environment, process.cwd());
  const logger = new RedactedLogger({ destination: config.logPath, maxBytes: config.logMaxBytes, maxFiles: config.logMaxFiles });
  logger.info({ event: 'service_configured', config: summarizeServiceConfig(config) }, 'orchestrator service configured');
  if (config.requireStartupKillSwitch && !(await pathKillSwitchProbe(config.killSwitchPath))) throw new Error('STARTUP_KILL_SWITCH_REQUIRED');

  const runtime = await createCliRuntime(config.projectRoot, undefined, config.statePath, {
    secretRoot: configuredSecretRoot(config.projectRoot),
    killSwitchFile: config.killSwitchPath,
    logFile: config.logPath,
  });
  const metrics = new MetricsRegistry();
  metrics.set('mintbot_process_up', 0);
  const restartCount = await incrementRestartCounter(config.restartCounterPath);
  // OrchestratorService records the current start as the final increment.
  metrics.setCounter('mintbot_process_restarts_total', restartCount - 1);
  let dispatcher: NotificationDispatcher | undefined;
  let notifier: TelegramNotifier | undefined;
  if (config.telegramEnabled && config.secretStorePath) {
    const secrets = await loadHostSecretStore(config.secretStorePath);
    logger.registerSecret(secrets.get(config.telegramTokenName) ?? '');
    logger.registerSecret(secrets.get(config.telegramChatIdName) ?? '');
    notifier = new TelegramNotifier({ secretStore: secrets, tokenName: config.telegramTokenName, chatIdName: config.telegramChatIdName, apiBaseUrl: config.telegramApiBaseUrl });
    dispatcher = new NotificationDispatcher(runtime.store, notifier, { metrics, retentionDays: config.alertRetentionDays });
    const telegramHealth = await notifier.health();
    metrics.set('mintbot_notification_up', telegramHealth.status === 'ok' ? 1 : 0);
    logger.info({ event: 'telegram_health', status: telegramHealth.status, ...(telegramHealth.reason ? { reason: telegramHealth.reason } : {}) }, 'telegram notifier health checked');
  } else {
    metrics.set('mintbot_notification_up', 0);
  }
  const alerts = new AlertManager(runtime.store, dispatcher, metrics, { policy: { retentionDays: config.alertRetentionDays }, ...(config.canonicalUrlBase ? { canonicalUrlBase: config.canonicalUrlBase } : {}) });
  const jobs = new CanonicalJobStore(runtime.store);
  const orchestrator = new OrchestratorService(runtime.store, runtime.application, runtime.coordinator, {
    jobs,
    schedulerIntervalMs: config.schedulerIntervalMs,
    reconciliationIntervalMs: config.reconciliationIntervalMs,
    maxConcurrentJobs: config.maxConcurrentJobs,
    dryRunOnly: config.mode === 'dry-run',
    killSwitchProbe: () => pathKillSwitchProbe(config.killSwitchPath),
    metrics,
    logger,
    alerts,
    backupStatusPath: config.backupStatusPath,
  });
  await orchestrator.start({ skipReconciliation: true });
  const http = new ServiceHttpServer({ host: config.bindHost, port: config.port, store: runtime.store, orchestrator, metrics });
  await http.start();
  metrics.set('mintbot_process_up', 1);
  logger.info({ event: 'service_started', bindHost: config.bindHost, port: config.port, mode: config.mode }, 'orchestrator service started');

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    metrics.set('mintbot_process_up', 0);
    await orchestrator.stop();
    await http.stop();
    (runtime.store as CanonicalStoreBridge).close();
  };
  // Keep the credentials and signer entirely inside their existing runtime
  // boundaries; shutdown only stops scheduling, HTTP, and the store.
  return { orchestrator, http, stop };
}

async function main(): Promise<void> {
  let service: RunningOrchestratorService | undefined;
  try {
    service = await startOrchestratorService();
    const shutdown = () => { void service?.stop().finally(() => process.exit(0)); };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
    await new Promise<void>(() => undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'SERVICE_START_FAILED';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(join(process.cwd(), 'packages/cli/dist/orchestrator-service.js'))) void main();
