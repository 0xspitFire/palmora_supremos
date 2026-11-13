#!/usr/bin/env node
import { createHostReplicationQualifier } from './replication-qualifier.js';
import { createPaidFundingRuntime } from './paid-funding-runtime.js';
import { startPaidFundingWorker, type PaidFundingService } from './paid-funding-service.js';
import { createReviewedProtocolDiscovery } from './reviewed-protocol-discovery.js';
import { loadReviewedProtocolStrategies } from './reviewed-protocol-profile.js';
import { readReviewedProtocolSource } from './reviewed-protocol-source.js';
import { simulateReviewedProtocolCampaign, reviewedProtocolCampaignMintState } from './reviewed-protocol-simulation.js';
import { planReviewedProtocolPreparation } from './reviewed-protocol-prepare.js';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { access, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  AlertManager,
  DiscoveryService,
  ContractMonitor,
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
import { createCliRuntime, configuredSecretRoot, configuredWalletPath, configuredWallets, turnkeyCustodyEnabled, selectTurnkeyAllowlistFamilyPolicy, selectTurnkeySignedFamilyPolicy } from './runtime.js';
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
import { assertOpsEvidenceAccepted, evaluateOpsEvidence } from '../../../scripts/ops-evidence-runtime.mjs';
import { chainRpcSecretNames, failoverTransport, NFTDiscoveryObserver, readTurnkeySecretConfig, resolveChainConfigFromSecrets } from '@mint-bot/engine';
import { startDependencyFlags } from './dependency-flags.js';
import { createPublicClient, type PublicClient, formatGwei, http as httpTransport } from 'viem';
import { startGasAlerts } from './gas-alert-service.js';
import { canonicalAnalyticsPort, startAnalyticsIngestion } from './analytics-ingestion-service.js';
import { signedMintAuthorityEndpoints } from './signed-mint-source-config.js';
import { liveRequestFollowUp, sentTransactionsForRun, startLiveRequestPoller } from './live-request.js';
import { createFireWiring, type FireWiring } from './fire-wiring.js';
import { dryRunDrop } from './robinhood-readonly.js';
import { createBlockscoutPortfolio, type PortfolioProvider } from './portfolio-provider.js';
import { combinePortfolioProviders, createOpenSeaPortfolio } from './opensea-portfolio.js';
import { CHAINLINK_ABI, CHAINLINK_ETH_USD_FEED, createEthPriceProvider } from './price-provider.js';
import { createOpenSeaFloors, type OpenSeaFloors } from './opensea-client.js';
import { startFireScheduler } from './fire.js';
import { createReplicationAutomation } from './replication-automation.js';
import { allowlistPreparationGroups, fundedReplicationWallets, prepareReplication, createReplicationAutoFunding } from './replication-prepare.js';
import { simulateAllowlistCampaign } from './allowlist-execution.js';
import { getStrategy, readTurnkeyApprovedPolicyRecords } from '@mint-bot/engine';
import { startOpsEvidenceReminders } from './ops-evidence-reminders.js';
import { startChainDiscovery } from './chain-discovery-service.js';
import { createNativeFundingRuntime } from './native-funding-runtime.js';
import { createMintStageRuntime, type MintStageRuntime } from './mint-stage-runtime.js';
import { createRoadmapIntelligence, readAdaptivePolicyProfile } from './roadmap-intelligence.js';
import { createRoadmapChainPorts } from './roadmap-intelligence-chain.js';
import { createOpenSeaExternalAnalyticsCandidates } from './external-analytics-opensea.js';
import { startChainReadiness } from './chain-readiness-service.js';
import { createNFTDiscoveryReader, startContractMonitorService } from './contract-monitor-service.js';

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
  const replicationFlag = environment.MINT_BOT_REPLICATION_AUTOMATION;
  if (replicationFlag !== undefined && replicationFlag !== 'true' && replicationFlag !== 'false') throw new Error('REPLICATION_AUTOMATION_FLAG_INVALID');
  if (replicationFlag === 'true' && (config.mode !== 'host' || !config.intelligenceEnabled || environment.MINT_BOT_TELEGRAM_COMMANDS !== 'true')) throw new Error('REPLICATION_HOST_DISCOVERY_AND_TELEGRAM_REQUIRED');
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
  let roadmapIntelligence: ReturnType<typeof createRoadmapIntelligence> | undefined;
  let stageRuntime: MintStageRuntime | undefined;
  let paidFunding:PaidFundingService|undefined;
  let paidFundingWorker:ReturnType<typeof startPaidFundingWorker>|undefined;
  const runtime = await createCliRuntime(config.projectRoot, undefined, config.statePath, {
    ...(config.mode === 'host' ? { secretRoot: configuredSecretRoot(config.projectRoot) } : {}),
    killSwitchFile: config.killSwitchPath,
    logFile: config.logPath,
  }, {
    allowTurnkey: config.mode === 'host',
    startCoordinator: config.mode === 'host',
    ...(config.mode === 'host' ? {
      coordinatorFunding: (store,assurance) => createNativeFundingRuntime({store,assurance,profilePath:environment.MINT_BOT_FUNDING_PROFILE_PATH,killSwitchPath:config.killSwitchPath,secretRoot:configuredSecretRoot(config.projectRoot),
        assertPaidFundingIntent: async(event,campaign,wallets,record)=>{if(!paidFunding)throw new Error('PAID_FUNDING_NOT_CONFIGURED');await paidFunding.assertIntent(event,campaign,wallets,record);},
        assertScoringAuthority: score => {if(roadmapIntelligence)return roadmapIntelligence.assertDecision(score);if(score.data.modelEpochId)throw new Error('NATIVE_FUNDING_ADAPTIVE_AUTHORITY_REQUIRED');},
        currentFleet: async chainId => {
          if (!turnkeyCustodyEnabled()) throw new Error('NATIVE_FUNDING_CURRENT_FLEET_REQUIRED');
          const [walletRows, records] = await Promise.all([
            configuredWallets(config.projectRoot, configuredWalletPath(config.projectRoot)),
            readTurnkeyApprovedPolicyRecords('mainnet', configuredSecretRoot(config.projectRoot)),
          ]);
          const wallets = walletRows.map(wallet => wallet.address.toLowerCase());
          const chainRecords = records.filter(record => record.enforcementPolicy.transaction.chainId === chainId);
          const organizations = new Set(chainRecords.map(record => record.providerIdentity.organizationId));
          if (!wallets.length || new Set(wallets).size !== wallets.length || organizations.size !== 1 || chainRecords.some(record => wallets.some(wallet => !record.wallets.some(approved => approved.address.toLowerCase() === wallet)))) throw new Error('NATIVE_FUNDING_CURRENT_FLEET_REQUIRED');
          return { organizationId: [...organizations][0]!, wallets };
        },
        assertUnattendedReady:async()=>{await assertOpsEvidenceAccepted({environment});}}),
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
    dispatcher = new NotificationDispatcher(runtime.store, notifier, { metrics, retentionDays: config.alertRetentionDays, minIntervalMs: 1_100 });
    const telegramHealth = await notifier.health();
    metrics.set('mintbot_notification_up', telegramHealth.status === 'ok' ? 1 : 0);
    logger.info({ event: 'telegram_health', status: telegramHealth.status, ...(telegramHealth.reason ? { reason: telegramHealth.reason } : {}) }, 'telegram notifier health checked');
  } else {
    metrics.set('mintbot_notification_up', 0);
  }
  const alerts = new AlertManager(runtime.store, dispatcher, metrics, { policy: { retentionDays: config.alertRetentionDays }, ...(config.canonicalUrlBase ? { canonicalUrlBase: config.canonicalUrlBase } : {}) });
  runtime.setAlertSink(alerts);
  // D-017: send the administrator a durable, actionable reminder when an artifact is due, three days from expiry,
  // or expired. This is host-only and uses the owner Telegram channel; it never fans out to viewers.
  let opsEvidenceReminders: { stop(): void } | undefined;
  if (config.mode === 'host' && config.telegramEnabled) {
    const interval = Number(environment.MINT_BOT_OPS_EVIDENCE_REMINDER_INTERVAL_MS);
    opsEvidenceReminders = startOpsEvidenceReminders({
      evaluate: () => evaluateOpsEvidence({ environment }),
      alert: (input) => alerts.intelligence(input),
      ...(Number.isSafeInteger(interval) && interval >= 60_000 ? { intervalMs: interval } : {}),
      logger,
    });
  }
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
  let replicationAutomation: ReturnType<typeof createReplicationAutomation> | undefined;
  let replicationTimer: ReturnType<typeof setInterval> | undefined;
  const secondaryDiscoveryTimers: Array<{ stop(): void }> = [];
  const secondaryReadinessTimers: Array<{ stop(): Promise<void> }> = [];
  let intelligence: { stop(): void } | undefined;
  let contractMonitorService: ReturnType<typeof startContractMonitorService> | undefined;
  let sharedFloorPrices: OpenSeaFloors | undefined;
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
    const readinessWallets = config.mode === 'host'
      ? async () => (await configuredWallets(config.projectRoot, configuredWalletPath(config.projectRoot))).map(wallet => wallet.address.toLowerCase())
      : async () => config.readinessWallets;
    const initialWallets = await readinessWallets();
    if (config.mode === 'host') {
      const readers = new Map<number, Promise<Array<{identity:string;client:PublicClient}>>>();
      const clients = (chainId: 1 | 8453 | 4663) => {
        let cached = readers.get(chainId);
        if (!cached) { cached = (async () => { const endpoints = signedMintAuthorityEndpoints((await resolveChainConfigFromSecrets(chainId, 'mainnet', configuredSecretRoot(config.projectRoot))).rpcEndpoints); return endpoints.map(endpoint => ({identity:new URL(endpoint).hostname.toLowerCase(), client:createPublicClient({transport:httpTransport(endpoint,{timeout:5000,retryCount:0})})})); })(); readers.set(chainId,cached); }
        return cached;
      };
      const openSeaKey = secrets.get('OPENSEA_API');
      if (openSeaKey) { logger.registerSecret(openSeaKey); sharedFloorPrices = createOpenSeaFloors({apiKey:openSeaKey}); }
      let policies;
      try { policies = await readAdaptivePolicyProfile(environment.MINT_BOT_ADAPTIVE_POLICY_PATH); }
      catch { logger.warn({event:'adaptive_profile_unavailable'},'Adaptive profile unavailable; static scoring remains active'); }
      const bridge = runtime.store as CanonicalStoreBridge;
      roadmapIntelligence = createRoadmapIntelligence({store:runtime.store,clients,ownedWallets:async()=>{const wallets=await readinessWallets();return ([1,8453,4663] as const).flatMap(chainId=>wallets.map(address=>({chainId,address})));},watchedWallets:async()=> ([1,8453,4663] as const).flatMap(chainId=>bridge.intelligenceRepository().observedAddresses(chainId).map(wallet=>({chainId,address:wallet.address}))),floors:sharedFloorPrices,...(openSeaKey?{candidatePort:createOpenSeaExternalAnalyticsCandidates({apiKey:openSeaKey})}:{}),chainPort:createRoadmapChainPorts({clients}),adaptivePolicies:policies,record:code=>logger.warn({event:'roadmap_intelligence_unavailable',code},'Optional intelligence observation unavailable')});
      await roadmapIntelligence.tick();
      roadmapIntelligence.start();
    }
    intelligence = startIntelligence({ advanced:roadmapIntelligence?.advanced, history:roadmapIntelligence?.history, adaptive:roadmapIntelligence?.adaptive, store: runtime.store, repo: (runtime.store as CanonicalStoreBridge).intelligenceRepository(), port: EngineIntelligencePort.fromRpcUrls(rpcUrls), alerts: intelligenceAlerts, wallets: initialWallets, walletProvider: readinessWallets, logger, discoveryIntervalMs: config.discoveryIntervalMs, discoveryMaxLagBlocks: config.discoveryMaxLagBlocks, readinessIntervalMs: config.readinessIntervalMs, digestIntervalMs: config.digestIntervalMs, startNumber: restartCount, ...(monitorUrl ? { monitorPing: createMonitorPing(monitorUrl) } : {}), heartbeatPath: join(dirname(config.statePath), 'heartbeat'), version: await codeVersion(config.projectRoot), sampleHost: async () => ({ disk: await diskFacts(dirname(config.statePath)), backup: await backupFacts(config.backupStatusPath) }) });
    logger.info({ event: 'intelligence_started', readinessWallets: initialWallets.length }, 'phase 2 intelligence started (read-only)');
    // Secondary discovery/readiness is useful even when automatic execution is off.
    // Each chain owns its completion-driven timers, and readiness never waits in a scan tick.
    const bridge = runtime.store as CanonicalStoreBridge;
    for (const chainId of [8453, 4663] as const) {
      const enabled = () => runtime.store.snapshot().chainEvidence.some(e => e.chainId === chainId && e.status === 'accepted' && e.executionEnabled && Date.parse(e.expiresAt) > Date.now());
      if (!enabled()) continue;
      const endpoints = [...(await resolveChainConfigFromSecrets(chainId, 'mainnet', configuredSecretRoot(config.projectRoot))).rpcEndpoints];
      for (const endpoint of endpoints) logger.registerSecret(endpoint);
      const port = EngineIntelligencePort.fromRpcUrls(endpoints, chainId);
      const discovery = new DiscoveryService(runtime.store, bridge.intelligenceRepository(), port, { budgetPerNftWei: PERSONAL_LIVE_FLEET_POLICY.paidMaxPricePerNftWei, alerts: intelligenceAlerts,advanced:roadmapIntelligence?.advanced,history:roadmapIntelligence?.history,adaptive:roadmapIntelligence?.adaptive });
      secondaryDiscoveryTimers.push(startChainDiscovery({
        chainId, intervalMs: config.discoveryIntervalMs, tick: () => discovery.tick(), logger,
        notify: (text, dedupe) => intelligenceAlerts.intelligence({ kind: 'status', text, dedupe, priority: 'immediate' }),
      }));
      secondaryReadinessTimers.push(startChainReadiness({
        store: runtime.store, port, wallets: readinessWallets, enabled,
        intervalMs: config.readinessIntervalMs, alerts: intelligenceAlerts, logger,
      }));
    }

  }
  // T-125 is separately opt-in: monitoring adds no chain execution baseline or mint strategy.
  // Its single fair timer leaves the existing SeaDrop discovery timers unchanged.
  if (environment.MINT_BOT_CONTRACT_MONITOR_ENABLED === 'true') {
    if (config.mode !== 'host') throw new Error('CONTRACT_MONITOR_HOST_MODE_REQUIRED');
    const bridge = runtime.store as CanonicalStoreBridge;
    const repo = bridge.intelligenceRepository();
    const chains = [];
    const reviewedProfiles = turnkeyCustodyEnabled() ? await loadReviewedProtocolStrategies(configuredSecretRoot(config.projectRoot)) : [];
    for (const chainId of [1, 8453, 4663] as const) {
      const endpoints = signedMintAuthorityEndpoints((await resolveChainConfigFromSecrets(chainId, 'mainnet', configuredSecretRoot(config.projectRoot))).rpcEndpoints);
      for (const endpoint of endpoints) logger.registerSecret(endpoint);
      const observer = new NFTDiscoveryObserver({ chainId, readers: endpoints.map(endpoint => ({ endpoint, client: createNFTDiscoveryReader(endpoint) })) });
      // This instance publishes generic facts only; it never runs a SeaDrop tick or enters its tracked catalog.
      const publisher = new DiscoveryService(runtime.store, repo, EngineIntelligencePort.fromRpcUrls(endpoints, chainId), { budgetPerNftWei: PERSONAL_LIVE_FLEET_POLICY.paidMaxPricePerNftWei });
      const reviewed = reviewedProfiles.find(profile => profile.registry.chainId === chainId);
      const reviewedPublisher = reviewed ? createReviewedProtocolDiscovery({store:runtime.store,advanced:roadmapIntelligence?.advanced,history:roadmapIntelligence?.history,adaptive:roadmapIntelligence?.adaptive,alerts:intelligenceAlerts,qualify:async observation=>{
        const wallets=(await configuredWallets(config.projectRoot,configuredWalletPath(config.projectRoot))).slice(0,1).map(wallet=>wallet.address);
        if(!wallets.length)return undefined;
        return readReviewedProtocolSource({registry:reviewed.registry,clients:reviewed.clients,contract:observation.contract as `0x${string}`,hash:observation.transactionHash as `0x${string}`,watchedWallets:repo.observedAddresses(chainId).map(row=>row.address),targetWallets:wallets});
      }}) : undefined;
      const monitor = new ContractMonitor({ store: runtime.store, chainId, port: observer, watched: () => repo.observedAddresses(chainId).map(row => row.address), publish: async observation => {await publisher.observeVerifiedNFT(observation);await reviewedPublisher?.observe(observation);} });
      chains.push({ chainId, monitor });
    }
    contractMonitorService = startContractMonitorService({ enabled: true, chains, intervalMs: 10_000, tickTimeoutMs: 45_000,
      report: (chainId, result) => logger.info({ event: 'contract_monitor_tick', chainId, status: result.status, reason: result.reason, pending: result.pending, captured: result.captured, published: result.published,
        ...(result.scan ? { fromBlock: result.scan.fromBlock, toBlock: result.scan.toBlock, settledHead: result.scan.settledHead, callsUsed: result.scan.callsUsed, partialReasons: result.scan.partialReasons, deploymentBlocksInspected: result.scan.deploymentBlocksInspected, deploymentBlocksOmitted: result.scan.deploymentBlocksOmitted, factoryCoverage: result.scan.factoryCoverage,
          lagBlocks: (BigInt(result.scan.settledHead) > (result.scan.continuation ? BigInt(result.scan.fromBlock) - 1n : BigInt(result.scan.toBlock)) ? BigInt(result.scan.settledHead) - (result.scan.continuation ? BigInt(result.scan.fromBlock) - 1n : BigInt(result.scan.toBlock)) : 0n).toString(), rangePending: Boolean(result.scan.continuation) } : {}) }, 'read-only generic NFT monitor tick'),
    });
    logger.info({ event: 'contract_monitor_started', chains: [1, 8453, 4663], intervalMs: 10_000, maxCallsPerSelectedTick: 64 }, 'opt-in generic NFT monitoring started; deployment coverage is sampled');
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
    const liveApplication = new BackendApplication(runtime.store, runtime.coordinator, { fleetPolicy: PERSONAL_LIVE_FLEET_POLICY, ...(runtime.custodyPolicyFor ? { custodyPolicyFor: runtime.custodyPolicyFor } : {}) });
    liveRequests = startLiveRequestPoller({
      unclaimed: () => bridge.unclaimedLiveRunRequests(),
      claim: (requestId, outcome) => bridge.claimLiveRunRequest(requestId, outcome),
      campaign: (campaignId) => runtime.store.snapshot().campaigns.find((item) => item.id === campaignId),
      command: (name, input) => liveApplication.command(name, input),
      setFeeCeiling: (campaignId, gwei) => runtime.setFeeCeiling(campaignId, gwei),
      closeRun: (runId) => runtime.coordinator.closeUnsentRun(runId, 'REQUEST_FAILED'),
      assertUnattendedReady: async () => { await assertOpsEvidenceAccepted({ environment }); },
      assertAutomationReady: async (eventId, campaign, wallets, maxFeeGwei) => {
        if (!replicationAutomation) throw new Error('AUTOMATION_NOT_CONFIGURED');
        await replicationAutomation.assertReady(eventId, campaign, wallets, maxFeeGwei);
      },
      assertScheduledCampaignReady: async (campaign,scheduleId,wallets) => {
        const schedule=scheduleId?(runtime.store as CanonicalStoreBridge).fireScheduleRepository().get(scheduleId):undefined;
        if(!stageRuntime||!schedule||!wallets)throw new Error('MINT_STAGE_APPROVAL_REQUIRED');
        await stageRuntime.assertRequested(schedule,campaign,wallets);
        const prepared = runtime.store.snapshot().events.find((e) => e.type === 'replication_prepared' && e.data.campaignId === campaign.id);
        if (!prepared) return;
        if (campaign.mintPriceWei !== 0n) throw new Error('PAID_REPLICATION_FINAL_FIRE_REQUIRED');
        if (!replicationAutomation) throw new Error('AUTOMATION_NOT_CONFIGURED');
        await replicationAutomation.assertReady(prepared.id, campaign);
      },
      sentTransactions: (runId) => { const state = runtime.store.snapshot(); return sentTransactionsForRun(state.attempts, state.receipts, runId); },
      record: async ({ requestId, runId, campaignId, state, code, runClosed, sent }) => {
        await runtime.store.transaction((current) => { current.events.push({ id: `live_request_result_${randomUUID()}`, type: 'live_request_result', ...(runId ? { runId } : {}), at: new Date().toISOString(), data: { requestId, state, ...(code ? { code } : {}) } }); });
        logger.info({ event: 'live_request_result', requestId, state, ...(code ? { code } : {}), ...(runClosed ? { runClosed } : {}) }, 'live request processed');
        // Each stopped request is its own alert (keyed by its id), so a repeat of the same reason is still told.
        const followUp = liveRequestFollowUp({ state, ...(sent ? { sent } : {}) });
        if (followUp === 'blocked') await alerts.blocked(code ?? 'LIVE_REQUEST_STOPPED', runId, requestId).catch(() => undefined);
        // T-086: a mint that was sent says so, once per transaction, with the explorer link (the hash is shortened in the text).
        if (followUp === 'sent' && runId) {
          const campaign = runtime.store.snapshot().campaigns.find((item) => item.id === campaignId);
          if (campaign) for (const tx of (sent ?? []).slice(0, 5)) await alerts.sent(runId, { chainId: campaign.chainId, collection: `${campaign.contract.slice(0, 6)}…${campaign.contract.slice(-4)}`, wallet: tx.wallet, quantity: campaign.quantity, hash: tx.hash }).catch(() => undefined);
        }
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
    let floorPrices: OpenSeaFloors | undefined = sharedFloorPrices;
    if (config.secretStorePath) {
      const keys = await loadHostSecretStore(config.secretStorePath);
      const portfolioKey = keys.get('BLOCKSCOUT_API_KEY');
      if (portfolioKey) { logger.registerSecret(portfolioKey); portfolioProvider = createBlockscoutPortfolio({ apiKey: portfolioKey }); }
      // T-072: OpenSea floor prices for /portfolio, when the owner has stored OPENSEA_API.
      const openSeaKey = keys.get('OPENSEA_API');
      if (openSeaKey) { logger.registerSecret(openSeaKey); floorPrices ??= createOpenSeaFloors({ apiKey: openSeaKey }); }
      portfolioProvider = combinePortfolioProviders({ blockscout: portfolioProvider, ...(openSeaKey ? { openSea: createOpenSeaPortfolio({ apiKey: openSeaKey }) } : {}) });
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
    const ownerApplication = new BackendApplication(runtime.store, runtime.coordinator, { fleetPolicy: PERSONAL_LIVE_FLEET_POLICY, ...(runtime.custodyPolicyFor ? { custodyPolicyFor: runtime.custodyPolicyFor } : {}) });
    // T-067 (D-067): `/fire` and `/schedule`, in host mode only. Both end in the same pipeline and the same request processor.
    const reader = async (chainId: 1 | 8453 | 4663) => createPublicClient({ transport: failoverTransport([...(await resolveChainConfigFromSecrets(chainId, 'mainnet', secretRoot)).rpcEndpoints]) });
    const latestBlock = async (chainId: 1 | 8453 | 4663) => { const block = await (await reader(chainId)).getBlock({ blockTag: 'latest' }); return { number: block.number, hash: block.hash }; };
    const walletAddresses = async () => (await configuredWallets(config.projectRoot, configuredWalletPath(config.projectRoot))).map((wallet) => wallet.address.toLowerCase());
    let fire: FireWiring | undefined;
    stageRuntime = config.mode==='host'?createMintStageRuntime({store:runtime.store,readDrop:async campaign=>getStrategy(campaign.strategy).readDrop(await reader(campaign.chainId),campaign.contract as `0x${string}`,campaign.chainId),validate:async(campaign,wallets)=>{await assertOpsEvidenceAccepted({environment});if(!assuranceWiring||!fire)throw new Error('MINT_STAGE_CUSTODY_REQUIRED');await assuranceWiring.refreshReadiness({campaign,chainId:campaign.chainId,wallets});const simulation=await fire.fireDeps.recordSimulations(campaign,wallets);if(!simulation.recorded.length)throw new Error('MINT_STAGE_SIMULATION_REQUIRED');}}):undefined;
    fire = config.mode === 'host' ? createFireWiring({
      stage:stageRuntime,
      mode: config.mode,
      store: runtime.store,
      approve: (validated) => ownerApplication.command('approve', { validated }),
      killSwitchPath: config.killSwitchPath,
      fireSchedules: () => bridge.fireScheduleRepository(),
      unclaimedRequests: () => bridge.unclaimedLiveRunRequests(),
      campaignWalletsUsed: (campaignId) => bridge.campaignWalletsUsed(campaignId),
      startedRequests: () => bridge.recentLiveRunRequests(20).filter((row) => row.outcome === 'started').map((row) => ({ id: row.id, campaignId: row.campaignId, ...(row.claimedAt ? { claimedAt: row.claimedAt } : {}) })),
      walletList: walletAddresses,
      evmPort: async (chainId, strategy) => EngineIntelligencePort.fromRpcUrls([...(await resolveChainConfigFromSecrets(chainId, 'mainnet', secretRoot)).rpcEndpoints], chainId, strategy === 'seadrop-v1-public'),
      evmLatestBlock: latestBlock,
      reviewedProtocolSimulation: (campaign, wallets) => simulateReviewedProtocolCampaign({store:runtime.store,campaign,wallets,secretRoot}),
      reviewedProtocolMintState: campaign => reviewedProtocolCampaignMintState({store:runtime.store,campaign,secretRoot}),
      allowlistSimulation: async (campaign, wallets) => simulateAllowlistCampaign({ campaign, wallets, client: await reader(campaign.chainId as 1 | 8453 | 4663), store: runtime.store, secretRoot }),
      allowlistMintState: async (campaign) => {
        const drop = await getStrategy(campaign.strategy).readDrop(await reader(campaign.chainId as 1 | 8453 | 4663), campaign.contract as `0x${string}`, campaign.chainId as 1 | 8453 | 4663);
        const now = Date.now() / 1000;
        return now < drop.startTime ? 'upcoming' : now > drop.endTime ? 'ended' : 'open';
      },
      robinhoodDryRun: async (contract, wallets, quantity, at, publicOnly) => dryRunDrop(await reader(4663), contract, wallets, { ...(quantity === undefined ? {} : { quantity }), now: at, publicOnly }),
      robinhoodLatestBlock: () => latestBlock(4663),
      balanceOf: async (chainId, address) => (await reader(chainId as 1 | 8453 | 4663)).getBalance({ address: address as `0x${string}` }),
      kick: () => { void liveRequests?.tick(); },
      assertUnattendedReady: async () => { await assertOpsEvidenceAccepted({ environment }); },
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
        stageDecision: fire.inspectScheduleStage,
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
    if (environment.MINT_BOT_REPLICATION_AUTOMATION === 'true') {
      if (!fire || !config.intelligenceEnabled) throw new Error('REPLICATION_HOST_DISCOVERY_REQUIRED');
      const maxFeeGwei = Number(environment.MINT_BOT_REPLICATION_MAX_FEE_GWEI);
      const maxQuantity = Number(environment.MINT_BOT_REPLICATION_MAX_QUANTITY ?? '1');
      if (!Number.isFinite(maxFeeGwei) || maxFeeGwei <= 0 || maxFeeGwei > 500 || !Number.isSafeInteger(maxQuantity) || maxQuantity < 1 || maxQuantity > 15) throw new Error('REPLICATION_LIMIT_CONFIG_REQUIRED');
      const watchedWallets = (chainId: number) => bridge.intelligenceRepository().observedAddresses(chainId).map((wallet) => wallet.address);
      const prepareAutomatic: import('./replication-automation.js').ReplicationAutomationDeps['prepare'] = async(source,wallets) => {
          const status = bridge.ethereumFeePolicyStatus();
          const tipWei = source.drop.chainId === 1 ? BigInt(status.stored?.tipWei ?? status.approved?.tipWei ?? '100000000') : 100_000_000n;
          const prepare = (selected: readonly `0x${string}`[]) => prepareReplication({ source, wallets: selected, maxQuantity, maxFeeGwei, tipWei, store: runtime.store, createCampaign: (input) => ownerApplication.createCampaign(input), now: new Date() });
          if (source.drop.strategyName !== 'seadrop-v1-allowlist') return prepare(wallets);
          const targets = source.plan.targets.map((target) => target.wallet);
          const paid = source.drop.mintPrice > 0n;
          const eligible = allowlistPreparationGroups({ wallets, targets, paid, sharedFamily: true, paidMaxWallets: PERSONAL_LIVE_FLEET_POLICY.paidMaxWalletsPerMint }).flat();
          const quantity = Math.min(maxQuantity, source.plan.observed.quantity ?? 0, source.drop.maxTotalMintableByWallet, source.drop.chainId === 8453 ? 4 : 15);
          const sharedFamily = !paid && eligible.length > 0 && Boolean(selectTurnkeyAllowlistFamilyPolicy(await readTurnkeyApprovedPolicyRecords('mainnet', secretRoot), { chainId: source.drop.chainId, strategy: source.drop.strategyName, quantity, mintPriceWei: source.drop.mintPrice, walletScope: eligible }));
          const groups = allowlistPreparationGroups({ wallets, targets, paid, sharedFamily, paidMaxWallets: PERSONAL_LIVE_FLEET_POLICY.paidMaxWalletsPerMint });
          const prepared = [];
          for (const group of groups) prepared.push(await prepare(group));
          return prepared;
        };
      const fundingWallets = async(source:import('./replication-source.js').QualifiedSource,wallets:readonly `0x${string}`[]) => {const client=await reader(source.drop.chainId);return fundedReplicationWallets(source,wallets,maxQuantity,wallet=>client.getBalance({address:wallet}));};
      const qualifyReplicationSource=createHostReplicationQualifier({store:runtime.store,secretRoot,maxQuantity,reader,watchedWallets});
      replicationAutomation = createReplicationAutomation({
        store: runtime.store, watchedWallets,
        wallets: async () => (await walletAddresses()) as `0x${string}`[],
        fundedWallets: async (source, wallets) => {
          const client = await reader(source.drop.chainId);
          return fundedReplicationWallets(source, wallets, maxQuantity, wallet => client.getBalance({ address: wallet }));
        },
        qualify: async (event, wallets) => {
          const chainId = Number(event.data.chainId);
          if (![1, 8453, 4663].includes(chainId) || !/^0x[0-9a-fA-F]{40}$/.test(String(event.data.contract)) || !/^0x[0-9a-fA-F]{64}$/.test(String(event.data.txHash))) throw new Error('REPLICATION_SOURCE_INVALID');
          const source = await qualifyReplicationSource(event,wallets);
          if (source.drop.strategyName === 'seadrop-v1-signed') {
            const quantity = Math.min(maxQuantity, source.plan.observed.quantity ?? 0, source.drop.maxTotalMintableByWallet, chainId === 8453 ? 4 : 10);
            const walletScope = source.plan.targets.map(target => target.wallet);
            if (!selectTurnkeySignedFamilyPolicy(await readTurnkeyApprovedPolicyRecords('mainnet', secretRoot), { chainId: source.drop.chainId, strategy: source.drop.strategyName, quantity, mintPriceWei: source.drop.mintPrice, walletScope })) throw new Error('TURNKEY_SIGNED_FAMILY_APPROVAL_REQUIRED');
            if (!runtime.store.snapshot().chainEvidence.some(evidence => evidence.chainId === chainId && evidence.status === 'accepted' && evidence.executionEnabled && Date.parse(evidence.expiresAt) > Date.now() && evidence.strategyVersion === 'seadrop-v1-baseline-public-free-allowlist-free-signed@1')) throw new Error('SIGNED_MINT_CHAIN_REHEARSAL_ACCEPTANCE_REQUIRED');
          }
          return source;
        },
        assertSourceAuthority:qualifyReplicationSource.assertSourceAuthority,
        prepare: prepareAutomatic,
        ...(environment.MINT_BOT_FUNDING_PROFILE_PATH?{autoFunding:createReplicationAutoFunding({store:runtime.store,coordinator:runtime.coordinator,prepare:prepareAutomatic,funded:fundingWallets})}:{}),
        fire: fire.fireDeps, fireAutonomous: fire.fireAutonomous,
        assertScoringAuthority: score => {if(roadmapIntelligence)return roadmapIntelligence.assertDecision(score);if(score.data.modelEpochId)throw new Error('ADAPTIVE_DECISION_AUTHORITY_REQUIRED');},
        assertUnattendedReady: () => fire.assertUnattendedReady(),
        notify: async (text, dedupe) => { await alerts.intelligence({ kind: 'status', dedupe, text, priority: 'immediate' }); },
      });
      replicationTimer = setInterval(() => { void replicationAutomation?.tick().catch(() => logger.warn({ event: 'replication_tick_failed' }, 'replication pass failed')); }, 2_000);
      replicationTimer.unref();
    }
    if(config.mode==='host'&&environment.MINT_BOT_FUNDING_PROFILE_PATH&&fire){
      paidFunding=createPaidFundingRuntime({store:runtime.store,coordinator:runtime.coordinator,ownerId:ownerUserId,stage:()=>stageRuntime,wallets:walletAddresses,balance:async wallet=>(await reader(1)).getBalance({address:wallet as `0x${string}`}),killSwitchOn:fire.fireDeps.killSwitchOn,
        assertReady:async(campaign,wallets)=>{await assertOpsEvidenceAccepted({environment});if(!assuranceWiring)throw new Error('PAID_FUNDING_CUSTODY_REQUIRED');await assuranceWiring.refreshReadiness({campaign,chainId:campaign.chainId,wallets});},
        simulate:(campaign,wallets)=>fire!.fireDeps.recordSimulations(campaign,wallets),notify:async(text,dedupe)=>{await alerts.intelligence({kind:'status',text,dedupe,priority:'immediate'});}});
      paidFundingWorker=startPaidFundingWorker(paidFunding);
    }
    const actions = createTelegramActions({
      mode: config.mode,
      reviewedProtocolPlan: input => planReviewedProtocolPreparation({...input,store:runtime.store,secretRoot,killSwitchPath:config.killSwitchPath}),
      reviewedProtocolSimulation: (campaign, wallets) => simulateReviewedProtocolCampaign({store:runtime.store,campaign,wallets,secretRoot}),
      walletAdministrationOwnerId: ownerUserId,
      ...(paidFunding?{paidFunding}:{}),
      custody: turnkeyCustodyEnabled() ? 'turnkey' : 'local',
      store: runtime.store,
      application: ownerApplication,
      coordinator: runtime.coordinator,
      reconcileNow: () => runtime.coordinator.reconcile(),
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
  const analyticsIngestion = config.mode === 'host' ? startAnalyticsIngestion({
    store: runtime.store,
    port: async chainId => {
      const endpoints = signedMintAuthorityEndpoints((await resolveChainConfigFromSecrets(chainId, 'mainnet', configuredSecretRoot(config.projectRoot))).rpcEndpoints);
      const readers = endpoints.map(endpoint => createPublicClient({ transport: httpTransport(endpoint, { timeout: 5_000, retryCount: 0 }) }));
      return canonicalAnalyticsPort(chainId, readers);
    },
    record: code => logger.warn({ event: 'analytics_ingestion_unavailable', code }, 'shadow analytics ingestion unavailable'),
  }) : undefined;
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
    contractMonitorService?.stop();
    liveness?.stop();
    fleetWatcher?.stop();
    liveRequests?.stop();
    dependencyFlags?.stop();
    fireScheduler?.stop();
    await paidFundingWorker?.stop();
    if (replicationTimer) clearInterval(replicationTimer);
    for (const timer of secondaryDiscoveryTimers) timer.stop();
    await Promise.all(secondaryReadinessTimers.map(timer => timer.stop()));
    telegramCommands?.stop();
    gasAlertChecker?.stop();
    opsEvidenceReminders?.stop();
    backups?.stop();
    await analyticsIngestion?.stop();
    await roadmapIntelligence?.stop();
    await contractMonitorService?.drain();
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
