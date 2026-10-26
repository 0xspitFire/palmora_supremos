#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { access, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  AlertManager,
  BackendApplication,
  CanonicalStoreBridge,
  CanonicalJobStore,
  loadHostSecretStore,
  loadServiceConfig,
  MetricsRegistry,
  NotificationDispatcher,
  OrchestratorService,
  pathKillSwitchProbe,
  PERSONAL_LIVE_FLEET_POLICY,
  RedactedLogger,
  ServiceHttpServer,
  summarizeServiceConfig,
  TelegramNotifier,
} from '@mint-bot/backend';
import { createCliRuntime, configuredSecretRoot, configuredWalletPath, configuredWallets, turnkeyCustodyEnabled } from './runtime.js';
import type { TelegramAccessRepository } from '@mint-bot/database';
import { createTelegramBotApi, type TelegramBotApi } from './telegram-api.js';
import { TelegramCommandRouter } from './telegram-commands.js';
import { createTelegramActions } from './telegram-actions.js';
import { startTelegramCommands, withViewerFanout } from './telegram-command-service.js';
import { parseTotpSecret } from './totp.js';
import { createDashboard } from './dashboard.js';
import { EngineIntelligencePort } from './intelligence-adapter.js';
import { startIntelligence } from './intelligence-service.js';
import { runBackupJob, startBackupScheduler } from './backup-scheduler.js';
import { createMonitorPing, startLivenessPing, validMonitorUrl } from './monitor-ping.js';
import { parseFleetWatchEnv, startFleetWatcher, watcherRpcSecretName } from './fleet-watch-service.js';
import { engageKillSwitchFile } from './compensating-controls-cli.js';
import { backupFacts, codeVersion, diskFacts } from './host-facts.js';
import { createServiceAssurance, type CoordinatorAssuranceWiring } from './turnkey-readiness-service.js';
import { chainRpcSecretNames, failoverTransport, readTurnkeySecretConfig, resolveChainConfigFromSecrets } from '@mint-bot/engine';
import { startDependencyFlags } from './dependency-flags.js';
import { createPublicClient, formatGwei } from 'viem';
import { startGasAlerts } from './gas-alert-service.js';
import { startLiveRequestPoller } from './live-request.js';
import { createFireWiring, type FireWiring } from './fire-wiring.js';
import { dryRunDrop } from './robinhood-readonly.js';
import { createBlockscoutPortfolio, type PortfolioProvider } from './portfolio-provider.js';
import { CHAINLINK_ABI, CHAINLINK_ETH_USD_FEED, createEthPriceProvider } from './price-provider.js';
import { createOpenSeaFloors, type OpenSeaFloors } from './opensea-client.js';
import { startFireScheduler } from './fire.js';

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

  // Host mode runs live: refuse before anything is opened unless the watcher and the approver-key pin are configured.
  const watchConfig = parseFleetWatchEnv(environment);
  const approverKeySha256 = environment.MINT_BOT_APPROVER_KEY_SHA256 ?? '';
  if (config.mode === 'host') {
    if (!watchConfig) throw new Error('HOST_MODE_REQUIRES_WALLET_WATCHER');
    if (!/^[0-9a-fA-F]{64}$/.test(approverKeySha256)) throw new Error('HOST_MODE_REQUIRES_APPROVER_KEY_PIN');
  }
  // D-058/D-059 (T-042 requirements 1 to 4): in host mode the SERVICE decides whether a Turnkey-custodied run may arm. The wallet
  // watcher starts later, so the coordinator is given a handle that counts nothing as watched until it exists (fail closed).
  let watcherHandle: { covers(chainId: number, wallets: readonly string[]): boolean; isHealthy(at?: Date): boolean } | undefined;
  let assuranceWiring: CoordinatorAssuranceWiring | undefined;
  const runtime = await createCliRuntime(config.projectRoot, undefined, config.statePath, {
    ...(config.mode === 'host' ? { secretRoot: configuredSecretRoot(config.projectRoot) } : {}),
    killSwitchFile: config.killSwitchPath,
    logFile: config.logPath,
  }, {
    allowTurnkey: config.mode === 'host',
    startCoordinator: config.mode === 'host',
    ...(config.mode === 'host' ? {
      coordinatorAssurance: async (store) => {
        assuranceWiring = await createServiceAssurance(store, { projectRoot: config.projectRoot, secretRoot: configuredSecretRoot(config.projectRoot), killSwitchPath: config.killSwitchPath, storePath: config.statePath, approverKeySha256, watcher: () => watcherHandle });
        return assuranceWiring;
      },
    } : {}),
  });
  // The provider is checked once at start; a failure engages the kill switch before the service goes on.
  if (assuranceWiring) {
    try { await (assuranceWiring as CoordinatorAssuranceWiring).readiness.probeAtStart(); } catch (error) { (runtime.store as CanonicalStoreBridge).close(); throw error; }
  }
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
  // T-061 (D-063): owner commands over Telegram, only when the owner turns them on. Without every secret they need the start fails,
  // so the commands never run without the owner check or the authenticator.
  const commandsFlag = environment.MINT_BOT_TELEGRAM_COMMANDS ?? '';
  if (commandsFlag !== '' && commandsFlag !== 'true' && commandsFlag !== 'false') throw new Error('TELEGRAM_COMMANDS_FLAG_INVALID');
  let telegramCommandSetup: { api: TelegramBotApi; access: TelegramAccessRepository; ownerUserId: string; totpKey: Buffer } | undefined;
  let intelligenceAlerts: AlertManager = alerts;
  if (commandsFlag === 'true') {
    if (!config.telegramEnabled || !config.secretStorePath) throw new Error('TELEGRAM_COMMANDS_NEED_TELEGRAM');
    const secrets = await loadHostSecretStore(config.secretStorePath);
    const token = secrets.get(config.telegramTokenName);
    if (!token) throw new Error('TELEGRAM_TOKEN_MISSING');
    const ownerUserId = secrets.get('TG_OWNER_USER_ID') ?? '';
    if (!/^\d{1,20}$/.test(ownerUserId)) throw new Error('TG_OWNER_USER_ID_MISSING');
    logger.registerSecret(secrets.get('TELEGRAM_TOTP_SECRET') ?? '');
    const totpKey = parseTotpSecret(secrets.get('TELEGRAM_TOTP_SECRET'));
    const api = createTelegramBotApi({ token, apiBaseUrl: config.telegramApiBaseUrl, ...(config.telegramApprovedProxy ? { approvedProxy: config.telegramApprovedProxy } : {}) });
    const access = (runtime.store as CanonicalStoreBridge).telegramAccessRepository();
    telegramCommandSetup = { api, access, ownerUserId, totpKey };
    // D-063 item 8: viewers receive opportunity and opening-soon alerts as well.
    intelligenceAlerts = withViewerFanout(alerts, async (text) => { for (const user of access.activeUsers()) await api.sendMessage(user.userId, text).catch(() => undefined); });
  }
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
    // The configured provider first, then Ethereum's other configured providers, so a timeout or failure moves the scan on.
    const rpcUrls = [...new Set([rpcUrl, ...chainRpcSecretNames(1).map((name) => secrets.get(name)).filter((url): url is string => Boolean(url))])];
    for (const url of rpcUrls) logger.registerSecret(url);
    const monitorUrl = validMonitorUrl(secrets.get('HEALTHCHECK_PING_URL'));
    if (secrets.get('HEALTHCHECK_PING_URL') && !monitorUrl) logger.warn({ event: 'monitor_url_invalid' }, 'outside monitor address is not a valid https address; no signal will be sent');
    if (monitorUrl) logger.registerSecret(monitorUrl);
    intelligence = startIntelligence({ store: runtime.store, repo: (runtime.store as CanonicalStoreBridge).intelligenceRepository(), port: EngineIntelligencePort.fromRpcUrls(rpcUrls), alerts: intelligenceAlerts, wallets: config.readinessWallets, logger, discoveryIntervalMs: config.discoveryIntervalMs, discoveryMaxLagBlocks: config.discoveryMaxLagBlocks, readinessIntervalMs: config.readinessIntervalMs, digestIntervalMs: config.digestIntervalMs, startNumber: restartCount, ...(monitorUrl ? { monitorPing: createMonitorPing(monitorUrl) } : {}), heartbeatPath: join(dirname(config.statePath), 'heartbeat'), version: await codeVersion(config.projectRoot), sampleHost: async () => ({ disk: await diskFacts(dirname(config.statePath)), backup: await backupFacts(config.backupStatusPath) }) });
    logger.info({ event: 'intelligence_started', readinessWallets: config.readinessWallets.length }, 'phase 2 intelligence started (read-only)');
  }
  // D-059: the independent on-chain wallet watcher, only when the owner enables it. Fails the start on a bad setting.
  let fleetWatcher: { stop(): void } | undefined;
  if (watchConfig) {
    if (!config.secretStorePath) throw new Error('WATCHER_RPC_SECRET_MISSING');
    const watchSecrets = await loadHostSecretStore(config.secretStorePath);
    const started = startFleetWatcher({
      store: runtime.store,
      config: watchConfig,
      alerts,
      // Both are attempted on their own: the kill file and the coordinator. Only if neither could be engaged is the failure reported.
      kill: async (reason) => {
        const outcomes = await Promise.allSettled([engageKillSwitchFile(config.killSwitchPath, reason), runtime.coordinator.kill(reason)]);
        if (outcomes.every((outcome) => outcome.status === 'rejected')) throw new Error('KILL_SWITCH_NOT_ENGAGED');
      },
      // The watcher's own provider first; the engine's providers for that chain keep it watching if that one fails.
      rpcUrls: (chainId) => [watcherRpcSecretName(chainId), ...chainRpcSecretNames(chainId as 1 | 8453 | 4663)].map((name) => watchSecrets.get(name)).filter((url): url is string => Boolean(url)),
      logger,
    });
    fleetWatcher = started;
    watcherHandle = started.watcher;
  }
  // T-058: in host mode the service runs the owner's live requests. It uses its own application, not the read-only one above, so
  // `arm` and `run` go through every gate exactly as a guided live run does (approval, simulation, caps, custody, watcher, kill switch).
  let liveRequests: { stop(): void; tick(): Promise<void> } | undefined;
  let dependencyFlags: { stop(): void } | undefined;
  if (config.mode === 'host') {
    // T-070 (D-068): the service sets engine, chain and notifications readiness from real checks (backup follows its status check in the tick).
    const flagSecretRoot = configuredSecretRoot(config.projectRoot);
    const flagClients = new Map<number, ReturnType<typeof createPublicClient>>();
    dependencyFlags = startDependencyFlags({
      store: runtime.store,
      engineReady: async () => { await readTurnkeySecretConfig(flagSecretRoot); return true; },
      notificationsReady: async () => (await notifier?.health())?.status === 'ok',
      chainsToProbe: () => [...new Set(runtime.store.snapshot().chainEvidence.filter((evidence) => evidence.status === 'accepted' && evidence.executionEnabled && Date.parse(evidence.expiresAt) > Date.now()).map((evidence) => evidence.chainId as number))],
      latestBlockTime: async (chainId) => {
        let reader = flagClients.get(chainId);
        if (!reader) {
          const endpoints = [...(await resolveChainConfigFromSecrets(chainId as 1 | 8453 | 4663, 'mainnet', flagSecretRoot)).rpcEndpoints];
          if (endpoints.length === 0) throw new Error('CHAIN_ENDPOINT_UNAVAILABLE');
          const candidate = createPublicClient({ transport: failoverTransport(endpoints) });
          // The endpoint must really be this chain (a wrong or swapped provider must not make the chain look ready).
          if (await candidate.getChainId() !== chainId) throw new Error('CHAIN_ID_MISMATCH');
          reader = candidate;
          flagClients.set(chainId, reader);
        }
        return new Date(Number((await reader.getBlock({ blockTag: 'latest' })).timestamp) * 1000);
      },
      // Any answer but "no such file" counts as present: an unreadable kill file is treated as killed.
      killSwitchOn: async () => runtime.store.snapshot().killed || await access(config.killSwitchPath).then(() => true, (error: NodeJS.ErrnoException) => error.code !== 'ENOENT'),
      now: () => new Date(),
      log: (event, fields) => logger.info({ event, ...fields }, 'deployment readiness flags changed'),
    }, { onError: (error) => logger.warn({ event: 'dependency_flags_failed', code: error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'DEPENDENCY_FLAGS_FAILED' }, 'dependency flag pass failed') });
    const bridge = runtime.store as CanonicalStoreBridge;
    const liveApplication = new BackendApplication(runtime.store, runtime.coordinator, { fleetPolicy: PERSONAL_LIVE_FLEET_POLICY });
    liveRequests = startLiveRequestPoller({
      unclaimed: () => bridge.unclaimedLiveRunRequests(),
      claim: (requestId, outcome) => bridge.claimLiveRunRequest(requestId, outcome),
      campaign: (campaignId) => runtime.store.snapshot().campaigns.find((item) => item.id === campaignId),
      command: (name, input) => liveApplication.command(name, input),
      setFeeCeiling: (campaignId, gwei) => runtime.setFeeCeiling(campaignId, gwei),
      closeRun: (runId) => runtime.coordinator.closeUnsentRun(runId, 'REQUEST_FAILED'),
      record: async ({ requestId, runId, state, code, runClosed }) => {
        await runtime.store.transaction((current) => { current.events.push({ id: `live_request_result_${randomUUID()}`, type: 'live_request_result', ...(runId ? { runId } : {}), at: new Date().toISOString(), data: { requestId, state, ...(code ? { code } : {}) } }); });
        logger.info({ event: 'live_request_result', requestId, state, ...(code ? { code } : {}), ...(runClosed ? { runClosed } : {}) }, 'live request processed');
        // Each stopped request is its own alert (keyed by its id), so a repeat of the same reason is still told.
        if (state !== 'finished') await alerts.blocked(code ?? 'LIVE_REQUEST_STOPPED', runId, requestId).catch(() => undefined);
      },
      failed: (requestId, detail) => logger.warn({ event: 'live_request_failure_detail', requestId, errorName: detail.name, errorMessage: detail.message, frames: detail.frames }, 'uncoded live request failure (host journal only)'),
      now: () => new Date(),
    }, { onError: (error) => logger.warn({ event: 'live_request_poll_failed', code: error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'LIVE_REQUEST_POLL_FAILED' }, 'live request poll failed') });
  }
  // T-061: the command router, once the watcher (read by /wallets and the coordinator) exists. Its application is not the read-only
  // one, so /confirm records the owner's approval exactly as `live-request create` does; only the owner's commands reach it.
  let telegramCommands: { stop(): void } | undefined;
  let fireScheduler: { stop(): void } | undefined;
  let gasAlertChecker: { stop(): void } | undefined;
  if (telegramCommandSetup) {
    const { api, access, ownerUserId, totpKey } = telegramCommandSetup;
    const bridge = runtime.store as CanonicalStoreBridge;
    const secretRoot = configuredSecretRoot(config.projectRoot);
    // T-068: /portfolio needs the owner's Blockscout key in the secret store (BLOCKSCOUT_API_KEY); without it the command says it is off.
    let portfolioProvider: PortfolioProvider | undefined;
    let floorPrices: OpenSeaFloors | undefined;
    if (config.secretStorePath) {
      const keys = await loadHostSecretStore(config.secretStorePath);
      const portfolioKey = keys.get('BLOCKSCOUT_API_KEY');
      if (portfolioKey) { logger.registerSecret(portfolioKey); portfolioProvider = createBlockscoutPortfolio({ apiKey: portfolioKey }); }
      // T-072: OpenSea floor prices for /portfolio, when the owner has stored OPENSEA_API.
      const openSeaKey = keys.get('OPENSEA_API');
      if (openSeaKey) { logger.registerSecret(openSeaKey); floorPrices = createOpenSeaFloors({ apiKey: openSeaKey }); }
    }
    // T-072: the ETH price in dollars (display only): Chainlink through the Ethereum RPC, Coinbase as a fallback.
    let ethClient: ReturnType<typeof createPublicClient> | undefined;
    const ethereum = async () => {
      if (!ethClient) {
        const endpoints = [...(await resolveChainConfigFromSecrets(1, 'mainnet', secretRoot)).rpcEndpoints];
        if (endpoints.length === 0) throw new Error('ETHEREUM_RPC_UNAVAILABLE');
        ethClient = createPublicClient({ transport: failoverTransport(endpoints) });
      }
      return ethClient;
    };
    const priceProvider = createEthPriceProvider({
      chainlink: {
        description: async () => (await (await ethereum()).readContract({ address: CHAINLINK_ETH_USD_FEED, abi: CHAINLINK_ABI, functionName: 'description' })),
        decimals: async () => Number(await (await ethereum()).readContract({ address: CHAINLINK_ETH_USD_FEED, abi: CHAINLINK_ABI, functionName: 'decimals' })),
        latestRoundData: async () => { const round = await (await ethereum()).readContract({ address: CHAINLINK_ETH_USD_FEED, abi: CHAINLINK_ABI, functionName: 'latestRoundData' }); return { answer: round[1], updatedAt: new Date(Number(round[3]) * 1000), roundId: round[0], answeredInRound: round[4] }; },
      },
    });
    const ownerApplication = new BackendApplication(runtime.store, runtime.coordinator, { fleetPolicy: PERSONAL_LIVE_FLEET_POLICY });
    // T-067 (D-067): `/fire` and `/schedule`, in host mode only. Both end in the same pipeline and the same request processor.
    const reader = async (chainId: 1 | 8453 | 4663) => createPublicClient({ transport: failoverTransport([...(await resolveChainConfigFromSecrets(chainId, 'mainnet', secretRoot)).rpcEndpoints]) });
    const latestBlock = async (chainId: 1 | 8453 | 4663) => { const block = await (await reader(chainId)).getBlock({ blockTag: 'latest' }); return { number: block.number, hash: block.hash }; };
    const walletAddresses = async () => (await configuredWallets(config.projectRoot, configuredWalletPath(config.projectRoot))).map((wallet) => wallet.address.toLowerCase());
    const fire: FireWiring | undefined = config.mode === 'host' ? createFireWiring({
      mode: config.mode,
      store: runtime.store,
      approve: (validated) => ownerApplication.command('approve', { validated }),
      killSwitchPath: config.killSwitchPath,
      fireSchedules: () => bridge.fireScheduleRepository(),
      unclaimedRequests: () => bridge.unclaimedLiveRunRequests(),
      campaignWalletsUsed: (campaignId) => bridge.campaignWalletsUsed(campaignId),
      startedRequests: () => bridge.recentLiveRunRequests(20).filter((row) => row.outcome === 'started').map((row) => ({ id: row.id, campaignId: row.campaignId, ...(row.claimedAt ? { claimedAt: row.claimedAt } : {}) })),
      walletList: walletAddresses,
      evmPort: async (chainId) => EngineIntelligencePort.fromRpcUrls([...(await resolveChainConfigFromSecrets(chainId, 'mainnet', secretRoot)).rpcEndpoints]),
      evmLatestBlock: latestBlock,
      robinhoodDryRun: async (contract, wallets, quantity, at) => dryRunDrop(await reader(4663), contract, wallets, { ...(quantity === undefined ? {} : { quantity }), now: at }),
      robinhoodLatestBlock: () => latestBlock(4663),
      balanceOf: async (chainId, address) => (await reader(chainId as 1 | 8453 | 4663)).getBalance({ address: address as `0x${string}` }),
      kick: () => { void liveRequests?.tick(); },
    }) : undefined;
    if (fire) {
      // A schedule claimed before a crash may never have reached the request: tell the owner once at start (D-067 review).
      try {
        const results = new Set(runtime.store.snapshot().events.filter((event) => event.type === 'fire_schedule_result' && (event.data['state'] === 'fired' || event.data['state'] === 'failed')).map((event) => String(event.data['scheduleId'])));
        const dayAgo = Date.now() - 24 * 3_600_000;
        for (const row of bridge.fireScheduleRepository().recent(10)) {
          if (row.outcome === 'started' && Date.parse(row.claimedAt ?? '') > dayAgo && !results.has(row.id)) void alerts.intelligence({ kind: 'status', dedupe: `fire-schedule-unknown:${row.id}`, text: `Scheduled mint ${row.id.slice(-6)} was started but the service stopped before it reported. Check /requests and /runs before doing anything else.`, priority: 'immediate' }).catch(() => undefined);
        }
      } catch { /* a failed check never stops the service */ }
      fireScheduler = startFireScheduler({
        schedules: () => bridge.fireScheduleRepository().unclaimed(),
        claim: (scheduleId, outcome) => bridge.fireScheduleRepository().claim(scheduleId, outcome),
        campaign: (campaignId) => runtime.store.snapshot().campaigns.find((item) => item.id === campaignId),
        campaignDigest: fire.campaignDigest,
        killSwitchOn: fire.fireDeps.killSwitchOn,
        mintState: fire.mintState,
        fire: async (schedule) => { await fire.fireSchedule(schedule); },
        record: async ({ scheduleId, state, code }) => {
          await runtime.store.transaction((current) => { current.events.push({ id: `fire_schedule_result_${randomUUID()}`, type: 'fire_schedule_result', at: new Date().toISOString(), data: { scheduleId, state, ...(code ? { code } : {}) } }); });
          logger.info({ event: 'fire_schedule_result', scheduleId, state, ...(code ? { code } : {}) }, 'scheduled mint processed');
        },
        alert: async (text, dedupe) => { await alerts.intelligence({ kind: 'status', dedupe, text, priority: 'immediate' }); },
        now: () => new Date(),
      }, { onError: (error) => logger.warn({ event: 'fire_schedule_tick_failed', code: error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'FIRE_SCHEDULE_TICK_FAILED' }, 'fire schedule pass failed') });
    }
    const actions = createTelegramActions({
      mode: config.mode,
      custody: turnkeyCustodyEnabled() ? 'turnkey' : 'local',
      store: runtime.store,
      application: ownerApplication,
      coordinator: runtime.coordinator,
      projectRoot: config.projectRoot,
      secretRoot,
      killSwitchPath: config.killSwitchPath,
      backupStatusPath: config.backupStatusPath,
      startedAt: new Date(),
      walletList: async () => (await configuredWallets(config.projectRoot, configuredWalletPath(config.projectRoot))).map((wallet) => wallet.address.toLowerCase()),
      watchedWallets: (chainId) => watchConfig?.targets.filter((target) => target.chainId === chainId).map((target) => target.address) ?? [],
      watcherHealthy: () => watcherHandle?.isHealthy(new Date()),
      intelligence: () => bridge.intelligenceRepository(),
      gasAlerts: () => bridge.gasAlertRepository(),
      ...(portfolioProvider ? { portfolio: portfolioProvider } : {}),
      prices: priceProvider,
      // T-073: the Turnkey policy's Robinhood fee limit in gwei, only to check a custom fee ceiling early; the signer enforces the real limit.
      ...(Number(environment.MINT_BOT_POLICY_FEE_LIMIT_GWEI) > 0 && Number(environment.MINT_BOT_POLICY_FEE_LIMIT_GWEI) <= 500 ? { policyFeeLimitGwei: Number(environment.MINT_BOT_POLICY_FEE_LIMIT_GWEI) } : {}),
      ...(floorPrices ? { floors: floorPrices } : {}),
      ...(fire ? { fire, fireSchedulesRepository: () => bridge.fireScheduleRepository() } : {}),
    });
    const router = new TelegramCommandRouter({
      api,
      access,
      actions,
      ownerUserId,
      totpKey,
      record: async (event) => { await runtime.store.transaction((current) => { current.events.push({ id: `telegram_command_${randomUUID()}`, type: 'telegram_command', at: new Date().toISOString(), data: { ...event } }); }); },
      alert: async (text, dedupe) => { await alerts.intelligence({ kind: 'status', dedupe, text, priority: 'immediate' }); },
      log: (event, fields) => logger.warn({ event, ...fields }, event),
    });
    telegramCommands = startTelegramCommands({ api, offsets: access, router, log: (event, fields) => logger.warn({ event, ...fields }, event) });
    // T-066: the owner's fee alerts. It only reads each chain's gas price and messages the owner when it crosses a threshold.
    const gasClients = new Map<number, { reader: ReturnType<typeof createPublicClient>; at: number }>();
    gasAlertChecker = startGasAlerts({
      alerts: () => bridge.gasAlertRepository().active(),
      gasGwei: async (chainId) => {
        let cached = gasClients.get(chainId);
        // The provider list is read again every ten minutes, so a changed or repaired provider is picked up without a restart.
        if (!cached || Date.now() - cached.at > 600_000) {
          const endpoints = [...(await resolveChainConfigFromSecrets(chainId as 1 | 8453 | 4663, 'mainnet', secretRoot)).rpcEndpoints];
          if (endpoints.length === 0) return undefined;
          cached = { reader: createPublicClient({ transport: failoverTransport(endpoints) }), at: Date.now() };
          gasClients.set(chainId, cached);
        }
        const reader = cached.reader;
        return Number(formatGwei(await reader.getGasPrice()));
      },
      alert: async (text, dedupe) => { await alerts.intelligence({ kind: 'status', dedupe, text, priority: 'immediate' }); },
      log: (event, fields) => logger.warn({ event, ...fields }, event),
    });
    logger.info({ event: 'telegram_commands_started', viewers: access.activeUsers().length }, 'owner commands over Telegram started');
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
  // Outside monitor when no chain scanning runs: a liveness signal every minute ("ok" while the service can read its own database).
  // When intelligence runs, its own scan-based signal uses the same address instead, so the two never both report.
  let liveness: { stop(): void } | undefined;
  if (!intelligence && config.secretStorePath) {
    const pingUrl = validMonitorUrl((await loadHostSecretStore(config.secretStorePath)).get('HEALTHCHECK_PING_URL'));
    if (pingUrl) {
      logger.registerSecret(pingUrl);
      liveness = startLivenessPing(createMonitorPing(pingUrl), {
        healthy: () => { runtime.store.snapshot(); return true; },
        onError: (code) => logger.warn({ event: 'monitor_ping_failed', code }, 'outside monitor signal could not be sent'),
      });
      logger.info({ event: 'liveness_ping_started' }, 'outside monitor liveness signal started');
    }
  }
  metrics.set('mintbot_process_up', 1);
  logger.info({ event: 'service_started', bindHost: config.bindHost, port: config.port, mode: config.mode }, 'orchestrator service started');

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    metrics.set('mintbot_process_up', 0);
    intelligence?.stop();
    liveness?.stop();
    fleetWatcher?.stop();
    liveRequests?.stop();
    dependencyFlags?.stop();
    fireScheduler?.stop();
    telegramCommands?.stop();
    gasAlertChecker?.stop();
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

/**
 * True when this file is the program being run. Both sides are resolved through links: the host unit starts the service through the
 * /opt/mint-bot/current link while the working folder reports the real release folder, so a plain path comparison never matched
 * and the service exited at once with success.
 */
export function isServiceEntrypoint(argv1: string | undefined, cwd: string): boolean {
  if (!argv1) return false;
  const real = (path: string): string => { try { return realpathSync(path); } catch { return resolve(path); } };
  return real(argv1) === real(join(cwd, 'packages/cli/dist/orchestrator-service.js'));
}

if (isServiceEntrypoint(process.argv[1], process.cwd())) void main();
