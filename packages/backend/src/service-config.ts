import { dirname, isAbsolute, resolve } from 'node:path';

export type ServiceMode = 'dry-run' | 'host';
export interface OrchestratorServiceConfig {
  mode: ServiceMode;
  projectRoot: string;
  statePath: string;
  walPath: string;
  jobsPath: string;
  backupDir: string;
  backupStatusPath: string;
  restartCounterPath: string;
  logPath: string;
  logMaxBytes: number;
  logMaxFiles: number;
  killSwitchPath: string;
  requireStartupKillSwitch: boolean;
  telegramEnabled: boolean;
  secretStorePath?: string;
  telegramTokenName: string;
  telegramChatIdName: string;
  telegramApiBaseUrl: string;
  bindHost: string;
  port: number;
  schedulerIntervalMs: number;
  reconciliationIntervalMs: number;
  maxConcurrentJobs: number;
  alertRetentionDays: number;
  canonicalUrlBase?: string;
}
export type ServiceConfigSummary = Omit<OrchestratorServiceConfig, 'secretStorePath'> & { secretStoreConfigured: boolean };

function value(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const candidate = env[key];
  if (candidate === undefined || candidate === '') return undefined;
  if (/[\r\n]/.test(candidate)) throw new Error(`${key}_INVALID`);
  return candidate;
}
function bool(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const candidate = value(env, key);
  if (candidate === undefined) return fallback;
  if (candidate === 'true' || candidate === '1') return true;
  if (candidate === 'false' || candidate === '0') return false;
  throw new Error(`${key}_INVALID`);
}
function integer(env: NodeJS.ProcessEnv, key: string, fallback: number, minimum: number): number {
  const candidate = value(env, key);
  if (candidate === undefined) return fallback;
  const parsed = Number(candidate);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(`${key}_INVALID`);
  return parsed;
}
function path(env: NodeJS.ProcessEnv, key: string, fallback: string, root: string): string {
  const candidate = value(env, key) ?? fallback;
  return isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate);
}

export function loadServiceConfig(env: NodeJS.ProcessEnv = process.env, projectRoot = process.cwd()): OrchestratorServiceConfig {
  if (value(env, 'TG_BOT_TOKEN') !== undefined || value(env, 'TG_CHAT_ID') !== undefined) throw new Error('TELEGRAM_SECRETS_MUST_USE_SECRET_STORE');
  const root = resolve(projectRoot);
  const modeValue = value(env, 'MINT_BOT_SERVICE_MODE') ?? 'dry-run';
  if (modeValue !== 'dry-run') throw new Error('PHASE2_DRY_RUN_ONLY');
  const mode: ServiceMode = 'dry-run';
  const statePath = path(env, 'MINT_BOT_STATE_PATH', value(env, 'STORE_PATH') ?? '.runtime/ci/mintbot.sqlite', root);
  const backupDir = path(env, 'MINT_BOT_BACKUP_DIR', '.runtime/ci/backups', root);
  const logPath = path(env, 'MINT_BOT_LOG_PATH', value(env, 'MINT_BOT_LOG_FILE') ?? '.runtime/ci/orchestrator.log', root);
  const jobsPath = path(env, 'MINT_BOT_JOBS_PATH', '.runtime/ci/orchestrator-jobs.json', root);
  const killSwitchPath = path(env, 'KILL_SWITCH_PATH', '.runtime/ci/killswitch', root);
  const restartCounterPath = path(env, 'MINT_BOT_RESTART_COUNTER_PATH', '.runtime/ci/restarts', root);
  const secretStorePath = value(env, 'SECRET_STORE_PATH');
  if (secretStorePath && !isAbsolute(secretStorePath)) throw new Error('SECRET_STORE_PATH_MUST_BE_ABSOLUTE');
  const telegramEnabled = bool(env, 'MINT_BOT_TELEGRAM_ENABLED', false);
  if (telegramEnabled && !secretStorePath) throw new Error('TELEGRAM_SECRET_STORE_REQUIRED');
  const telegramApiBaseUrl = value(env, 'MINT_BOT_TELEGRAM_API_BASE_URL') ?? 'https://api.telegram.org';
  if (!telegramApiBaseUrl.startsWith('https://') && value(env, 'MINT_BOT_APPROVED_TELEGRAM_PROXY') !== 'true') throw new Error('TELEGRAM_HTTPS_REQUIRED');
  const bindHost = value(env, 'MINT_BOT_BIND_HOST') ?? '127.0.0.1';
  if (bindHost !== '127.0.0.1' && bindHost !== '::1' && bindHost !== 'localhost') throw new Error('BIND_HOST_MUST_BE_LOOPBACK');
  const port = integer(env, 'MINT_BOT_HEALTH_PORT', integer(env, 'MINT_BOT_HTTP_PORT', 8780, 0), 0);
  if (port > 65_535) throw new Error('MINT_BOT_HEALTH_PORT_INVALID');
  return {
    mode,
    projectRoot: root,
    statePath,
    walPath: `${statePath}-wal`,
    jobsPath,
    backupDir,
    backupStatusPath: path(env, 'MINT_BOT_BACKUP_STATUS_PATH', `${backupDir}/status.json`, root),
    restartCounterPath,
    logPath,
    logMaxBytes: integer(env, 'MINT_BOT_LOG_MAX_BYTES', 10 * 1024 * 1024, 1_024),
    logMaxFiles: integer(env, 'MINT_BOT_LOG_MAX_FILES', 5, 1),
    killSwitchPath,
    requireStartupKillSwitch: bool(env, 'MINT_BOT_REQUIRE_STARTUP_KILL_SWITCH', true),
    telegramEnabled,
    ...(secretStorePath ? { secretStorePath } : {}),
    telegramTokenName: value(env, 'MINT_BOT_TELEGRAM_TOKEN_NAME') ?? 'TG_BOT_TOKEN',
    telegramChatIdName: value(env, 'MINT_BOT_TELEGRAM_CHAT_ID_NAME') ?? 'TG_CHAT_ID',
    telegramApiBaseUrl,
    bindHost,
    port,
    schedulerIntervalMs: integer(env, 'MINT_BOT_SCHEDULER_INTERVAL_MS', 1_000, 100),
    reconciliationIntervalMs: integer(env, 'MINT_BOT_RECONCILIATION_INTERVAL_MS', 30_000, 1_000),
    maxConcurrentJobs: integer(env, 'MINT_BOT_MAX_CONCURRENT_JOBS', 1, 1),
    alertRetentionDays: integer(env, 'MINT_BOT_ALERT_RETENTION_DAYS', 30, 1),
    ...(value(env, 'MINT_BOT_CANONICAL_URL') ? { canonicalUrlBase: value(env, 'MINT_BOT_CANONICAL_URL') } : {}),
  };
}

export function summarizeServiceConfig(config: OrchestratorServiceConfig): ServiceConfigSummary {
  const { secretStorePath: _secretStorePath, ...safe } = config;
  return { ...safe, secretStoreConfigured: Boolean(config.secretStorePath) };
}

export function runtimeParentPaths(config: OrchestratorServiceConfig): string[] {
  return [...new Set([dirname(config.statePath), dirname(config.jobsPath), config.backupDir, dirname(config.logPath), dirname(config.killSwitchPath), dirname(config.restartCounterPath)])];
}
