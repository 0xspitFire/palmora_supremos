#!/usr/bin/env node
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
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
import { createDashboard } from './dashboard.js';
import { EngineIntelligencePort } from './intelligence-adapter.js';
import { startIntelligence } from './intelligence-service.js';
import { runBackupJob, startBackupScheduler } from './backup-scheduler.js';
import { createMonitorPing, validMonitorUrl } from './monitor-ping.js';
import { parseFleetWatchEnv, startFleetWatcher, watcherRpcSecretName } from './fleet-watch-service.js';
import { engageKillSwitchFile } from './compensating-controls-cli.js';
import { backupFacts, codeVersion, diskFacts } from './host-facts.js';

export interface RunningOrchestratorService {
  orchestrator: OrchestratorService;
  http: ServiceHttpServer;
  stop(): Promise<void>;
}

async function incrementRestartCounter(path: string): Promise<number> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let current = 0;
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile() || (metadata.mode & 0o077) !== 0) throw new Error('RESTART_COUNTER_PERMISSIONS_INVALID');
    const parsed = Number.parseInt(await readFile(path, 'utf8'), 10);
    if (Number.isSafeInteger(parsed) && parsed >= 0) current = parsed;
  } catch (error) {
    if (error instanceof Error && error.message === 'RESTART_COUNTER_PERMISSIONS_INVALID') throw error;
    if (!(error instanceof Error) || !('code' in error) || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const next = current + 1;
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${next}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
  return next;
}

/** Start the supervised local/host service without accepting control commands. */
export async function startOrchestratorService(environment: NodeJS.ProcessEnv = process.env): Promise<RunningOrchestratorService> {
  const config = loadServiceConfig(environment, process.cwd());
  process.env.MINT_BOT_PHASE2_READ_ONLY = 'true';
  const logger = new RedactedLogger({ destination: config.logPath, maxBytes: config.logMaxBytes, maxFiles: config.logMaxFiles });
  logger.info({ event: 'service_configured', config: summarizeServiceConfig(config) }, 'orchestrator service configured');
  if (config.requireStartupKillSwitch && !(await pathKillSwitchProbe(config.killSwitchPath))) throw new Error('STARTUP_KILL_SWITCH_REQUIRED');

  const runtime = await createCliRuntime(config.projectRoot, undefined, config.statePath, {
    ...(config.mode === 'host' ? { secretRoot: configuredSecretRoot(config.projectRoot) } : {}),
    killSwitchFile: config.killSwitchPath,
    logFile: config.logPath,
  }, { allowTurnkey: config.mode === 'host', startCoordinator: config.mode === 'host' });
  if (config.mode === 'dry-run') {
    await runtime.store.transaction((state) => {
      state.runtime = { ...state.runtime, startupState: 'Blocked', blockingReasons: [...new Set([...state.runtime.blockingReasons, 'DRY_RUN_EXTERNAL_DEPENDENCIES_DISABLED'])] };
    });
  }
  const metrics = new MetricsRegistry();
  metrics.set('mintbot_process_up', 0);
  const restartCount = await incrementRestartCounter(config.restartCounterPath);
  // OrchestratorService records the current start as the final increment.
  metrics.setCounter('mintbot_process_restarts_total', restartCount - 1);
  // The one address the owner opens the dashboard at. Alerts link to it; a live deployment changes this value only.
  // MINT_BOT_DASHBOARD_PUBLIC_URL replaces the local address in alert links; the server itself still listens on loopback only.
  const dashboardUrl = config.dashboardPublicUrl ?? `http://${config.bindHost === '::1' ? '[::1]' : config.bindHost}:${config.port}/`;
  let dispatcher: NotificationDispatcher | undefined;
  let notifier: TelegramNotifier | undefined;
  if (config.telegramEnabled && config.secretStorePath) {
    const secrets = await loadHostSecretStore(config.secretStorePath);
    logger.registerSecret(secrets.get(config.telegramTokenName) ?? '');
    logger.registerSecret(secrets.get(config.telegramChatIdName) ?? '');
    notifier = new TelegramNotifier({ secretStore: secrets, tokenName: config.telegramTokenName, chatIdName: config.telegramChatIdName, apiBaseUrl: config.telegramApiBaseUrl, dashboardUrl, ...(config.telegramApprovedProxy ? { approvedProxy: config.telegramApprovedProxy } : {}) });
    dispatcher = new NotificationDispatcher(runtime.store, notifier, { metrics, retentionDays: config.alertRetentionDays });
    const telegramHealth = await notifier.health();
    metrics.set('mintbot_notification_up', telegramHealth.status === 'ok' ? 1 : 0);
    logger.info({ event: 'telegram_health', status: telegramHealth.status, ...(telegramHealth.reason ? { reason: telegramHealth.reason } : {}) }, 'telegram notifier health checked');
  } else {
    metrics.set('mintbot_notification_up', 0);
  }
  const alerts = new AlertManager(runtime.store, dispatcher, metrics, { policy: { retentionDays: config.alertRetentionDays }, ...(config.canonicalUrlBase ? { canonicalUrlBase: config.canonicalUrlBase } : {}) });
  runtime.setAlertSink(alerts);
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
    backupMaxAgeMs: environment.MINT_BOT_OFFHOST_BACKUP_REQUIRED === 'true' ? 8 * 60 * 60_000 : undefined,
    requireOffHostBackup: environment.MINT_BOT_OFFHOST_BACKUP_REQUIRED === 'true',
  });
  await orchestrator.start();
  let intelligence: { stop(): void } | undefined;
  if (config.intelligenceEnabled && config.secretStorePath) {
    const secrets = await loadHostSecretStore(config.secretStorePath);
    const rpcUrl = secrets.get(config.intelligenceRpcName);
    if (!rpcUrl) throw new Error('INTELLIGENCE_RPC_SECRET_MISSING');
    logger.registerSecret(rpcUrl);
    const monitorUrl = validMonitorUrl(secrets.get('HEALTHCHECK_PING_URL'));
    if (secrets.get('HEALTHCHECK_PING_URL') && !monitorUrl) logger.warn({ event: 'monitor_url_invalid' }, 'outside monitor address is not a valid https address; no signal will be sent');
    if (monitorUrl) logger.registerSecret(monitorUrl);
    intelligence = startIntelligence({ store: runtime.store, repo: (runtime.store as CanonicalStoreBridge).intelligenceRepository(), port: EngineIntelligencePort.fromRpcUrl(rpcUrl), alerts, wallets: config.readinessWallets, logger, discoveryIntervalMs: config.discoveryIntervalMs, discoveryMaxLagBlocks: config.discoveryMaxLagBlocks, readinessIntervalMs: config.readinessIntervalMs, digestIntervalMs: config.digestIntervalMs, startNumber: restartCount, ...(monitorUrl ? { monitorPing: createMonitorPing(monitorUrl) } : {}), heartbeatPath: join(dirname(config.statePath), 'heartbeat'), version: await codeVersion(config.projectRoot), sampleHost: async () => ({ disk: await diskFacts(dirname(config.statePath)), backup: await backupFacts(config.backupStatusPath) }) });
    logger.info({ event: 'intelligence_started', readinessWallets: config.readinessWallets.length }, 'phase 2 intelligence started (read-only)');
  }
  // D-059: the independent on-chain wallet watcher, only when the owner enables it. Fails the start on a bad setting.
  let fleetWatcher: { stop(): void } | undefined;
  const watchConfig = parseFleetWatchEnv(environment);
  if (watchConfig) {
    if (!config.secretStorePath) throw new Error('WATCHER_RPC_SECRET_MISSING');
    const watchSecrets = await loadHostSecretStore(config.secretStorePath);
    fleetWatcher = startFleetWatcher({
      store: runtime.store,
      config: watchConfig,
      alerts,
      kill: async (reason) => { await engageKillSwitchFile(config.killSwitchPath, reason); await runtime.coordinator.kill(reason); },
      rpcUrl: (chainId) => watchSecrets.get(watcherRpcSecretName(chainId)),
      logger,
    });
  }
  // Scheduled encrypted backups, only when the owner has put BACKUP_ENCRYPTION_KEY in the secret store.
  let backups: { stop(): void } | undefined;
  const backupScheduler = environment.MINT_BOT_BACKUP_SCHEDULER ?? 'internal';
  if (backupScheduler !== 'internal' && backupScheduler !== 'systemd') throw new Error('BACKUP_SCHEDULER_INVALID');
  if (environment.MINT_BOT_OFFHOST_BACKUP_REQUIRED === 'true' && backupScheduler !== 'systemd') throw new Error('OFFHOST_BACKUP_REQUIRES_SYSTEMD_SCHEDULER');
  if (config.secretStorePath && backupScheduler === 'internal') {
    const backupSecrets = await loadHostSecretStore(config.secretStorePath);
    const backupKey = backupSecrets.get('BACKUP_ENCRYPTION_KEY');
    if (backupKey) {
      logger.registerSecret(backupKey);
      const r2AccessKeyId = backupSecrets.get('R2_ACCESS_KEY_ID');
      const r2SecretAccessKey = backupSecrets.get('R2_SECRET_ACCESS_KEY');
      logger.registerSecret(r2AccessKeyId ?? '');
      logger.registerSecret(r2SecretAccessKey ?? '');
      const paths = { script: join(config.projectRoot, 'scripts', 'backup-job.mjs'), storePath: config.statePath, backupDir: config.backupDir, statusPath: config.backupStatusPath, killSwitchPath: config.killSwitchPath };
      const offhost = {
        required: environment.MINT_BOT_OFFHOST_BACKUP_REQUIRED === 'true',
        accountId: environment.R2_ACCOUNT_ID,
        bucketName: environment.R2_BUCKET_NAME,
        objectPrefix: environment.R2_OBJECT_PREFIX,
        hostId: environment.MINT_BOT_HOST_ID,
        jurisdiction: environment.R2_JURISDICTION,
        accessKeyId: r2AccessKeyId,
        secretAccessKey: r2SecretAccessKey,
      };
      backups = startBackupScheduler({ run: () => runBackupJob(paths, backupKey, offhost), statusPath: config.backupStatusPath, logger });
      logger.info({ event: 'backup_scheduler_started' }, 'scheduled backups on');
    } else logger.info({ event: 'backup_scheduler_off' }, 'scheduled backups off: no backup key in the secret store');
  } else if (backupScheduler === 'systemd') logger.info({ event: 'backup_scheduler_external' }, 'scheduled backups owned by systemd timer');
  const dashboard = createDashboard(runtime.store);
  const http = new ServiceHttpServer({ host: config.bindHost, port: config.port, store: runtime.store, orchestrator, metrics, readModel: dashboard.readModel, dashboard: (url) => dashboard.render(url) });
  await http.start();
  metrics.set('mintbot_process_up', 1);
  logger.info({ event: 'service_started', bindHost: config.bindHost, port: config.port, mode: config.mode }, 'orchestrator service started');

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    metrics.set('mintbot_process_up', 0);
    intelligence?.stop();
    fleetWatcher?.stop();
    backups?.stop();
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
