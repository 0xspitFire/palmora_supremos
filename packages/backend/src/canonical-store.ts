import { createHash, randomUUID } from 'node:crypto';
import type {
  AuditEventRecord,
  ExecutionRunRecord,
  LifecycleEventRecord,
  ReceiptRecord as DatabaseReceiptRecord,
  ReconciliationRecord as DatabaseReconciliationRecord,
  SettlementComponents,
  SqliteDatabase,
  TransactionIntentRecord,
} from '@mint-bot/database';
import { SqliteBackendStore } from '@mint-bot/database';
import type {
  AttemptRecord,
  BackendState,
  Campaign,
  CampaignState,
  ChainEvidenceRecord,
  ChainVerification,
  EventRecord,
  ExecutionResult,
  FeePolicy,
  IntentRecord,
  ReconciliationRecord,
  Reservation,
  ReceiptRecord,
  RunRecord,
  SimulationEvidenceRecord,
  SpendPolicy,
  StoreCapabilities,
} from './types.js';
import type { BackendStore } from './store.js';

export interface CanonicalAdmissionInput {
  run: RunRecord;
  intent: IntentRecord;
  campaign: Campaign;
  wallets: readonly string[];
}

export interface PreparedExecution {
  wallet: string;
  intentId: string;
  executionId: string;
}

export interface CanonicalAdmissionResult {
  reservations: Reservation[];
  executions: PreparedExecution[];
}

export interface CanonicalExecutionStore extends BackendStore {
  admitExecution(input: CanonicalAdmissionInput): Promise<CanonicalAdmissionResult>;
  abortRemaining(reason: string): Promise<void>;
}

interface DatabaseRunRow {
  id: string;
  request_id: string;
  request_fingerprint: string;
  campaign_id: string | null;
  state: string;
  reason: string | null;
  created_at: string;
  updated_at: string;
}

interface DatabaseIntentRow {
  id: string;
  campaign_id: string;
  wallet_id: string;
  address: string;
  value_wei: string;
  policy_snapshot_json: string | null;
  created_at: string;
  request_id: string | null;
  request_fingerprint: string | null;
  run_id: string | null;
}

interface DatabaseAttemptRow {
  id: string;
  transaction_intent_id: string;
  execution_id: string | null;
  endpoint: string;
  response_class: string;
  tx_hash: string | null;
  nonce: number | null;
  redacted_error: string | null;
  attempted_at: string;
  address: string;
  run_id: string | null;
}

interface DatabaseReceiptRow {
  id: string;
  transaction_attempt_id: string;
  execution_id: string | null;
  tx_hash: string;
  status: string;
  block_number: number | null;
  block_hash: string | null;
  confirmations: number;
  gas_used: string | null;
  effective_gas_price: string | null;
  finality_stage: string;
  finality_source: string | null;
  observed_at: string;
  run_id: string | null;
}

interface DatabaseReservationRow {
  id: string;
  wallet_id: string;
  execution_id: string | null;
  transaction_intent_id: string | null;
  idempotency_key: string;
  amount_wei: string;
  reserved_amount_wei: string;
  settled_amount_wei: string | null;
  usage_date: string;
  status: 'reserved' | 'settled' | 'released' | 'expired';
  created_at: string;
  settled_at: string | null;
  chain_id: number | null;
  campaign_id: string | null;
  run_id: string | null;
}

interface DatabaseReconciliationRow {
  id: string;
  chain_profile_id: string;
  transaction_attempt_id: string | null;
  execution_id: string | null;
  tx_hash: string | null;
  from_address: string | null;
  nonce: number | null;
  state: 'unresolved' | 'matched' | 'ambiguous' | 'reorged' | 'final';
  checked_at: string;
  details_json: string;
  run_id: string | null;
}

interface DatabaseEventRow {
  id: string;
  entity_type: string;
  entity_id: string;
  prior_state: string | null;
  new_state: string | null;
  actor: string;
  reason: string;
  policy_snapshot_json: string | null;
  occurred_at: string;
}

interface PolicySnapshot {
  campaignSnapshot?: Campaign;
  campaign?: Campaign;
  runId?: string;
  intentId?: string;
  simulationIds?: string[];
  evidenceAt?: string;
  eventType?: string;
  eventData?: Record<string, unknown>;
  runtime?: BackendState['runtime'];
}

const EMPTY_RUNTIME: BackendState['runtime'] = {
  startupState: 'Cold',
  blockingReasons: ['RECONCILIATION_REQUIRED'],
  dependencies: { engine: false, chain: false, backup: false, notifications: false },
};

const ROBINHOOD_CHAIN_ID = 4663;
const ETHEREUM_CHAIN_ID = 1;
export const PHASE1_ZERO_ADMISSION_BUFFERS = Object.freeze({
  replacementBudgetWei: 0n,
  mintValueBufferWei: 0n,
  l2ExecutionGasBufferWei: 0n,
  l1DataGasBufferWei: 0n,
  priorityFeeBufferWei: 0n,
});

function emptyState(): BackendState {
  return {
    schemaVersion: 1,
    campaigns: [],
    runs: [],
    intents: [],
    attempts: [],
    receipts: [],
    reconciliations: [],
    reservations: [],
    events: [],
    notificationOutbox: [],
    chainEvidence: [],
    simulations: [],
    readiness: [],
    jobs: [],
    runtime: structuredClone(EMPTY_RUNTIME),
    killed: false,
  };
}

function encode(value: unknown): string {
  const result = JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? `${item}n` : item);
  if (result === undefined) throw new Error('CANONICAL_JSON_ENCODING_FAILED');
  if (/(?:private[_-]?key|mnemonic|seed(?:[_-]?phrase)?|passphrase|password|api[_-]?key|access[_-]?token|secret[_-]?key|auth[_-]?token)\s*:/i.test(result)) throw new Error('SECRET_LIKE_STATE_REJECTED');
  return result;
}

function decode<T>(value: string | null | undefined): T | undefined {
  if (!value) return undefined;
  return JSON.parse(value, (_key, item) => typeof item === 'string' && /^-?\d+n$/.test(item) ? BigInt(item.slice(0, -1)) : item) as T;
}

function decodeRecord<T>(value: string | null | undefined): T | undefined {
  try { return decode<T>(value); } catch { return undefined; }
}

function asBigInt(value: unknown, fallback = 0n): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^-?\d+n?$/.test(value)) return BigInt(value.endsWith('n') ? value.slice(0, -1) : value);
  return fallback;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function canonicalId(prefix: string, value: string): string {
  return `${prefix}_${digest(value)}`;
}

function dbCampaignState(state: CampaignState): string {
  return state === 'Draft' ? 'draft' : state.toLowerCase();
}

function backendCampaignState(state: string): CampaignState {
  const normalized = state.toLowerCase();
  return normalized === 'draft' || normalized === 'prepared' ? 'Draft' : normalized.charAt(0).toUpperCase() + normalized.slice(1) as CampaignState;
}

function dbRunState(state: CampaignState): ExecutionRunRecord['state'] {
  if (state === 'Armed') return 'prepared';
  if (state === 'Active') return 'active';
  if (state === 'Aborted') return 'aborted';
  if (state === 'Cancelled') return 'cancelled';
  if (state === 'Failed') return 'failed';
  if (state === 'Completed') return 'completed';
  return 'prepared';
}

function backendRunState(state: string): CampaignState {
  if (state === 'prepared') return 'Armed';
  if (state === 'active' || state === 'recovering') return 'Active';
  if (state === 'completed') return 'Completed';
  if (state === 'failed') return 'Failed';
  if (state === 'aborted') return 'Aborted';
  if (state === 'cancelled') return 'Cancelled';
  return 'Armed';
}

function executionState(state: string): AttemptRecord['state'] {
  const normalized = state.toLowerCase();
  if (normalized === 'signed') return 'Signed';
  if (normalized === 'submitted' || normalized === 'included' || normalized === 'posted_to_ethereum') return 'Submitted';
  if (normalized === 'pending' || normalized === 'executing') return 'Pending';
  if (normalized === 'confirmed' || normalized === 'ethereum_final' || normalized === 'minted' || normalized === 'settled') return 'Confirmed';
  if (normalized === 'reorged') return 'Reorged';
  if (normalized === 'replaced') return 'Replaced';
  if (normalized === 'aborted' || normalized === 'killed' || normalized === 'skipped') return 'Aborted';
  if (normalized === 'failed' || normalized === 'dropped' || normalized === 'reverted') return 'Failed';
  return 'Prepared';
}

function receiptState(state: string): AttemptRecord['state'] {
  if (state === 'reorged') return 'Reorged';
  if (state === 'confirmed') return 'Confirmed';
  return 'Failed';
}

export function canonicalReceiptFinalityStage(chainId: 1 | 4663, state: string, robinhoodFinality?: AttemptRecord['robinhoodFinality']): DatabaseReceiptRecord['finalityStage'] {
  if (chainId === ROBINHOOD_CHAIN_ID) {
    if (robinhoodFinality === 'soft') return 'soft';
    if (robinhoodFinality === 'posted') return 'posted';
    if (robinhoodFinality === 'final') return 'ethereum_final';
    return 'unknown';
  }
  if (robinhoodFinality === 'soft') return 'soft';
  if (robinhoodFinality === 'posted') return 'posted';
  if (robinhoodFinality === 'final') return 'ethereum_final';
  if (state === 'Confirmed') return 'ethereum_final';
  return 'unknown';
}

function backendChainStatus(status: string): ChainVerification['status'] {
  if (status === 'characterization_pending') return 'characterizing';
  if (status === 'execution_blocked') return 'blocked';
  if (status === 'verified') return 'verified';
  return 'unverified';
}

function reconciliationResult(state: DatabaseReconciliationRow['state']): ReconciliationRecord['result'] {
  if (state === 'final') return 'final';
  if (state === 'matched') return 'confirmed';
  if (state === 'reorged') return 'reorged';
  return 'unknown';
}

function databaseReconciliationState(result: ReconciliationRecord['result']): DatabaseReconciliationRecord['state'] {
  if (result === 'final') return 'final';
  if (result === 'confirmed' || result === 'soft' || result === 'posted') return 'matched';
  if (result === 'reorged') return 'reorged';
  if (result === 'failed') return 'ambiguous';
  return 'unresolved';
}

function policySnapshot(campaign: Campaign, run?: RunRecord, intent?: IntentRecord): PolicySnapshot {
  return {
    campaignSnapshot: structuredClone(campaign),
    ...(run ? { runId: run.id } : {}),
    ...(intent ? { intentId: intent.id, simulationIds: [...intent.simulationIds], evidenceAt: intent.evidenceAt } : {}),
  };
}

function mapSpendPolicy(value: unknown): SpendPolicy {
  const item = value as Partial<SpendPolicy> | undefined;
  return {
    maxRunWei: asBigInt(item?.maxRunWei),
    dailyCapWei: asBigInt(item?.dailyCapWei),
    gasCeilingWei: asBigInt(item?.gasCeilingWei),
  };
}

function mapFeePolicy(value: unknown, mintPriceWei: bigint, paidMintsEnabled = false): FeePolicy {
  const item = value as Partial<FeePolicy> | undefined;
  const configuredPriorityFeeWei = asBigInt(item?.configuredPriorityFeeWei);
  const l2ExecutionGasBudgetWei = item?.l2ExecutionGasBudgetWei === undefined ? 0n : asBigInt(item.l2ExecutionGasBudgetWei);
  const l1DataGasBudgetWei = item?.l1DataGasBudgetWei === undefined ? 0n : asBigInt(item.l1DataGasBudgetWei);
  const totalFeeBudgetWei = item?.totalFeeBudgetWei === undefined ? configuredPriorityFeeWei + l2ExecutionGasBudgetWei + l1DataGasBudgetWei : asBigInt(item.totalFeeBudgetWei);
  return {
    kind: item?.kind === 'paid' || (paidMintsEnabled && mintPriceWei > 0n) ? 'paid' : 'free',
    configuredPriorityFeeWei,
    ...(item?.freeTotalSpendCapWei === undefined ? {} : { freeTotalSpendCapWei: asBigInt(item.freeTotalSpendCapWei) }),
    l2ExecutionGasBudgetWei,
    l1DataGasBudgetWei,
    totalFeeBudgetWei,
  };
}

function normalizeCampaignSnapshot(value: unknown): Campaign | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const source = value as Campaign;
  const mintPriceWei = asBigInt(source.mintPriceWei);
  const verification = source.chainVerification;
  return {
    ...source,
    mintPriceWei,
    spendPolicy: mapSpendPolicy(source.spendPolicy),
    feePolicy: mapFeePolicy(source.feePolicy, mintPriceWei),
    ...(verification ? { chainVerification: { ...verification, ...(verification.sourceBlock === undefined ? {} : { sourceBlock: asBigInt(verification.sourceBlock) }) } } : {}),
  };
}

function mapChainVerification(row: { chain_id: number; status: string; checked_at: string; evidence_json: string; sequencer_endpoint_reference: string | null; archive_endpoint_reference: string | null; feed_endpoint_reference: string | null } | undefined, fallback: ChainVerification | undefined, asOf = new Date()): ChainVerification {
  const chainId = (row?.chain_id ?? fallback?.chainId) as 1 | 4663;
  const evidence = decode<Record<string, unknown>>(row?.evidence_json);
  const expiresAt = typeof evidence?.expiresAt === 'string' ? Date.parse(evidence.expiresAt) : Number.NaN;
  const expired = row !== undefined && (!Number.isFinite(expiresAt) || expiresAt <= asOf.getTime());
  return {
    chainId,
    status: expired ? 'blocked' : row ? backendChainStatus(row.status) : 'unverified',
    seaDropCompatible: Boolean(evidence?.seaDropCompatible ?? fallback?.seaDropCompatible ?? false),
    ...(fallback?.evidenceId ? { evidenceId: fallback.evidenceId } : {}),
    ...(row?.checked_at || fallback?.checkedAt ? { checkedAt: row?.checked_at ?? fallback?.checkedAt } : {}),
    ...(evidence?.sourceBlock !== undefined || fallback?.sourceBlock !== undefined ? { sourceBlock: asBigInt(evidence?.sourceBlock ?? fallback?.sourceBlock) } : {}),
    endpointReference: fallback?.endpointReference ?? row?.feed_endpoint_reference ?? row?.sequencer_endpoint_reference ?? row?.archive_endpoint_reference ?? 'DATABASE_CHAIN_VERIFICATION',
  };
}

export class CanonicalStoreBridge implements CanonicalExecutionStore {
  private readonly databaseStore: SqliteBackendStore;
  private opened = false;
  private supportsReservationBoundaryFields = false;
  private supportsCampaignPeriods = false;
  private readonly durable: boolean;
  private readonly actor: string;
  private readonly now: () => Date;
  private readonly walletKeyReferencePrefix: string;

  public constructor(private readonly db: SqliteDatabase, options: { durable?: boolean; actor?: string; now?: () => Date; walletKeyReferencePrefix?: string } = {}) {
    this.databaseStore = new SqliteBackendStore(db);
    this.durable = options.durable ?? true;
    this.actor = options.actor ?? 'backend';
    this.now = options.now ?? (() => new Date());
    this.walletKeyReferencePrefix = options.walletKeyReferencePrefix ?? 'Rets/wallets/wallets.json';
  }

  public async open(): Promise<void> {
    const row = this.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null };
    if (row.version === null || row.version < 14) throw new Error('NORMALIZED_SCHEMA_VERSION_REQUIRED');
    const backendState = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'backend_state'").get() as { name: string } | undefined;
    if (backendState) throw new Error('JSON_BACKEND_STATE_MUST_NOT_BE_LIVE');
    const reservationColumns = new Set((this.db.prepare('PRAGMA table_info(spend_reservation)').all() as Array<{ name: string }>).map((column) => column.name));
    this.supportsReservationBoundaryFields = ['mint_class', 'fee_policy_id', 'fee_policy_version', 'fee_policy_snapshot_json'].every((column) => reservationColumns.has(column));
    this.supportsCampaignPeriods = Boolean(this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'campaign_period'").get());
    if (row.version >= 15 && (!this.supportsReservationBoundaryFields || !this.supportsCampaignPeriods)) throw new Error('NORMALIZED_SCHEMA_RESERVATION_CONTRACT_REQUIRED');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS orchestrator_job (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        run_id TEXT,
        campaign_id TEXT,
        state TEXT NOT NULL,
        scheduled_at TEXT NOT NULL,
        target_at TEXT,
        t_minus_ms INTEGER NOT NULL,
        chain_time_offset_ms INTEGER NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        request_digest TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL,
        last_error TEXT,
        next_attempt_at TEXT,
        lease_owner TEXT,
        lease_expires_at TEXT,
        started_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS orchestrator_readiness (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL,
        wallet TEXT NOT NULL,
        state TEXT NOT NULL,
        fresh_until TEXT NOT NULL,
        source_block TEXT,
        source_block_hash TEXT,
        observed_at TEXT,
        blocking_reasons_json TEXT NOT NULL,
        checks_json TEXT NOT NULL,
        check_states_json TEXT,
        provenance_json TEXT
      )
    `);
    this.opened = true;
  }

  public close(): void {
    this.db.close();
  }

  public capabilities(): StoreCapabilities {
    return { durable: this.durable, atomicAcrossProcesses: true };
  }

  public snapshot(): BackendState {
    this.ensureOpen();
    const state = emptyState();
    const campaigns = this.readCampaigns();
    state.campaigns = campaigns;
    const runs = this.readRuns();
    state.runs = runs;
    state.intents = this.readIntents(campaigns, runs);
    state.attempts = this.readAttempts(runs);
    state.receipts = this.readReceipts(runs);
    state.reconciliations = this.readReconciliations();
    state.reservations = this.readReservations();
    state.events = this.readEvents();
    state.notificationOutbox = this.readNotifications();
    state.chainEvidence = this.readChainEvidence();
    state.simulations = this.readSimulations();
    state.readiness = this.readReadiness();
    state.jobs = this.readJobs();
    state.runtime = this.readRuntime();
    state.killed = this.databaseStore.isKillSwitchEngaged();
    if (state.killed) state.runtime = { ...state.runtime, startupState: 'Blocked', blockingReasons: [...new Set([...state.runtime.blockingReasons, 'KILLED'])] };
    return state;
  }

  public async transaction<T>(mutate: (state: BackendState) => T): Promise<T> {
    this.ensureOpen();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.snapshot();
      const next = structuredClone(previous);
      const result = mutate(next);
      this.persistDelta(previous, next);
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.db.inTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  public async commit(): Promise<void> {
    this.ensureOpen();
  }

  public async settleExecutionComponents(id: string, components: SettlementComponents): Promise<void> {
    this.ensureOpen();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT status FROM spend_reservation WHERE id = ?').get(id) as { status: string } | undefined;
      if (!row) throw new Error('RESERVATION_NOT_FOUND');
      if (row.status === 'settled') {
        this.db.exec('COMMIT');
        return;
      }
      if (row.status !== 'reserved') throw new Error('INVALID_RESERVATION_TRANSITION');
      this.databaseStore.settleExecutionComponents(id, components, this.now());
      this.db.exec('COMMIT');
    } catch (error) {
      if (this.db.inTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  public async persistEngineRun(record: unknown): Promise<void> {
    this.ensureOpen();
    const input = record as { runId?: string; campaignId?: string; requestFingerprint?: string };
    if (!input.runId) throw new Error('RUN_ID_REQUIRED');
    const row = this.db.prepare('SELECT campaign_id, request_fingerprint, reason FROM execution_run WHERE id = ?').get(input.runId) as { campaign_id: string; request_fingerprint: string; reason: string | null } | undefined;
    if (!row) throw new Error('RUN_NOT_FOUND');
    if (input.campaignId && row.campaign_id !== input.campaignId) throw new Error('RUN_CAMPAIGN_MISMATCH');
    const runReason = decodeRecord<{ backendRequestDigest?: string }>(row.reason);
    const backendFingerprint = runReason?.backendRequestDigest ?? row.request_fingerprint;
    if (input.requestFingerprint && backendFingerprint !== input.requestFingerprint) throw new Error('IDEMPOTENCY_KEY_CONFLICT');
  }

  public async persistEngineIntent(record: unknown): Promise<void> {
    this.ensureOpen();
    const input = record as { id?: string; executionId?: string; intent?: { campaignId?: string; runId?: string; from?: string } };
    if (!input.id || !input.executionId) throw new Error('EXECUTION_IDENTITY_REQUIRED');
    const row = this.db.prepare('SELECT ti.campaign_id, ti.run_id, w.address, e.id AS execution_id FROM transaction_intent ti JOIN wallet w ON w.id = ti.wallet_id LEFT JOIN execution e ON e.transaction_intent_id = ti.id WHERE ti.id = ? ORDER BY e.created_at DESC LIMIT 1').get(input.id) as { campaign_id: string; run_id: string | null; address: string; execution_id: string | null } | undefined;
    if (!row || row.execution_id !== input.executionId) throw new Error('CANONICAL_INTENT_EXECUTION_MISMATCH');
    if (input.intent?.campaignId && input.intent.campaignId !== row.campaign_id) throw new Error('INTENT_CAMPAIGN_MISMATCH');
    if (input.intent?.runId && input.intent.runId !== row.run_id) throw new Error('INTENT_RUN_MISMATCH');
    if (input.intent?.from && input.intent.from.toLowerCase() !== row.address.toLowerCase()) throw new Error('INTENT_WALLET_MISMATCH');
  }

  public async persistEngineAttempt(record: unknown): Promise<void> {
    this.ensureOpen();
    const input = record as { id?: string; executionId?: string; transactionIntentId?: string; endpoint?: string; responseClass?: string; txHash?: string; nonce?: number; replacementOfId?: string; redactedError?: string; attemptedAt?: string };
    if (typeof input.id !== 'string' || typeof input.executionId !== 'string' || typeof input.transactionIntentId !== 'string' || typeof input.endpoint !== 'string' || typeof input.responseClass !== 'string' || typeof input.nonce !== 'number' || typeof input.attemptedAt !== 'string') throw new Error('LIFECYCLE_ATTEMPT_FACTS_REQUIRED');
    const id = input.id;
    const executionId = input.executionId;
    const transactionIntentId = input.transactionIntentId;
    const endpoint = input.endpoint;
    const responseClass = input.responseClass;
    const nonce = input.nonce;
    const attemptedAt = input.attemptedAt;
    const identity = this.executionIdentity(executionId);
    if (!identity || identity.transactionIntentId !== transactionIntentId) throw new Error('CANONICAL_ATTEMPT_IDENTITY_MISMATCH');
    const state = responseClass === 'signed' ? 'Signed' : ['timeout', 'ambiguous'].includes(responseClass) ? 'Pending' : ['rejected', 'provider_error'].includes(responseClass) ? 'Failed' : 'Submitted';
    await this.transaction((current) => {
      if (current.attempts.some((attempt) => attempt.id === id)) return;
      current.attempts.push({ id, executionId, runId: identity.runId, wallet: identity.wallet, nonce, endpoint, ...(input.txHash ? { hash: input.txHash } : {}), ...(input.redactedError ? { redactedError: input.redactedError } : {}), ...(input.replacementOfId ? { replacementOfId: input.replacementOfId } : {}), state, createdAt: attemptedAt, updatedAt: attemptedAt });
    });
  }

  public async persistEngineReceipt(record: unknown): Promise<void> {
    this.ensureOpen();
    const input = record as { id?: string; executionId?: string; transactionAttemptId?: string; txHash?: string; status?: string; blockNumber?: bigint; blockHash?: string; confirmations?: number; gasUsed?: bigint; effectiveGasPrice?: bigint; l1DataFeeWei?: bigint; finalityStage?: string; finalitySource?: string; observedAt?: string };
    if (typeof input.id !== 'string' || typeof input.executionId !== 'string' || typeof input.transactionAttemptId !== 'string' || typeof input.txHash !== 'string' || typeof input.status !== 'string' || typeof input.observedAt !== 'string') throw new Error('LIFECYCLE_RECEIPT_FACTS_REQUIRED');
    const id = input.id;
    const executionId = input.executionId;
    const transactionAttemptId = input.transactionAttemptId;
    const txHash = input.txHash;
    const status = input.status;
    const observedAt = input.observedAt;
    const identity = this.executionIdentity(executionId);
    if (!identity) throw new Error('EXECUTION_CHAIN_REQUIRED');
    if (input.blockNumber === undefined || !input.blockHash) {
      this.recordAudit({ id: `audit_${randomUUID()}`, entityType: 'execution', entityId: executionId, newState: 'pending', actor: this.actor, reason: 'pending receipt retained without terminal receipt facts', policySnapshot: { kind: 'event', eventType: 'pending_receipt', eventData: { executionId } }, occurredAt: observedAt });
      return;
    }
    const blockNumber = input.blockNumber;
    const blockHash = input.blockHash;
    const mappedStatus = status === 'reverted' ? 'Failed' : status === 'reorged' ? 'Reorged' : 'Confirmed';
    const lifecycleAttemptHash = this.attemptHash(transactionAttemptId, executionId);
    if (lifecycleAttemptHash.toLowerCase() !== txHash.toLowerCase()) throw new Error('RECEIPT_ATTEMPT_HASH_MISMATCH');
    const actualMintValueWei = ['reverted', 'reorged', 'dropped'].includes(status) ? 0n : identity.valueWei;
    const actualL2ExecutionGasWei = (input.gasUsed ?? 0n) * (input.effectiveGasPrice ?? 0n);
    const actualL1DataGasWei = input.l1DataFeeWei ?? 0n;
    const actualSpendWei = actualMintValueWei + actualL2ExecutionGasWei + actualL1DataGasWei;
    await this.transaction((current) => {
      if (current.receipts.some((receipt) => receipt.id === id)) return;
      current.receipts.push({ id, executionId, runId: identity.runId, transactionAttemptId, state: mappedStatus, ...(identity.chainId === ROBINHOOD_CHAIN_ID && input.finalityStage === 'soft' ? { robinhoodFinality: 'soft' } : {}), ...(identity.chainId === ROBINHOOD_CHAIN_ID && input.finalityStage === 'posted' ? { robinhoodFinality: 'posted' } : {}), ...(identity.chainId === ROBINHOOD_CHAIN_ID && input.finalityStage === 'ethereum_final' ? { robinhoodFinality: 'final' } : {}), blockNumber, blockHash, actualSpendWei, observedAt });
      this.recordAudit({ id: `audit_${randomUUID()}`, entityType: 'execution', entityId: executionId, actor: this.actor, reason: 'lifecycle receipt accounting components', newState: 'receipt_accounting', policySnapshot: { kind: 'receipt_accounting', receiptId: id, actualSpendWei: actualSpendWei.toString(), actualMintValueWei: actualMintValueWei.toString(), actualL2ExecutionGasWei: actualL2ExecutionGasWei.toString(), actualL1DataGasWei: actualL1DataGasWei.toString() }, occurredAt: observedAt });
    });
  }

  public async persistEngineReconciliation(record: unknown): Promise<void> {
    this.ensureOpen();
    const input = record as { id?: string; executionId?: string; transactionAttemptId?: string; txHash?: string; fromAddress?: string; nonce?: number; state?: string; source?: string; details?: Record<string, unknown>; checkedAt?: string };
    if (!input.id || !input.executionId || !input.fromAddress || input.nonce === undefined || !input.state || !input.source || !input.checkedAt) throw new Error('LIFECYCLE_RECONCILIATION_FACTS_REQUIRED');
    const identity = this.executionIdentity(input.executionId);
    if (!identity) throw new Error('EXECUTION_CHAIN_REQUIRED');
    if (this.db.prepare('SELECT id FROM reconciliation_record WHERE id = ?').get(input.id)) return;
    this.databaseStore.recordReconciliation({ id: input.id, chainProfileId: identity.chainProfileId, ...(input.transactionAttemptId ? { transactionAttemptId: input.transactionAttemptId } : {}), ...(input.txHash ? { txHash: input.txHash } : {}), fromAddress: input.fromAddress, nonce: input.nonce, state: input.state as DatabaseReconciliationRecord['state'], checkedAt: input.checkedAt, source: input.source, details: input.details ?? {}, executionId: input.executionId });
  }

  public async admitExecution(input: CanonicalAdmissionInput): Promise<CanonicalAdmissionResult> {
    this.ensureOpen();
    const wallets = [...input.wallets];
    if (wallets.length === 0) throw new Error('EMPTY_RESERVATION_BATCH');
    if (new Set(wallets.map((wallet) => wallet.toLowerCase())).size !== wallets.length) throw new Error('DUPLICATE_WALLET');
    if (input.campaign.chainId === ROBINHOOD_CHAIN_ID && input.campaign.feePolicy.kind === 'paid') throw new Error('ROBINHOOD_PAID_MINTS_DISABLED');
    const requestFingerprint = this.runFingerprint(input.run.id);
    if (input.run.requestDigest !== requestFingerprint) throw new Error('IDEMPOTENCY_KEY_CONFLICT');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('PRAGMA defer_foreign_keys = ON');
      if (this.databaseStore.isKillSwitchEngaged()) throw new Error('KILLED');
      this.assertCanonicalChainProfile(input.campaign);
      this.persistIntent(input.intent, undefined);
      const executionIds = new Map<string, PreparedExecution>();
      const reservations: Reservation[] = [];
      let totalRunExposure = this.runExposure(input.run.id);
      const amount = this.exposure(input.campaign);
      if (amount <= 0n) throw new Error('RESERVATION_EXPOSURE_MUST_BE_POSITIVE');
      for (const wallet of wallets) {
        const canonicalWallet = this.findWallet(input.campaign, wallet);
        const intentId = this.intentRowId(input.intent.id, wallet);
        const executionId = this.executionId(input.run.id, wallet);
        const reservationId = this.reservationId(input.run.id, wallet);
        const policyId = this.policyId(input.campaign.id, wallet);
        const existing = this.db.prepare('SELECT id, status, amount_wei, usage_date, created_at, settled_at, chain_profile_id, campaign_id, execution_id, transaction_intent_id, request_fingerprint FROM spend_reservation WHERE id = ?').get(reservationId) as { id: string; status: 'reserved' | 'settled' | 'released' | 'expired'; amount_wei: string; usage_date: string; created_at: string; settled_at: string | null; chain_profile_id: string | null; campaign_id: string | null; execution_id: string | null; transaction_intent_id: string | null; request_fingerprint: string | null } | undefined;
        if (existing?.status === 'released' || existing?.status === 'expired') throw new Error('RESERVATION_IDEMPOTENCY_REPLAY');
        if (existing && existing.request_fingerprint !== null && existing.request_fingerprint !== requestFingerprint) throw new Error('IDEMPOTENCY_KEY_CONFLICT');
        const usageDate = this.now().toISOString().slice(0, 10);
        if (!this.db.prepare('SELECT id FROM execution WHERE id = ?').get(executionId)) {
          this.databaseStore.saveExecution({ id: executionId, campaignId: input.campaign.id, walletId: canonicalWallet.walletId, transactionIntentId: intentId, state: 'prepared', runId: input.run.id, createdAt: this.now().toISOString(), updatedAt: this.now().toISOString() });
          this.recordLifecycle({ id: `transition_${randomUUID()}`, entityType: 'execution', entityId: executionId, newState: 'prepared', actor: this.actor, source: 'backend-admission', reason: 'pre-action execution persisted before reservation and engine side effect', policyVersion: 'phase1', occurredAt: this.now().toISOString() });
        }
        if (!existing) {
          this.assertCanonicalFeePolicy(input.campaign, input.campaign.feePolicy);
          this.assertCaps(canonicalWallet.walletId, input.campaign, usageDate, amount, totalRunExposure);
          const fee = input.campaign.feePolicy;
          const mintValueWei = input.campaign.mintPriceWei * BigInt(input.campaign.quantity);
          const l2ExecutionGasWei = fee.l2ExecutionGasBudgetWei ?? 0n;
          const l1DataGasWei = fee.l1DataGasBudgetWei ?? 0n;
          const priorityFeeComponentWei = fee.configuredPriorityFeeWei;
          const mintClass = mintValueWei === 0n ? 'free' : 'paid';
          const mintPeriodId = this.mintPeriodId(input.campaign.id);
          const activeFeePolicy = this.activeFeePolicy(canonicalWallet.chainProfileId);
          const reservationSnapshot = encode(this.reservationSnapshot(input, { mintClass, feePolicyId: activeFeePolicy.id, feePolicyVersion: activeFeePolicy.version, mintPeriodId }));
          if (this.supportsReservationBoundaryFields) {
            const feePolicySnapshot = encode({ id: activeFeePolicy.id, version: activeFeePolicy.version, priorityFeeSemantics: activeFeePolicy.priority_fee_semantics, maxTotalFeeWei: activeFeePolicy.max_total_fee_wei, freeMintTotalFeeCapWei: activeFeePolicy.free_mint_total_fee_cap_wei, freeMintPriorityFeeComponentWei: activeFeePolicy.free_mint_priority_fee_component_wei, freeMintPriorityFeeMultiplier: activeFeePolicy.free_mint_priority_fee_multiplier, paidMintsEnabled: activeFeePolicy.paid_mints_enabled, zeroPriorityFeePolicy: activeFeePolicy.zero_priority_fee_policy });
            const insertReservation = this.db.prepare('INSERT INTO spend_reservation (id, wallet_id, execution_id, idempotency_key, request_id, request_fingerprint, policy_id, amount_wei, reserved_amount_wei, usage_date, status, created_at, chain_profile_id, campaign_id, mint_value_wei, l2_execution_gas_wei, l1_data_gas_wei, priority_fee_component_wei, replacement_budget_wei, mint_value_buffer_wei, l2_execution_gas_buffer_wei, l1_data_gas_buffer_wei, priority_fee_buffer_wei, policy_snapshot_json, mint_period_id, transaction_intent_id, mint_class, fee_policy_id, fee_policy_version, fee_policy_snapshot_json) VALUES (@id, @walletId, @executionId, @idempotencyKey, @requestId, @requestFingerprint, @policyId, @amountWei, @reservedAmountWei, @usageDate, \'reserved\', @createdAt, @chainProfileId, @campaignId, @mintValueWei, @l2ExecutionGasWei, @l1DataGasWei, @priorityFeeComponentWei, @replacementBudgetWei, @mintValueBufferWei, @l2ExecutionGasBufferWei, @l1DataGasBufferWei, @priorityFeeBufferWei, @policySnapshotJson, @mintPeriodId, @transactionIntentId, @mintClass, @feePolicyId, @feePolicyVersion, @feePolicySnapshotJson)');
            insertReservation.run({ id: reservationId, walletId: canonicalWallet.walletId, executionId, idempotencyKey: `${input.run.id}:${wallet.toLowerCase()}`, requestId: input.run.id, requestFingerprint, policyId, amountWei: amount.toString(), reservedAmountWei: amount.toString(), usageDate, createdAt: this.now().toISOString(), chainProfileId: canonicalWallet.chainProfileId, campaignId: input.campaign.id, mintValueWei: mintValueWei.toString(), l2ExecutionGasWei: l2ExecutionGasWei.toString(), l1DataGasWei: l1DataGasWei.toString(), priorityFeeComponentWei: priorityFeeComponentWei.toString(), replacementBudgetWei: PHASE1_ZERO_ADMISSION_BUFFERS.replacementBudgetWei.toString(), mintValueBufferWei: PHASE1_ZERO_ADMISSION_BUFFERS.mintValueBufferWei.toString(), l2ExecutionGasBufferWei: PHASE1_ZERO_ADMISSION_BUFFERS.l2ExecutionGasBufferWei.toString(), l1DataGasBufferWei: PHASE1_ZERO_ADMISSION_BUFFERS.l1DataGasBufferWei.toString(), priorityFeeBufferWei: PHASE1_ZERO_ADMISSION_BUFFERS.priorityFeeBufferWei.toString(), policySnapshotJson: reservationSnapshot, mintPeriodId, transactionIntentId: intentId, mintClass, feePolicyId: activeFeePolicy.id, feePolicyVersion: activeFeePolicy.version, feePolicySnapshotJson: feePolicySnapshot });
          } else {
            const insertReservation = this.db.prepare('INSERT INTO spend_reservation (id, wallet_id, execution_id, idempotency_key, request_id, request_fingerprint, policy_id, amount_wei, reserved_amount_wei, usage_date, status, created_at, chain_profile_id, campaign_id, mint_value_wei, l2_execution_gas_wei, l1_data_gas_wei, priority_fee_component_wei, replacement_budget_wei, mint_value_buffer_wei, l2_execution_gas_buffer_wei, l1_data_gas_buffer_wei, priority_fee_buffer_wei, policy_snapshot_json, mint_period_id, transaction_intent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, \'reserved\', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
            insertReservation.run(reservationId, canonicalWallet.walletId, executionId, `${input.run.id}:${wallet.toLowerCase()}`, input.run.id, requestFingerprint, policyId, amount.toString(), amount.toString(), usageDate, this.now().toISOString(), canonicalWallet.chainProfileId, input.campaign.id, mintValueWei.toString(), l2ExecutionGasWei.toString(), l1DataGasWei.toString(), priorityFeeComponentWei.toString(), PHASE1_ZERO_ADMISSION_BUFFERS.replacementBudgetWei.toString(), PHASE1_ZERO_ADMISSION_BUFFERS.mintValueBufferWei.toString(), PHASE1_ZERO_ADMISSION_BUFFERS.l2ExecutionGasBufferWei.toString(), PHASE1_ZERO_ADMISSION_BUFFERS.l1DataGasBufferWei.toString(), reservationSnapshot, mintPeriodId, intentId);
          }
          totalRunExposure += amount;
         }
         const executionReservation = this.db.prepare('SELECT reservation_id FROM execution WHERE id = ?').get(executionId) as { reservation_id: string | null } | undefined;
         if (!executionReservation) throw new Error('EXECUTION_REQUIRED');
         if (executionReservation.reservation_id !== null && executionReservation.reservation_id !== reservationId) throw new Error('EXECUTION_RESERVATION_IDENTITY_MISMATCH');
         if (executionReservation.reservation_id === null) this.db.prepare('UPDATE execution SET reservation_id = ? WHERE id = ?').run(reservationId, executionId);
        const persistedReservation = this.db.prepare('SELECT id, wallet_id, execution_id, transaction_intent_id, amount_wei, reserved_amount_wei, settled_amount_wei, usage_date, status, created_at, settled_at, chain_profile_id, campaign_id, (SELECT run_id FROM execution WHERE id = spend_reservation.execution_id) AS run_id, (SELECT chain_id FROM chain_profile WHERE id = spend_reservation.chain_profile_id) AS chain_id FROM spend_reservation WHERE id = ?').get(reservationId) as DatabaseReservationRow;
        reservations.push(this.mapReservation(persistedReservation, input.run.id, input.campaign.chainId));
        executionIds.set(wallet.toLowerCase(), { wallet, intentId, executionId });
      }
      this.updateRunState(input.run.id, 'active', input.run);
      this.recordAudit({ id: `audit_${randomUUID()}`, entityType: 'execution_run', entityId: input.run.id, newState: 'active', actor: this.actor, reason: 'canonical admission persisted before engine side effect', policySnapshot: { kind: 'event', eventType: 'admission', eventData: { reservationCount: wallets.length } }, occurredAt: this.now().toISOString() });
      this.db.exec('COMMIT');
      return { reservations, executions: [...executionIds.values()] };
    } catch (error) {
      if (this.db.inTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  public async abortRemaining(reason: string): Promise<void> {
    this.ensureOpen();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const rows = this.db.prepare(`SELECT e.id, e.state, e.run_id, e.campaign_id, e.wallet_id, EXISTS (SELECT 1 FROM transaction_attempt a WHERE a.execution_id = e.id AND a.tx_hash IS NOT NULL) AS submitted FROM execution e WHERE e.state IN ('prepared', 'signed', 'submitted', 'pending', 'executing', 'active')`).all() as Array<{ id: string; state: string; run_id: string | null; campaign_id: string; wallet_id: string; submitted: number }>;
      for (const row of rows) {
        if (row.submitted === 1) continue;
        if (row.state !== 'aborted') {
          this.transitionExecution(row.id, 'aborted', 'kill switch', reason);
        }
        this.db.prepare("UPDATE spend_reservation SET status = 'released' WHERE execution_id = ? AND status = 'reserved'").run(row.id);
      }
      this.db.prepare("UPDATE execution_run SET state = 'aborted', updated_at = ? WHERE state IN ('prepared', 'active', 'recovering')").run(this.now().toISOString());
      this.recordAudit({ id: `audit_${randomUUID()}`, entityType: 'state_transition', entityId: 'global', newState: 'aborted', actor: this.actor, reason, policySnapshot: { kind: 'event', eventType: 'kill', eventData: { reason } }, occurredAt: this.now().toISOString() });
      this.db.exec('COMMIT');
    } catch (error) {
      if (this.db.inTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private ensureOpen(): void {
    if (!this.opened) throw new Error('CANONICAL_STORE_NOT_OPEN');
  }

  private readCampaigns(): Campaign[] {
    const rows = this.db.prepare(`SELECT c.id, c.state, c.policy_snapshot_json, c.created_at, d.strategy, d.mint_price_wei, ct.address, cp.id AS chain_profile_id, cp.chain_id, (SELECT cv.status FROM chain_verification cv WHERE cv.chain_profile_id = cp.id ORDER BY cv.checked_at DESC, cv.id DESC LIMIT 1) AS verification_status, (SELECT cv.checked_at FROM chain_verification cv WHERE cv.chain_profile_id = cp.id ORDER BY cv.checked_at DESC, cv.id DESC LIMIT 1) AS verification_checked_at, (SELECT cv.evidence_json FROM chain_verification cv WHERE cv.chain_profile_id = cp.id ORDER BY cv.checked_at DESC, cv.id DESC LIMIT 1) AS verification_evidence_json, (SELECT cv.sequencer_endpoint_reference FROM chain_verification cv WHERE cv.chain_profile_id = cp.id ORDER BY cv.checked_at DESC, cv.id DESC LIMIT 1) AS sequencer_endpoint_reference, (SELECT cv.archive_endpoint_reference FROM chain_verification cv WHERE cv.chain_profile_id = cp.id ORDER BY cv.checked_at DESC, cv.id DESC LIMIT 1) AS archive_endpoint_reference, (SELECT cv.feed_endpoint_reference FROM chain_verification cv WHERE cv.chain_profile_id = cp.id ORDER BY cv.checked_at DESC, cv.id DESC LIMIT 1) AS feed_endpoint_reference FROM campaign c JOIN "drop" d ON d.id = c.drop_id JOIN collection col ON col.id = d.collection_id JOIN contract ct ON ct.id = col.contract_id JOIN chain_profile cp ON cp.id = ct.chain_profile_id ORDER BY c.created_at, c.id`).all() as Array<{ id: string; state: string; policy_snapshot_json: string | null; created_at: string; strategy: string; mint_price_wei: string; address: string; chain_profile_id: string; chain_id: number; verification_status: string | null; verification_checked_at: string | null; verification_evidence_json: string | null; sequencer_endpoint_reference: string | null; archive_endpoint_reference: string | null; feed_endpoint_reference: string | null }>;
    return rows.map((row) => {
      const snapshot = decode<PolicySnapshot>(row.policy_snapshot_json);
      const source = snapshot?.campaignSnapshot ?? snapshot?.campaign;
      const mintPriceWei = BigInt(row.mint_price_wei);
      const verification = mapChainVerification(row.verification_status ? { chain_id: row.chain_id, status: row.verification_status, checked_at: row.verification_checked_at ?? row.created_at, evidence_json: row.verification_evidence_json ?? '{}', sequencer_endpoint_reference: row.sequencer_endpoint_reference, archive_endpoint_reference: row.archive_endpoint_reference, feed_endpoint_reference: row.feed_endpoint_reference } : undefined, source?.chainVerification, this.now());
      const updated = this.db.prepare("SELECT MAX(occurred_at) AS at FROM state_transition WHERE entity_type = 'campaign' AND entity_id = ?").get(row.id) as { at: string | null };
      return { id: row.id, state: backendCampaignState(row.state), chainId: row.chain_id as 1 | 4663, contract: row.address, strategy: row.strategy, quantity: source?.quantity ?? 1, dryRun: source?.dryRun ?? true, spendPolicy: mapSpendPolicy(source?.spendPolicy), createdAt: row.created_at, updatedAt: updated.at ?? row.created_at, ...(source?.broadcastMode ? { broadcastMode: source.broadcastMode } : {}), ...(source?.openingAt ? { openingAt: source.openingAt } : {}), ...(source?.tMinusMs === undefined ? {} : { tMinusMs: source.tMinusMs }), chainVerification: verification, mintPriceWei, feePolicy: this.readFeePolicy(row.chain_profile_id, mintPriceWei, source?.feePolicy) };
    });
  }

  private readFeePolicy(chainProfileId: string, mintPriceWei: bigint, fallback: unknown): FeePolicy {
    const row = this.db.prepare('SELECT max_total_fee_wei, free_mint_total_fee_cap_wei, free_mint_priority_fee_component_wei, paid_mints_enabled, zero_priority_fee_policy FROM fee_policy WHERE chain_profile_id = ? AND active = 1 ORDER BY rowid DESC LIMIT 1').get(chainProfileId) as { max_total_fee_wei: string; free_mint_total_fee_cap_wei: string; free_mint_priority_fee_component_wei: string; paid_mints_enabled: number; zero_priority_fee_policy: string } | undefined;
    if (!row) return mapFeePolicy(fallback, mintPriceWei);
    const source = mapFeePolicy(fallback, mintPriceWei, row.paid_mints_enabled === 1);
    const configuredPriorityFeeWei = BigInt(row.free_mint_priority_fee_component_wei);
    const feeBudget = (source.l2ExecutionGasBudgetWei ?? 0n) + (source.l1DataGasBudgetWei ?? 0n) + configuredPriorityFeeWei;
    const sourceTotalFeeBudgetWei = source.totalFeeBudgetWei ?? 0n;
    const snapshotKind = (fallback as Partial<FeePolicy> | undefined)?.kind;
    const kind = snapshotKind ?? (row.paid_mints_enabled === 1 && mintPriceWei > 0n ? 'paid' : 'free');
    return { ...source, kind, configuredPriorityFeeWei, freeTotalSpendCapWei: BigInt(row.free_mint_total_fee_cap_wei), totalFeeBudgetWei: sourceTotalFeeBudgetWei === 0n ? BigInt(row.max_total_fee_wei) : sourceTotalFeeBudgetWei > feeBudget ? sourceTotalFeeBudgetWei : feeBudget };
  }

  private readRuns(): RunRecord[] {
    const rows = this.db.prepare('SELECT id, request_id, request_fingerprint, campaign_id, state, reason, created_at, updated_at FROM execution_run ORDER BY created_at, id').all() as DatabaseRunRow[];
    return rows.flatMap((row) => {
      if (!row.campaign_id) return [];
      const reason = decodeRecord<{ intentId?: string; idempotencyKey?: string; mode?: RunRecord['mode']; backendRequestDigest?: string }>(row.reason);
      return [{ id: row.id, intentId: reason?.intentId ?? canonicalId('intent', row.id), campaignId: row.campaign_id, mode: reason?.mode === 'live' ? 'live' : 'dry-run', requestDigest: reason?.backendRequestDigest ?? row.request_fingerprint, state: backendRunState(row.state), ...(reason?.idempotencyKey ? { idempotencyKey: reason.idempotencyKey } : row.request_id.startsWith('run:') ? {} : { idempotencyKey: row.request_id }), createdAt: row.created_at, updatedAt: row.updated_at }];
    });
  }

  private readIntents(campaigns: readonly Campaign[], runs: readonly RunRecord[]): IntentRecord[] {
    const rows = this.db.prepare(`SELECT ti.id, ti.campaign_id, ti.wallet_id, w.address, ti.value_wei, ti.policy_snapshot_json, ti.created_at, ti.request_id, ti.request_fingerprint, ti.run_id FROM transaction_intent ti JOIN wallet w ON w.id = ti.wallet_id ORDER BY ti.created_at, ti.id`).all() as DatabaseIntentRow[];
    const campaignsById = new Map(campaigns.map((campaign) => [campaign.id, campaign]));
    const runsById = new Map(runs.map((run) => [run.id, run]));
    const grouped = new Map<string, IntentRecord>();
    for (const row of rows) {
      const snapshot = decode<PolicySnapshot>(row.policy_snapshot_json);
      const intentId = row.request_id ?? snapshot?.intentId ?? row.id.split(':wallet:')[0] ?? row.id;
      const snapshotCampaign = normalizeCampaignSnapshot(snapshot?.campaignSnapshot ?? snapshot?.campaign);
      const canonicalCampaign = campaignsById.get(row.campaign_id);
      const campaign = snapshotCampaign && canonicalCampaign ? { ...snapshotCampaign, chainVerification: structuredClone(canonicalCampaign.chainVerification) } : snapshotCampaign ?? canonicalCampaign;
      const runId = row.run_id ?? snapshot?.runId ?? runs.find((run) => run.intentId === intentId)?.id ?? '';
      const run = runsById.get(runId);
      if (!campaign || !run) continue;
      const current = grouped.get(intentId);
      if (current) { current.wallets = [...current.wallets, row.address]; continue; }
      grouped.set(intentId, { id: intentId, runId, campaignId: row.campaign_id, campaignSnapshot: structuredClone(campaign), wallets: [row.address], policy: structuredClone(campaign.spendPolicy), feePolicy: structuredClone(campaign.feePolicy), chainVerification: structuredClone(campaign.chainVerification), simulationIds: snapshot?.simulationIds ?? [], evidenceAt: snapshot?.evidenceAt ?? row.created_at, createdAt: row.created_at });
    }
    return [...grouped.values()];
  }

  private readAttempts(runs: readonly RunRecord[]): AttemptRecord[] {
    const rows = this.db.prepare(`SELECT a.id, a.transaction_intent_id, a.execution_id, a.endpoint, a.response_class, a.tx_hash, a.nonce, a.redacted_error, a.attempted_at, w.address, e.run_id FROM transaction_attempt a JOIN transaction_intent ti ON ti.id = a.transaction_intent_id JOIN wallet w ON w.id = ti.wallet_id LEFT JOIN execution e ON e.id = a.execution_id ORDER BY a.attempted_at, a.id`).all() as DatabaseAttemptRow[];
    const runIds = new Set(runs.map((run) => run.id));
    return rows.flatMap((row) => {
      const runId = row.run_id ?? '';
      if (!runIds.has(runId) || !row.execution_id) return [];
      const state = executionState(row.response_class);
      return [{ id: row.id, executionId: row.execution_id, runId, wallet: row.address, ...(row.nonce === null ? {} : { nonce: row.nonce }), ...(row.tx_hash === null ? {} : { hash: row.tx_hash }), endpoint: row.endpoint, ...(row.redacted_error === null ? {} : { redactedError: row.redacted_error }), state, createdAt: row.attempted_at, updatedAt: row.attempted_at } satisfies AttemptRecord];
    });
  }

  private readReceipts(runs: readonly RunRecord[]): ReceiptRecord[] {
    const rows = this.db.prepare(`SELECT r.id, r.transaction_attempt_id, r.execution_id, r.tx_hash, r.status, r.block_number, r.block_hash, r.confirmations, r.gas_used, r.effective_gas_price, r.finality_stage, r.finality_source, r.observed_at, e.run_id FROM transaction_receipt r JOIN transaction_attempt a ON a.id = r.transaction_attempt_id LEFT JOIN execution e ON e.id = r.execution_id ORDER BY r.observed_at, r.id`).all() as DatabaseReceiptRow[];
    const runIds = new Set(runs.map((run) => run.id));
    return rows.flatMap((row) => {
      if (!row.execution_id || !row.run_id || !runIds.has(row.run_id)) return [];
      const state = receiptState(row.status);
      const attempt = this.db.prepare('SELECT finality_stage FROM transaction_receipt WHERE id = ?').get(row.id) as { finality_stage: string };
      const finality = attempt.finality_stage === 'soft' ? 'soft' : attempt.finality_stage === 'posted' ? 'posted' : attempt.finality_stage === 'ethereum_final' && row.run_id && this.runChain(row.run_id, runs) === ROBINHOOD_CHAIN_ID ? 'final' : undefined;
      const ledgerRows = this.db.prepare("SELECT amount_wei FROM spend_ledger_entry WHERE execution_id = ? AND component <> 'refund'").all(row.execution_id) as Array<{ amount_wei: string }>;
      const settled = this.db.prepare("SELECT settled_amount_wei FROM spend_reservation WHERE execution_id = ? AND status = 'settled' ORDER BY settled_at DESC LIMIT 1").get(row.execution_id) as { settled_amount_wei: string | null } | undefined;
      const accountingRows = this.db.prepare("SELECT policy_snapshot_json FROM audit_event WHERE entity_type = 'execution' AND policy_snapshot_json IS NOT NULL ORDER BY occurred_at DESC, id DESC").all() as Array<{ policy_snapshot_json: string }>;
      const lifecycleAccounting = accountingRows.map((item) => decode<{ kind?: string; receiptId?: string; actualSpendWei?: string }>(item.policy_snapshot_json)).find((item) => item?.kind === 'receipt_accounting' && item.receiptId === row.id);
      const ledgerAmount = ledgerRows.reduce((total, item) => total + BigInt(item.amount_wei), 0n);
      const actualSpendWei = settled?.settled_amount_wei === null || settled?.settled_amount_wei === undefined ? ledgerRows.length > 0 ? ledgerAmount : lifecycleAccounting?.actualSpendWei === undefined ? undefined : BigInt(lifecycleAccounting.actualSpendWei) : BigInt(settled.settled_amount_wei);
      return [{ id: row.id, executionId: row.execution_id, runId: row.run_id, transactionAttemptId: row.transaction_attempt_id, state, ...(finality ? { robinhoodFinality: finality } : {}), ...(row.block_number === null ? {} : { blockNumber: BigInt(row.block_number) }), ...(row.block_hash === null ? {} : { blockHash: row.block_hash }), ...(row.gas_used === null ? {} : { gasUsed: BigInt(row.gas_used) }), ...(row.effective_gas_price === null ? {} : { effectiveGasPrice: BigInt(row.effective_gas_price) }), ...(actualSpendWei === undefined ? {} : { actualSpendWei }), observedAt: row.observed_at } satisfies ReceiptRecord];
    });
  }

  private readReconciliations(): ReconciliationRecord[] {
    const rows = this.db.prepare(`SELECT rr.id, rr.chain_profile_id, rr.transaction_attempt_id, rr.execution_id, rr.tx_hash, rr.from_address, rr.nonce, rr.state, rr.checked_at, rr.details_json, e.run_id FROM reconciliation_record rr LEFT JOIN execution e ON e.id = rr.execution_id ORDER BY rr.checked_at, rr.id`).all() as DatabaseReconciliationRow[];
    return rows.flatMap((row) => !row.run_id ? [] : [{ id: row.id, runId: row.run_id, ...(row.execution_id ? { attemptId: this.attemptIdForExecution(row.execution_id) } : {}), result: reconciliationResult(row.state), observedAt: row.checked_at, ...(decode<{ reason?: string }>(row.details_json)?.reason ? { reason: decode<{ reason: string }>(row.details_json)!.reason } : {}) } satisfies ReconciliationRecord]);
  }

  private readReservations(): Reservation[] {
    const rows = this.db.prepare(`SELECT r.id, r.wallet_id, r.execution_id, r.transaction_intent_id, r.idempotency_key, r.amount_wei, r.reserved_amount_wei, r.settled_amount_wei, r.usage_date, r.status, r.created_at, r.settled_at, cp.chain_id, r.campaign_id, e.run_id FROM spend_reservation r LEFT JOIN chain_profile cp ON cp.id = r.chain_profile_id LEFT JOIN execution e ON e.id = r.execution_id ORDER BY r.created_at, r.id`).all() as DatabaseReservationRow[];
    return rows.map((row) => this.mapReservation(row, row.run_id ?? '', row.chain_id as 1 | 4663 | null));
  }

  private mapReservation(row: DatabaseReservationRow, runId: string, chainId: 1 | 4663 | null): Reservation {
    const status = row.status === 'expired' ? 'released' : row.status;
    return { id: row.id, runId, campaignId: row.campaign_id ?? '', ...(chainId === null ? {} : { chainId }), wallet: this.walletAddress(row.wallet_id), amountWei: BigInt(row.reserved_amount_wei || row.amount_wei), ...(row.settled_amount_wei === null ? {} : { actualAmountWei: BigInt(row.settled_amount_wei) }), accountingDate: row.usage_date, status, createdAt: row.created_at, updatedAt: row.settled_at ?? row.created_at };
  }

  private readEvents(): EventRecord[] {
    const rows = this.db.prepare("SELECT id, entity_type, entity_id, prior_state, new_state, actor, reason, policy_snapshot_json, occurred_at FROM audit_event ORDER BY occurred_at, id").all() as DatabaseEventRow[];
    return rows.flatMap((row) => {
      const snapshot = decode<{ kind?: string; eventType?: string; eventData?: Record<string, unknown>; runId?: string }>(row.policy_snapshot_json);
      if (snapshot?.kind !== 'event' && row.entity_type !== 'execution_run') return [];
      return [{ id: row.id, ...(snapshot?.runId || row.entity_type === 'execution_run' ? { runId: snapshot?.runId ?? row.entity_id } : {}), type: snapshot?.eventType ?? row.new_state ?? row.reason, at: row.occurred_at, data: snapshot?.eventData ?? {} } satisfies EventRecord];
    });
  }

  private readNotifications(): BackendState['notificationOutbox'] {
    const rows = this.db.prepare('SELECT id, event_key, idempotency_key, delivery_state, payload_json, created_at, delivered_at FROM notification ORDER BY created_at, id').all() as Array<{ id: string; event_key: string; idempotency_key: string; delivery_state: string; payload_json: string; created_at: string; delivered_at: string | null }>;
    return rows.map((row) => {
      const payload = decode<{ runId?: string; type?: string; text?: string; attempts?: number; sourceEventId?: string; canonicalLink?: string; lastError?: string }>(row.payload_json) ?? {};
      return { id: row.id, sourceEventId: payload.sourceEventId ?? row.event_key, ...(payload.runId ? { runId: payload.runId } : {}), type: payload.type ?? row.event_key, text: payload.text ?? '', state: row.delivery_state === 'delivered' || row.delivery_state === 'sent' ? 'delivered' : row.delivery_state === 'failed' || payload.lastError ? 'failed' : 'pending', attempts: payload.attempts ?? 0, createdAt: row.created_at, ...(row.delivered_at ? { deliveredAt: row.delivered_at } : {}), ...(payload.lastError ? { lastError: payload.lastError } : {}), ...(payload.canonicalLink ? { canonicalLink: payload.canonicalLink } : {}) };
    });
  }

  private readChainEvidence(): ChainEvidenceRecord[] {
    const rows = this.db.prepare('SELECT cv.id, cp.chain_id, cv.status, cp.execution_enabled, cv.evidence_json, cv.checked_at, cv.sequencer_endpoint_reference, cv.archive_endpoint_reference, cv.feed_endpoint_reference FROM chain_verification cv JOIN chain_profile cp ON cp.id = cv.chain_profile_id ORDER BY cv.checked_at, cv.id').all() as Array<{ id: string; chain_id: number; status: string; execution_enabled: number; evidence_json: string; checked_at: string; sequencer_endpoint_reference: string | null; archive_endpoint_reference: string | null; feed_endpoint_reference: string | null }>;
    return rows.map((row) => {
      const evidence = decode<Record<string, unknown>>(row.evidence_json) ?? {};
      const checkedAt = row.checked_at;
      return { id: String(evidence.backendEvidenceId ?? row.id), chainId: row.chain_id as 1 | 4663, status: row.status === 'verified' ? 'accepted' : row.status === 'execution_blocked' ? 'rejected' : 'pending', executionEnabled: row.execution_enabled === 1, seaDropCompatible: Boolean(evidence.seaDropCompatible), positiveLivePath: Boolean(evidence.positiveLivePath), archiveForkPassed: Boolean(evidence.archiveForkPassed), negativeCases: (evidence.negativeCases ?? {}) as ChainEvidenceRecord['negativeCases'], reconciliationPassed: Boolean(evidence.reconciliationPassed), finalityPassed: Boolean(evidence.finalityPassed), endpointIdentity: String(evidence.endpointIdentity ?? row.feed_endpoint_reference ?? row.sequencer_endpoint_reference ?? ''), ...(evidence.archiveEndpointIdentity ? { archiveEndpointIdentity: String(evidence.archiveEndpointIdentity) } : {}), strategyVersion: String(evidence.strategyVersion ?? 'database'), checkedAt, expiresAt: String(evidence.expiresAt ?? checkedAt), sourceBlock: asBigInt(evidence.sourceBlock), sourceBlockHash: String(evidence.sourceBlockHash ?? ''), ...(evidence.acceptedAt ? { acceptedAt: String(evidence.acceptedAt) } : {}), ...(evidence.acceptedBy ? { acceptedBy: String(evidence.acceptedBy) } : {}), ...(evidence.approvalProof ? { approvalProof: String(evidence.approvalProof) } : {}) };
    });
  }

  private readSimulations(): SimulationEvidenceRecord[] {
    const rows = this.db.prepare('SELECT s.id, s.campaign_id, w.address, s.source_block_number, s.source_block_hash, s.checked_at, s.freshness_seconds, s.outcome, s.details_json FROM simulation s JOIN wallet w ON w.id = s.wallet_id ORDER BY s.checked_at, s.id').all() as Array<{ id: string; campaign_id: string; address: string; source_block_number: number; source_block_hash: string | null; checked_at: string; freshness_seconds: number; outcome: 'pass' | 'fail' | 'unknown'; details_json: string }>;
    return rows.map((row) => { const details = decode<Record<string, unknown>>(row.details_json) ?? {}; return { id: row.id, campaignId: row.campaign_id, wallet: row.address, inputDigest: String(details.inputDigest ?? ''), success: row.outcome === 'pass', sourceBlock: BigInt(row.source_block_number), sourceBlockHash: row.source_block_hash ?? '', checkedAt: row.checked_at, expiresAt: new Date(Date.parse(row.checked_at) + row.freshness_seconds * 1000).toISOString(), ...(details.gasEstimate === undefined ? {} : { gasEstimate: asBigInt(details.gasEstimate) }), worstCaseFeeWei: asBigInt(details.worstCaseFeeWei) }; });
  }

  private readRuntime(): BackendState['runtime'] {
    const row = this.db.prepare('SELECT policy_snapshot_json FROM runtime_readiness_snapshot ORDER BY rowid DESC LIMIT 1').get() as { policy_snapshot_json: string } | undefined;
    const snapshot = decode<PolicySnapshot>(row?.policy_snapshot_json);
    const runtime = snapshot?.runtime ? { ...structuredClone(EMPTY_RUNTIME), ...snapshot.runtime, dependencies: { ...EMPTY_RUNTIME.dependencies, ...snapshot.runtime.dependencies } } : structuredClone(EMPTY_RUNTIME);
    const orphaned = this.db.prepare("SELECT COUNT(*) AS count FROM execution_run WHERE campaign_id IS NULL").get() as { count: number };
    return orphaned.count === 0 ? runtime : { ...runtime, startupState: 'Blocked', blockingReasons: [...new Set([...runtime.blockingReasons, 'ORPHANED_EXECUTION_RUN'])] };
  }

  private readJobs(): BackendState['jobs'] {
    const rows = this.db.prepare('SELECT id, kind, run_id, campaign_id, state, scheduled_at, target_at, t_minus_ms, chain_time_offset_ms, idempotency_key, request_digest, payload_json, attempts, max_attempts, last_error, next_attempt_at, lease_owner, lease_expires_at, started_at, completed_at, created_at, updated_at FROM orchestrator_job ORDER BY scheduled_at, id').all() as Array<{ id: string; kind: BackendState['jobs'][number]['kind']; run_id: string | null; campaign_id: string | null; state: BackendState['jobs'][number]['state']; scheduled_at: string; target_at: string | null; t_minus_ms: number; chain_time_offset_ms: number; idempotency_key: string; request_digest: string; payload_json: string; attempts: number; max_attempts: number; last_error: string | null; next_attempt_at: string | null; lease_owner: string | null; lease_expires_at: string | null; started_at: string | null; completed_at: string | null; created_at: string; updated_at: string }>;
    return rows.map((row) => ({ id: row.id, kind: row.kind, ...(row.run_id ? { runId: row.run_id } : {}), ...(row.campaign_id ? { campaignId: row.campaign_id } : {}), state: row.state, scheduledAt: row.scheduled_at, ...(row.target_at ? { targetAt: row.target_at } : {}), tMinusMs: row.t_minus_ms, chainTimeOffsetMs: row.chain_time_offset_ms, idempotencyKey: row.idempotency_key, requestDigest: row.request_digest, payload: decode<Record<string, unknown>>(row.payload_json) ?? {}, attempts: row.attempts, maxAttempts: row.max_attempts, ...(row.last_error ? { lastError: row.last_error } : {}), ...(row.next_attempt_at ? { nextAttemptAt: row.next_attempt_at } : {}), ...(row.lease_owner ? { leaseOwner: row.lease_owner } : {}), ...(row.lease_expires_at ? { leaseExpiresAt: row.lease_expires_at } : {}), ...(row.started_at ? { startedAt: row.started_at } : {}), ...(row.completed_at ? { completedAt: row.completed_at } : {}), createdAt: row.created_at, updatedAt: row.updated_at }));
  }

  private readReadiness(): BackendState['readiness'] {
    const rows = this.db.prepare('SELECT id, campaign_id, wallet, state, fresh_until, source_block, source_block_hash, observed_at, blocking_reasons_json, checks_json, check_states_json, provenance_json FROM orchestrator_readiness ORDER BY campaign_id, wallet, id').all() as Array<{ id: string; campaign_id: string; wallet: string; state: BackendState['readiness'][number]['state']; fresh_until: string; source_block: string | null; source_block_hash: string | null; observed_at: string | null; blocking_reasons_json: string; checks_json: string; check_states_json: string | null; provenance_json: string | null }>;
    return rows.map((row) => ({ wallet: row.wallet, campaignId: row.campaign_id, state: row.state, freshUntil: row.fresh_until, ...(row.source_block === null ? {} : { sourceBlock: BigInt(row.source_block) }), ...(row.source_block_hash ? { sourceBlockHash: row.source_block_hash } : {}), ...(row.observed_at ? { observedAt: row.observed_at } : {}), blockingReasons: decode<string[]>(row.blocking_reasons_json) ?? [], checks: decode<Record<string, boolean>>(row.checks_json) ?? {}, ...(row.check_states_json ? { checkStates: decode<BackendState['readiness'][number]['checkStates']>(row.check_states_json) } : {}), ...(row.provenance_json ? { provenance: decode<BackendState['readiness'][number]['provenance']>(row.provenance_json) } : {}) }));
  }

  private persistDelta(previous: BackendState, next: BackendState): void {
    for (const campaign of next.campaigns) this.persistCampaign(campaign, previous.campaigns.find((item) => item.id === campaign.id));
    for (const run of next.runs) this.persistRun(run, previous.runs.find((item) => item.id === run.id));
    for (const intent of next.intents) this.persistIntent(intent, previous.intents.find((item) => item.id === intent.id));
    for (const reservation of next.reservations) this.persistReservation(reservation, previous.reservations.find((item) => item.id === reservation.id));
    for (const attempt of next.attempts) this.persistAttempt(attempt, previous.attempts.find((item) => item.id === attempt.id));
    for (const receipt of next.receipts) this.persistReceipt(receipt, previous.receipts.find((item) => item.id === receipt.id));
    for (const reconciliation of next.reconciliations) this.persistReconciliation(reconciliation, previous.reconciliations.find((item) => item.id === reconciliation.id));
    for (const event of next.events) this.persistEvent(event, previous.events.find((item) => item.id === event.id));
    for (const notification of next.notificationOutbox) this.persistNotification(notification, previous.notificationOutbox.find((item) => item.id === notification.id));
    for (const evidence of next.chainEvidence) this.persistChainEvidence(evidence, previous.chainEvidence.find((item) => item.id === evidence.id));
    for (const simulation of next.simulations) this.persistSimulation(simulation, previous.simulations.find((item) => item.id === simulation.id));
    for (const readiness of next.readiness) this.persistReadiness(readiness, previous.readiness.find((item) => item.campaignId === readiness.campaignId && item.wallet.toLowerCase() === readiness.wallet.toLowerCase()));
    for (const job of next.jobs) this.persistJob(job, previous.jobs.find((item) => item.id === job.id));
    const nextJobIds = new Set(next.jobs.map((item) => item.id));
    for (const job of previous.jobs) if (!nextJobIds.has(job.id)) this.db.prepare('DELETE FROM orchestrator_job WHERE id = ?').run(job.id);
    const nextNotificationIds = new Set(next.notificationOutbox.map((item) => item.id));
    for (const notification of previous.notificationOutbox) if (!nextNotificationIds.has(notification.id)) this.db.prepare('DELETE FROM notification WHERE id = ?').run(notification.id);
    const nextReadinessIds = new Set(next.readiness.map((item) => `readiness_${digest(`${item.campaignId ?? ''}:${item.wallet.toLowerCase()}`)}`));
    for (const readiness of previous.readiness) {
      const id = `readiness_${digest(`${readiness.campaignId ?? ''}:${readiness.wallet.toLowerCase()}`)}`;
      if (!nextReadinessIds.has(id)) this.db.prepare('DELETE FROM orchestrator_readiness WHERE id = ?').run(id);
    }
    if (encode(previous.runtime) !== encode(next.runtime)) this.persistRuntime(next.runtime);
    if (!previous.killed && next.killed) this.databaseStore.setKillSwitch(true, this.actor, this.now());
  }

  private persistCampaign(campaign: Campaign, prior: Campaign | undefined): void {
    const graph = this.ensureCampaignGraph(campaign);
    if (!prior) {
      this.db.prepare('INSERT INTO campaign (id, drop_id, state, policy_snapshot_json, created_at) VALUES (?, ?, ?, ?, ?)').run(campaign.id, graph.dropId, dbCampaignState(campaign.state), encode({ campaignSnapshot: campaign }), campaign.createdAt);
      return;
    }
    if (prior.state !== campaign.state) {
      this.db.prepare('UPDATE campaign SET state = ? WHERE id = ?').run(dbCampaignState(campaign.state), campaign.id);
      this.recordLifecycle({ id: `transition_${randomUUID()}`, entityType: 'campaign', entityId: campaign.id, priorState: dbCampaignState(prior.state), newState: dbCampaignState(campaign.state), actor: this.actor, source: 'backend', reason: 'campaign lifecycle change', policyVersion: 'phase1', occurredAt: campaign.updatedAt });
    }
  }

  private persistRun(run: RunRecord, prior: RunRecord | undefined): void {
    const reason = encode({ kind: 'run', intentId: run.intentId, mode: run.mode, backendRequestDigest: run.requestDigest, ...(run.idempotencyKey ? { idempotencyKey: run.idempotencyKey } : {}) });
    if (!prior) {
       this.databaseStore.saveRun({ id: run.id, requestId: run.idempotencyKey ?? `run:${run.id}`, requestPayload: { backendRequestDigest: run.requestDigest }, campaignId: run.campaignId, state: dbRunState(run.state), actor: this.actor, source: 'backend', reason, createdAt: run.createdAt, updatedAt: run.updatedAt });
      this.recordLifecycle({ id: `transition_${randomUUID()}`, entityType: 'execution_run', entityId: run.id, newState: dbRunState(run.state), actor: this.actor, source: 'backend', reason: 'run created', policyVersion: 'phase1', occurredAt: run.createdAt });
      return;
    }
    if (prior.state !== run.state) {
      this.db.prepare('UPDATE execution_run SET state = ?, updated_at = ?, reason = ? WHERE id = ?').run(dbRunState(run.state), run.updatedAt, reason, run.id);
      this.recordLifecycle({ id: `transition_${randomUUID()}`, entityType: 'execution_run', entityId: run.id, priorState: dbRunState(prior.state), newState: dbRunState(run.state), actor: this.actor, source: 'backend', reason: 'run lifecycle change', policyVersion: 'phase1', occurredAt: run.updatedAt });
    }
  }

  private persistIntent(intent: IntentRecord, prior: IntentRecord | undefined): void {
    if (prior) return;
    const campaign = intent.campaignSnapshot;
    const graph = this.ensureCampaignGraph(campaign);
    for (const wallet of intent.wallets) {
      const canonicalWallet = this.ensureWallet(graph.chainProfileId, wallet, campaign);
      const id = this.intentRowId(intent.id, wallet);
      if (this.db.prepare('SELECT id FROM transaction_intent WHERE id = ?').get(id)) continue;
      const policyId = this.ensureSpendPolicy(canonicalWallet.walletId, campaign);
       const record: TransactionIntentRecord = { id, campaignId: campaign.id, walletId: canonicalWallet.walletId, intentClass: 'mint', toAddress: campaign.contract, valueWei: campaign.mintPriceWei * BigInt(campaign.quantity), calldata: '0x', chainProfileId: graph.chainProfileId, fromAddress: wallet, gasLimitWei: campaign.spendPolicy.gasCeilingWei, maxFeePerGasWei: campaign.feePolicy.totalFeeBudgetWei ?? 0n, maxPriorityFeePerGasWei: campaign.feePolicy.configuredPriorityFeeWei, idempotencyKey: `${intent.id}:${wallet.toLowerCase()}`, requestId: intent.id, runId: intent.runId, policySnapshot: policySnapshot(campaign, this.runFor(intent.runId), intent), createdAt: intent.createdAt };
      this.databaseStore.saveIntent(record);
      this.recordLifecycle({ id: `transition_${randomUUID()}`, entityType: 'transaction_intent', entityId: id, newState: 'prepared', actor: this.actor, source: 'backend', reason: 'immutable intent persisted before action', policyVersion: 'phase1', occurredAt: intent.createdAt });
      void policyId;
    }
  }

  private persistReservation(reservation: Reservation, prior: Reservation | undefined): void {
    if (!prior) throw new Error('CANONICAL_RESERVATION_ADMISSION_REQUIRED');
    if (prior.status === reservation.status && prior.actualAmountWei === reservation.actualAmountWei) return;
    if (prior.status === 'settled') return;
    if (reservation.status === 'settled') {
      const actual = reservation.actualAmountWei ?? reservation.amountWei;
      this.settleReservationTotal(reservation.id, actual);
    } else if (reservation.status === 'released') {
      this.db.prepare("UPDATE spend_reservation SET status = 'released' WHERE id = ? AND status = 'reserved'").run(reservation.id);
    } else if (reservation.status === 'reorged') {
      this.recordAudit({ id: `audit_${randomUUID()}`, entityType: 'spend_reservation', entityId: reservation.id, newState: 'reorged', actor: this.actor, reason: 'reorg exposure remains reserved pending reconciliation', policySnapshot: { kind: 'event', eventType: 'reorged' }, occurredAt: this.now().toISOString() });
    }
  }

  private settleReservationTotal(reservationId: string, actualAmountWei: bigint): void {
    const row = this.db.prepare("SELECT wallet_id, execution_id, reserved_amount_wei, status FROM spend_reservation WHERE id = ?").get(reservationId) as { wallet_id: string; execution_id: string | null; reserved_amount_wei: string; status: string } | undefined;
    if (!row || row.status !== 'reserved') return;
    if (actualAmountWei < 0n || actualAmountWei > BigInt(row.reserved_amount_wei)) throw new Error('INVALID_SETTLEMENT_AMOUNT');
    const amountColumn = actualAmountWei === 0n ? row.reserved_amount_wei : actualAmountWei.toString();
    const settledAt = this.now().toISOString();
    this.db.prepare("UPDATE spend_reservation SET status = 'settled', amount_wei = ?, settled_amount_wei = ?, settled_at = ? WHERE id = ? AND status = 'reserved'").run(amountColumn, actualAmountWei.toString(), settledAt, reservationId);
    this.recordAudit({ id: `audit_${randomUUID()}`, entityType: 'spend_reservation', entityId: reservationId, newState: 'settled', actor: this.actor, reason: 'total settlement recorded without fabricated component allocation', policySnapshot: { kind: 'settlement', componentState: 'total_only', executionId: row.execution_id, actualAmountWei: actualAmountWei.toString() }, occurredAt: settledAt });
  }

  private persistAttempt(attempt: AttemptRecord, prior: AttemptRecord | undefined): void {
    if (prior) return;
    const intentId = this.intentRowIdFromExecution(attempt.executionId, attempt.wallet, attempt.runId);
    if (!intentId) throw new Error('TRANSACTION_INTENT_REQUIRED');
    this.databaseStore.recordAttempt({ id: attempt.id, transactionIntentId: intentId, endpoint: attempt.endpoint ?? 'engine', responseClass: attempt.state, ...(attempt.nonce === undefined ? {} : { nonce: attempt.nonce }), ...(attempt.hash === undefined ? {} : { txHash: attempt.hash }), ...(attempt.redactedError === undefined ? {} : { redactedError: attempt.redactedError }), ...(attempt.replacementOfId === undefined ? {} : { replacementOfId: attempt.replacementOfId }), executionId: attempt.executionId, attemptedAt: attempt.createdAt });
    const target = attempt.state.toLowerCase();
    const nextState = target === 'pending' ? 'submitted' : target;
    this.transitionExecutionSafe(attempt.executionId, nextState, `engine attempt ${attempt.state}`);
  }

  private persistReceipt(receipt: ReceiptRecord, prior: ReceiptRecord | undefined): void {
    if (prior) return;
    const chain = this.db.prepare('SELECT cp.chain_id FROM execution e JOIN campaign c ON c.id = e.campaign_id JOIN "drop" d ON d.id = c.drop_id JOIN collection col ON col.id = d.collection_id JOIN contract ct ON ct.id = col.contract_id JOIN chain_profile cp ON cp.id = ct.chain_profile_id WHERE e.id = ?').get(receipt.executionId) as { chain_id: 1 | 4663 } | undefined;
    if (!chain) throw new Error('EXECUTION_CHAIN_REQUIRED');
    const attempt = receipt.transactionAttemptId ? this.db.prepare('SELECT id FROM transaction_attempt WHERE id = ? AND execution_id = ?').get(receipt.transactionAttemptId, receipt.executionId) as { id: string } | undefined : this.db.prepare('SELECT id FROM transaction_attempt WHERE execution_id = ? ORDER BY attempted_at DESC, id DESC LIMIT 1').get(receipt.executionId) as { id: string } | undefined;
    if (!attempt || receipt.blockNumber === undefined || !receipt.blockHash || receipt.actualSpendWei === undefined) throw new Error('RECEIPT_PERSISTENCE_FACTS_REQUIRED');
    const chainId = chain.chain_id;
    this.databaseStore.recordReceipt({ id: receipt.id, transactionAttemptId: attempt.id, executionId: receipt.executionId, txHash: this.attemptHash(attempt.id), status: receipt.state === 'Confirmed' ? 'confirmed' : receipt.state === 'Reorged' ? 'reorged' : 'reverted', blockNumber: Number(receipt.blockNumber), blockHash: receipt.blockHash, confirmations: 0, ...(receipt.gasUsed === undefined ? {} : { gasUsed: receipt.gasUsed }), ...(receipt.effectiveGasPrice === undefined ? {} : { effectiveGasPrice: receipt.effectiveGasPrice }), finalityStage: canonicalReceiptFinalityStage(chainId, receipt.state, receipt.robinhoodFinality), finalitySource: receipt.robinhoodFinality ? 'blockchain' : chainId === ROBINHOOD_CHAIN_ID ? 'l2-receipt-only' : 'ethereum-confirmation', observedAt: receipt.observedAt });
    this.transitionExecutionSafe(receipt.executionId, receipt.state === 'Confirmed' ? 'confirmed' : receipt.state === 'Reorged' ? 'reorged' : 'failed', `receipt ${receipt.state}`);
  }

  private persistReconciliation(record: ReconciliationRecord, prior: ReconciliationRecord | undefined): void {
    if (prior) return;
    const run = this.runFor(record.runId);
    const intent = run ? this.intentFor(record.attemptId) : undefined;
    const profile = run ? this.chainProfileForCampaign(run.campaignId) : undefined;
    if (!profile) throw new Error('CHAIN_PROFILE_REQUIRED');
    this.databaseStore.recordReconciliation({ id: record.id, chainProfileId: profile.id, ...(record.attemptId ? { transactionAttemptId: this.attemptIdForExecution(record.attemptId) } : {}), ...(record.reason ? { details: { reason: record.reason } } : {}), state: databaseReconciliationState(record.result), checkedAt: record.observedAt, source: 'backend-reconcile', ...(intent ? { fromAddress: intent.wallet } : {}), ...(intent?.nonce === undefined ? {} : { nonce: intent.nonce }), ...(intent?.hash ? { txHash: intent.hash } : {}), ...(record.attemptId ? { executionId: record.attemptId } : {}) });
  }

  private persistEvent(event: EventRecord, prior: EventRecord | undefined): void {
    if (prior) return;
    this.recordAudit({ id: event.id, entityType: event.runId ? 'execution_run' : 'state_transition', entityId: event.runId ?? 'global', actor: this.actor, reason: 'backend event', newState: event.type, policySnapshot: { kind: 'event', eventType: event.type, eventData: event.data, ...(event.runId ? { runId: event.runId } : {}) }, occurredAt: event.at });
  }

  private persistNotification(notification: BackendState['notificationOutbox'][number], prior: BackendState['notificationOutbox'][number] | undefined): void {
    const payload = encode({ sourceEventId: notification.sourceEventId, ...(notification.runId ? { runId: notification.runId } : {}), type: notification.type, text: notification.text, attempts: notification.attempts, ...(notification.canonicalLink ? { canonicalLink: notification.canonicalLink } : {}), ...(notification.lastError ? { lastError: notification.lastError } : {}) });
    if (!prior) {
      this.db.prepare("INSERT INTO notification (id, event_key, idempotency_key, delivery_state, payload_json, created_at, delivered_at) VALUES (?, ?, ?, 'pending', ?, ?, NULL)").run(notification.id, notification.sourceEventId, notification.id, payload, notification.createdAt);
      if (notification.state === 'failed') this.db.prepare("UPDATE notification SET delivery_state = 'failed', payload_json = ? WHERE id = ?").run(payload, notification.id);
      if (notification.state === 'delivered') {
        this.db.prepare("UPDATE notification SET delivery_state = 'sent', payload_json = ? WHERE id = ?").run(payload, notification.id);
        this.db.prepare("UPDATE notification SET delivery_state = 'delivered', payload_json = ?, delivered_at = ? WHERE id = ?").run(payload, notification.deliveredAt ?? null, notification.id);
      }
      return;
    }
    if (prior.state === notification.state && prior.attempts === notification.attempts && prior.deliveredAt === notification.deliveredAt && prior.lastError === notification.lastError) return;
    const current = this.db.prepare('SELECT delivery_state FROM notification WHERE id = ?').get(notification.id) as { delivery_state: string } | undefined;
    if (!current) throw new Error('NOTIFICATION_OUTBOX_NOT_FOUND');
    const target = notification.state === 'delivered' ? 'delivered' : notification.state === 'failed' ? 'failed' : notification.state === 'delivering' ? 'queued' : 'pending';
    if (target === 'delivered') {
      if (current.delivery_state === 'pending' || current.delivery_state === 'queued') this.db.prepare("UPDATE notification SET delivery_state = 'sent', payload_json = ? WHERE id = ?").run(payload, notification.id);
      if (current.delivery_state !== 'delivered') this.db.prepare("UPDATE notification SET delivery_state = 'delivered', payload_json = ?, delivered_at = ? WHERE id = ?").run(payload, notification.deliveredAt ?? null, notification.id);
      return;
    }
    if (target === 'queued' && current.delivery_state === 'failed') {
      this.db.prepare("UPDATE notification SET delivery_state = 'queued', payload_json = ?, delivered_at = NULL WHERE id = ?").run(payload, notification.id);
      return;
    }
    if (target === 'failed') {
      if (current.delivery_state !== 'failed') this.db.prepare("UPDATE notification SET delivery_state = 'failed', payload_json = ?, delivered_at = NULL WHERE id = ?").run(payload, notification.id);
      else this.db.prepare('UPDATE notification SET payload_json = ? WHERE id = ?').run(payload, notification.id);
      return;
    }
    this.db.prepare('UPDATE notification SET payload_json = ? WHERE id = ?').run(payload, notification.id);
  }

  private persistChainEvidence(evidence: ChainEvidenceRecord, prior: ChainEvidenceRecord | undefined): void {
    if (prior && encode(prior) === encode(evidence)) return;
    const profile = this.db.prepare('SELECT id FROM chain_profile WHERE chain_id = ?').get(evidence.chainId) as { id: string } | undefined;
    if (!profile) throw new Error('CANONICAL_CHAIN_PROFILE_REQUIRED');
    const status = evidence.status === 'accepted' ? 'verified' : evidence.status === 'rejected' ? 'execution_blocked' : 'characterization_pending';
    const existing = this.db.prepare('SELECT id, evidence_json FROM chain_verification WHERE chain_profile_id = ? ORDER BY checked_at DESC, id DESC').all(profile.id) as Array<{ id: string; evidence_json: string }>;
    if (existing.some((row) => decode<{ backendEvidenceId?: string; status?: string }>(row.evidence_json)?.backendEvidenceId === evidence.id && decode<{ backendEvidenceId?: string; status?: string }>(row.evidence_json)?.status === evidence.status)) return;
    if (evidence.chainId === ROBINHOOD_CHAIN_ID && !evidence.archiveEndpointIdentity) throw new Error('ROBINHOOD_ARCHIVE_REFERENCE_REQUIRED');
    this.databaseStore.recordChainVerification({ id: canonicalId('verification', `${evidence.id}:${evidence.status}:${evidence.checkedAt}`), chainProfileId: profile.id, chainId: evidence.chainId, sequencerEndpointReference: evidence.chainId === ROBINHOOD_CHAIN_ID ? evidence.endpointIdentity : undefined, archiveEndpointReference: evidence.chainId === ROBINHOOD_CHAIN_ID ? evidence.archiveEndpointIdentity : evidence.endpointIdentity, feedEndpointReference: evidence.chainId === ETHEREUM_CHAIN_ID ? evidence.endpointIdentity : undefined, status, evidence: { ...evidence, backendEvidenceId: evidence.id }, checkedAt: evidence.checkedAt, ...(evidence.acceptedBy ? { approvedBy: evidence.acceptedBy } : {}), ...(evidence.acceptedAt ? { approvedAt: evidence.acceptedAt } : {}) });
  }

  private persistSimulation(simulation: SimulationEvidenceRecord, prior: SimulationEvidenceRecord | undefined): void {
    if (prior && encode(prior) === encode(simulation)) return;
    const campaign = this.db.prepare('SELECT id FROM campaign WHERE id = ?').get(simulation.campaignId) as { id: string } | undefined;
    if (!campaign) throw new Error('CAMPAIGN_NOT_FOUND');
    const graph = this.chainProfileForCampaign(simulation.campaignId);
    if (!graph) throw new Error('CANONICAL_CHAIN_PROFILE_REQUIRED');
    const wallet = this.ensureWallet(graph.id, simulation.wallet, this.readCampaigns().find((item) => item.id === simulation.campaignId) as Campaign);
    const freshnessSeconds = Math.max(0, Math.floor((Date.parse(simulation.expiresAt) - Date.parse(simulation.checkedAt)) / 1000));
    this.databaseStore.recordSimulation({ id: simulation.id, walletId: wallet.walletId, campaignId: simulation.campaignId, sourceBlockNumber: Number(simulation.sourceBlock), sourceBlockHash: simulation.sourceBlockHash, checkedAt: simulation.checkedAt, freshnessSeconds, outcome: simulation.success ? 'pass' : 'fail', toolVersion: 'backend-phase1', details: { inputDigest: simulation.inputDigest, ...(simulation.gasEstimate === undefined ? {} : { gasEstimate: simulation.gasEstimate.toString() }), worstCaseFeeWei: simulation.worstCaseFeeWei.toString() } });
  }

  private persistJob(job: BackendState['jobs'][number], prior: BackendState['jobs'][number] | undefined): void {
    const payload = encode(job.payload);
    if (!prior) {
      this.db.prepare('INSERT INTO orchestrator_job (id, kind, run_id, campaign_id, state, scheduled_at, target_at, t_minus_ms, chain_time_offset_ms, idempotency_key, request_digest, payload_json, attempts, max_attempts, last_error, next_attempt_at, lease_owner, lease_expires_at, started_at, completed_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(job.id, job.kind, job.runId ?? null, job.campaignId ?? null, job.state, job.scheduledAt, job.targetAt ?? null, job.tMinusMs, job.chainTimeOffsetMs, job.idempotencyKey, job.requestDigest, payload, job.attempts, job.maxAttempts, job.lastError ?? null, job.nextAttemptAt ?? null, job.leaseOwner ?? null, job.leaseExpiresAt ?? null, job.startedAt ?? null, job.completedAt ?? null, job.createdAt, job.updatedAt);
      return;
    }
    if (prior.idempotencyKey !== job.idempotencyKey || prior.requestDigest !== job.requestDigest || prior.kind !== job.kind) throw new Error('JOB_IDENTITY_CONFLICT');
    if (encode(prior) === encode(job)) return;
    this.db.prepare('UPDATE orchestrator_job SET state = ?, scheduled_at = ?, target_at = ?, t_minus_ms = ?, chain_time_offset_ms = ?, payload_json = ?, attempts = ?, max_attempts = ?, last_error = ?, next_attempt_at = ?, lease_owner = ?, lease_expires_at = ?, started_at = ?, completed_at = ?, updated_at = ? WHERE id = ?').run(job.state, job.scheduledAt, job.targetAt ?? null, job.tMinusMs, job.chainTimeOffsetMs, payload, job.attempts, job.maxAttempts, job.lastError ?? null, job.nextAttemptAt ?? null, job.leaseOwner ?? null, job.leaseExpiresAt ?? null, job.startedAt ?? null, job.completedAt ?? null, job.updatedAt, job.id);
  }

  private persistReadiness(readiness: BackendState['readiness'][number], prior: BackendState['readiness'][number] | undefined): void {
    const id = `readiness_${digest(`${readiness.campaignId ?? ''}:${readiness.wallet.toLowerCase()}`)}`;
    const values = [id, readiness.campaignId ?? '', readiness.wallet, readiness.state, readiness.freshUntil, readiness.sourceBlock?.toString() ?? null, readiness.sourceBlockHash ?? null, readiness.observedAt ?? null, encode(readiness.blockingReasons), encode(readiness.checks), readiness.checkStates === undefined ? null : encode(readiness.checkStates), readiness.provenance === undefined ? null : encode(readiness.provenance)];
    if (!prior) {
      this.db.prepare('INSERT INTO orchestrator_readiness (id, campaign_id, wallet, state, fresh_until, source_block, source_block_hash, observed_at, blocking_reasons_json, checks_json, check_states_json, provenance_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(...values);
      return;
    }
    if (encode(prior) === encode(readiness)) return;
    this.db.prepare('UPDATE orchestrator_readiness SET state = ?, fresh_until = ?, source_block = ?, source_block_hash = ?, observed_at = ?, blocking_reasons_json = ?, checks_json = ?, check_states_json = ?, provenance_json = ? WHERE id = ?').run(readiness.state, readiness.freshUntil, readiness.sourceBlock?.toString() ?? null, readiness.sourceBlockHash ?? null, readiness.observedAt ?? null, encode(readiness.blockingReasons), encode(readiness.checks), readiness.checkStates === undefined ? null : encode(readiness.checkStates), readiness.provenance === undefined ? null : encode(readiness.provenance), id);
  }

  private persistRuntime(runtime: BackendState['runtime']): void {
    const capturedAt = this.now().toISOString();
    this.db.prepare('INSERT INTO runtime_readiness_snapshot (id, chain_profile_id, readiness_state, kill_switch_engaged, reconciliation_age_seconds, policy_snapshot_json, captured_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(`readiness_${digest(encode(runtime) + capturedAt)}`, null, runtime.startupState, runtime.startupState === 'Blocked' && runtime.blockingReasons.includes('KILLED') ? 1 : 0, null, encode({ kind: 'runtime', runtime }), capturedAt);
  }

  private recordLifecycle(record: LifecycleEventRecord): void {
    this.db.prepare('INSERT INTO state_transition (id, entity_type, entity_id, prior_state, new_state, actor, source, reason, policy_version, evidence_snapshot_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(record.id, record.entityType, record.entityId, record.priorState ?? null, record.newState, record.actor, record.source, record.reason, record.policyVersion ?? null, record.evidenceSnapshot === undefined ? null : encode(record.evidenceSnapshot), record.occurredAt);
  }

  private recordAudit(record: AuditEventRecord): void {
    this.databaseStore.recordAuditEvent(record);
  }

  private ensureCampaignGraph(campaign: Campaign): { chainProfileId: string; contractId: string; dropId: string } {
    const profile = this.db.prepare('SELECT id, chain_id FROM chain_profile WHERE chain_id = ?').get(campaign.chainId) as { id: string; chain_id: number } | undefined;
    if (!profile) throw new Error('CANONICAL_CHAIN_PROFILE_REQUIRED');
    if (profile.chain_id !== campaign.chainId) throw new Error('CHAIN_PROFILE_IDENTITY_MISMATCH');
    const existingContract = this.db.prepare('SELECT id FROM contract WHERE chain_profile_id = ? AND lower(address) = lower(?)').get(profile.id, campaign.contract) as { id: string } | undefined;
    const contractId = existingContract?.id ?? canonicalId('contract', `${profile.id}:${campaign.contract.toLowerCase()}`);
    if (!existingContract) this.db.prepare('INSERT INTO contract (id, chain_profile_id, address, kind, metadata_json) VALUES (?, ?, ?, ?, ?)').run(contractId, profile.id, campaign.contract, 'seadrop', encode({ source: 'backend-campaign-input' }));
    const existingCollection = this.db.prepare('SELECT id FROM collection WHERE contract_id = ? ORDER BY id LIMIT 1').get(contractId) as { id: string } | undefined;
    const collectionId = existingCollection?.id ?? canonicalId('collection', contractId);
    if (!existingCollection) this.db.prepare('INSERT INTO collection (id, contract_id, name, metadata_json) VALUES (?, ?, ?, ?)').run(collectionId, contractId, campaign.strategy, '{}');
    const existingDrop = this.db.prepare('SELECT id FROM "drop" WHERE collection_id = ? AND strategy = ? AND mint_price_wei = ? ORDER BY id LIMIT 1').get(collectionId, campaign.strategy, campaign.mintPriceWei.toString()) as { id: string } | undefined;
    const dropId = existingDrop?.id ?? canonicalId('drop', `${collectionId}:${campaign.strategy}:${campaign.mintPriceWei.toString()}`);
    if (!existingDrop) this.db.prepare('INSERT INTO "drop" (id, collection_id, strategy, mint_price_wei, observed_at) VALUES (?, ?, ?, ?, ?)').run(dropId, collectionId, campaign.strategy, campaign.mintPriceWei.toString(), campaign.createdAt);
    this.ensureFeePolicy(profile.id, campaign.feePolicy, campaign.chainId);
    return { chainProfileId: profile.id, contractId, dropId };
  }

  private ensureFeePolicy(chainProfileId: string, policy: FeePolicy, chainId: 1 | 4663): void {
    if (policy.kind === 'paid' && chainId === ROBINHOOD_CHAIN_ID) throw new Error('ROBINHOOD_PAID_MINTS_DISABLED');
    const existing = this.db.prepare('SELECT paid_mints_enabled FROM fee_policy WHERE chain_profile_id = ? AND active = 1 ORDER BY rowid DESC LIMIT 1').get(chainProfileId) as { paid_mints_enabled: number } | undefined;
    if (existing) {
      if (policy.kind === 'paid' && existing.paid_mints_enabled !== 1) throw new Error('PAID_MINT_POLICY_REQUIRED');
      return;
    }
    this.db.prepare('INSERT INTO fee_policy (id, chain_profile_id, version, priority_fee_semantics, max_total_fee_wei, free_mint_total_fee_cap_wei, free_mint_priority_fee_component_wei, free_mint_priority_fee_multiplier, paid_mints_enabled, active, created_at, zero_priority_fee_policy) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)').run(canonicalId('fee', `${chainProfileId}:${encode(policy)}`), chainProfileId, `backend-${digest(encode(policy))}`, chainId === ETHEREUM_CHAIN_ID ? 'ordering' : 'fee_only', (policy.totalFeeBudgetWei ?? 0n).toString(), (policy.freeTotalSpendCapWei ?? 0n).toString(), policy.configuredPriorityFeeWei.toString(), 2, policy.kind === 'paid' ? 1 : 0, this.now().toISOString(), policy.configuredPriorityFeeWei === 0n ? 'requires_po_resolution' : 'allowed');
  }

  private activeFeePolicy(chainProfileId: string): { id: string; version: string; priority_fee_semantics: 'ordering' | 'fee_only'; max_total_fee_wei: string; free_mint_total_fee_cap_wei: string; free_mint_priority_fee_component_wei: string; free_mint_priority_fee_multiplier: number; paid_mints_enabled: number; zero_priority_fee_policy: string } {
    const row = this.db.prepare('SELECT id, version, priority_fee_semantics, max_total_fee_wei, free_mint_total_fee_cap_wei, free_mint_priority_fee_component_wei, free_mint_priority_fee_multiplier, paid_mints_enabled, zero_priority_fee_policy FROM fee_policy WHERE chain_profile_id = ? AND active = 1 ORDER BY rowid DESC LIMIT 1').get(chainProfileId) as { id: string; version: string; priority_fee_semantics: 'ordering' | 'fee_only'; max_total_fee_wei: string; free_mint_total_fee_cap_wei: string; free_mint_priority_fee_component_wei: string; free_mint_priority_fee_multiplier: number; paid_mints_enabled: number; zero_priority_fee_policy: string } | undefined;
    if (!row) throw new Error('FEE_POLICY_REQUIRED');
    return row;
  }

  private mintPeriodId(campaignId: string): string {
    if (!this.supportsCampaignPeriods) return campaignId;
    const row = this.db.prepare("SELECT id FROM campaign_period WHERE campaign_id = ? AND id = ?").get(campaignId, `campaign:${campaignId}`) as { id: string } | undefined;
    if (!row) throw new Error('CAMPAIGN_PERIOD_REQUIRED');
    return row.id;
  }

  private ensureWallet(chainProfileId: string, address: string, campaign: Campaign): { walletId: string; chainProfileId: string } {
    const existing = this.db.prepare('SELECT id FROM wallet WHERE chain_profile_id = ? AND lower(address) = lower(?)').get(chainProfileId, address) as { id: string } | undefined;
    if (existing) { this.ensureSpendPolicy(existing.id, campaign); return { walletId: existing.id, chainProfileId }; }
    const walletId = canonicalId('wallet', `${chainProfileId}:${address.toLowerCase()}`);
    this.db.prepare('INSERT INTO wallet (id, chain_profile_id, address, key_reference, created_at) VALUES (?, ?, ?, ?, ?)').run(walletId, chainProfileId, address, `${this.walletKeyReferencePrefix}#${address.toLowerCase()}`, this.now().toISOString());
    this.ensureSpendPolicy(walletId, campaign);
    return { walletId, chainProfileId };
  }

  private ensureSpendPolicy(walletId: string, campaign: Campaign): string {
    const id = this.policyId(campaign.id, this.walletAddress(walletId));
    if (!this.db.prepare('SELECT id FROM spend_policy WHERE id = ?').get(id)) this.db.prepare('INSERT INTO spend_policy (id, wallet_id, daily_cap_wei, version, active, free_mint_wallet_cap_wei, free_mint_period_cap_wei) VALUES (?, ?, ?, ?, 1, ?, ?)').run(id, walletId, campaign.spendPolicy.dailyCapWei.toString(), 'backend-phase1', '200000000000000', '2000000000000000');
    return id;
  }

  private findWallet(campaign: Campaign, address: string): { walletId: string; chainProfileId: string } {
    const profile = this.chainProfileForCampaign(campaign.id);
    if (!profile) throw new Error('CANONICAL_CHAIN_PROFILE_REQUIRED');
    const wallet = this.ensureWallet(profile.id, address, campaign);
    return wallet;
  }

  private chainProfileForCampaign(campaignId: string): { id: string; chainId: 1 | 4663 } | undefined {
    const row = this.db.prepare('SELECT cp.id, cp.chain_id FROM campaign c JOIN "drop" d ON d.id = c.drop_id JOIN collection col ON col.id = d.collection_id JOIN contract ct ON ct.id = col.contract_id JOIN chain_profile cp ON cp.id = ct.chain_profile_id WHERE c.id = ?').get(campaignId) as { id: string; chain_id: 1 | 4663 } | undefined;
    return row ? { id: row.id, chainId: row.chain_id } : undefined;
  }

  private walletAddress(walletId: string): string {
    const row = this.db.prepare('SELECT address FROM wallet WHERE id = ?').get(walletId) as { address: string } | undefined;
    return row?.address ?? walletId;
  }

  private policyId(campaignId: string, wallet: string): string {
    return canonicalId('policy', `${campaignId}:${wallet.toLowerCase()}`);
  }

  private executionId(runId: string, wallet: string): string {
    return canonicalId('execution', `${runId}:${wallet.toLowerCase()}`);
  }

  private reservationId(runId: string, wallet: string): string {
    return canonicalId('reservation', `${runId}:${wallet.toLowerCase()}`);
  }

  private intentRowId(intentId: string, wallet: string): string {
    return canonicalId('intent', `${intentId}:${wallet.toLowerCase()}`);
  }

  private intentRowIdFromExecution(executionId: string, wallet: string, runId: string): string | undefined {
    const row = this.db.prepare('SELECT transaction_intent_id FROM execution WHERE id = ?').get(executionId) as { transaction_intent_id: string } | undefined;
    if (row) return row.transaction_intent_id;
    const intent = this.db.prepare('SELECT ti.id FROM transaction_intent ti JOIN wallet w ON w.id = ti.wallet_id WHERE ti.run_id = ? AND lower(w.address) = lower(?)').get(runId, wallet) as { id: string } | undefined;
    return intent?.id;
  }

  private attemptIdForExecution(executionId: string): string | undefined {
    const row = this.db.prepare('SELECT id FROM transaction_attempt WHERE execution_id = ? ORDER BY attempted_at DESC, id DESC LIMIT 1').get(executionId) as { id: string } | undefined;
    return row?.id;
  }

  private attemptHash(attemptId: string, executionId?: string): string {
    const row = executionId ? this.db.prepare('SELECT tx_hash FROM transaction_attempt WHERE id = ? AND execution_id = ?').get(attemptId, executionId) as { tx_hash: string | null } | undefined : this.db.prepare('SELECT tx_hash FROM transaction_attempt WHERE id = ?').get(attemptId) as { tx_hash: string | null } | undefined;
    if (!row?.tx_hash) throw new Error('RECEIPT_TRANSACTION_HASH_REQUIRED');
    return row.tx_hash;
  }

  private executionIdentity(executionId: string): { runId: string; campaignId: string; wallet: string; transactionIntentId: string; chainId: 1 | 4663; chainProfileId: string; valueWei: bigint } | undefined {
    const row = this.db.prepare('SELECT e.run_id, e.campaign_id, e.transaction_intent_id, ti.value_wei, w.address, cp.chain_id, cp.id AS chain_profile_id FROM execution e JOIN transaction_intent ti ON ti.id = e.transaction_intent_id JOIN wallet w ON w.id = e.wallet_id JOIN chain_profile cp ON cp.id = w.chain_profile_id WHERE e.id = ?').get(executionId) as { run_id: string | null; campaign_id: string; transaction_intent_id: string; value_wei: string; address: string; chain_id: 1 | 4663; chain_profile_id: string } | undefined;
    if (!row?.run_id) return undefined;
    return { runId: row.run_id, campaignId: row.campaign_id, wallet: row.address, transactionIntentId: row.transaction_intent_id, chainId: row.chain_id, chainProfileId: row.chain_profile_id, valueWei: BigInt(row.value_wei) };
  }

  private runFor(runId: string): RunRecord | undefined {
    return this.snapshot().runs.find((run) => run.id === runId);
  }

  private intentFor(executionId?: string): AttemptRecord | undefined {
    const row = executionId ? this.db.prepare('SELECT a.id, a.transaction_intent_id, a.nonce, a.tx_hash, w.address FROM transaction_attempt a JOIN transaction_intent ti ON ti.id = a.transaction_intent_id JOIN wallet w ON w.id = ti.wallet_id WHERE a.execution_id = ? ORDER BY a.attempted_at DESC LIMIT 1').get(executionId) as { id: string; transaction_intent_id: string; nonce: number | null; tx_hash: string | null; address: string } | undefined : undefined;
    return row ? { id: row.id, executionId: executionId ?? '', runId: '', wallet: row.address, ...(row.nonce === null ? {} : { nonce: row.nonce }), ...(row.tx_hash ? { hash: row.tx_hash } : {}), state: 'Submitted', createdAt: '', updatedAt: '' } : undefined;
  }

  private runChain(runId: string, runs: readonly RunRecord[]): 1 | 4663 {
    const run = runs.find((candidate) => candidate.id === runId);
    if (!run) return ETHEREUM_CHAIN_ID;
    const row = this.chainProfileForCampaign(run.campaignId);
    return row?.chainId ?? ETHEREUM_CHAIN_ID;
  }

  private runFingerprint(runId: string): string {
    const row = this.db.prepare('SELECT request_fingerprint, reason FROM execution_run WHERE id = ?').get(runId) as { request_fingerprint: string; reason: string | null } | undefined;
    const reason = decodeRecord<{ backendRequestDigest?: string }>(row?.reason);
    return reason?.backendRequestDigest ?? row?.request_fingerprint ?? digest(runId);
  }

  private updateRunState(runId: string, state: ExecutionRunRecord['state'], run: RunRecord): void {
    this.db.prepare('UPDATE execution_run SET state = ?, updated_at = ? WHERE id = ?').run(state, this.now().toISOString(), runId);
    if (run.state !== backendRunState(state)) this.recordLifecycle({ id: `transition_${randomUUID()}`, entityType: 'execution_run', entityId: runId, priorState: dbRunState(run.state), newState: state, actor: this.actor, source: 'backend-admission', reason: 'run admitted', policyVersion: 'phase1', occurredAt: this.now().toISOString() });
  }

  private transitionExecutionSafe(executionId: string, target: string, reason: string): void {
    const row = this.db.prepare('SELECT state FROM execution WHERE id = ?').get(executionId) as { state: string } | undefined;
    if (!row || row.state === 'aborted') return;
    if (row.state === target) return;
    const needsSubmitted = ['confirmed', 'reorged'].includes(target) && row.state === 'prepared';
    if (needsSubmitted) this.databaseStore.transitionExecution(executionId, 'submitted', { id: `transition_${randomUUID()}`, entityType: 'execution', actor: this.actor, source: 'backend', reason: 'submission fact precedes terminal fact', policyVersion: 'phase1', occurredAt: this.now().toISOString() });
    this.databaseStore.transitionExecution(executionId, target, { id: `transition_${randomUUID()}`, entityType: 'execution', actor: this.actor, source: 'backend', reason, policyVersion: 'phase1', occurredAt: this.now().toISOString() });
  }

  private transitionExecution(executionId: string, state: string, source: string, reason: string): void {
    const row = this.db.prepare('SELECT state FROM execution WHERE id = ?').get(executionId) as { state: string } | undefined;
    if (!row || row.state === state) return;
    this.databaseStore.transitionExecution(executionId, state, { id: `transition_${randomUUID()}`, entityType: 'execution', actor: this.actor, source, reason, policyVersion: 'phase1', occurredAt: this.now().toISOString() });
  }

  private exposure(campaign: Campaign): bigint {
    const mint = campaign.mintPriceWei * BigInt(campaign.quantity);
    const fee = campaign.feePolicy.totalFeeBudgetWei ?? (campaign.feePolicy.configuredPriorityFeeWei + (campaign.feePolicy.l2ExecutionGasBudgetWei ?? 0n) + (campaign.feePolicy.l1DataGasBudgetWei ?? 0n));
    const buffers = (Object.values(PHASE1_ZERO_ADMISSION_BUFFERS) as bigint[]).reduce<bigint>((total, component) => total + component, 0n);
    return mint + fee + buffers;
  }

  private reservationSnapshot(input: CanonicalAdmissionInput, boundary?: { mintClass: string; feePolicyId: string; feePolicyVersion: string; mintPeriodId: string }): Record<string, unknown> {
    const fee = input.campaign.feePolicy;
    return { chainProfileId: this.chainProfileForCampaign(input.campaign.id)?.id, campaignId: input.campaign.id, runId: input.run.id, requestFingerprint: this.runFingerprint(input.run.id), freeMint: input.campaign.mintPriceWei === 0n, mintClass: boundary?.mintClass ?? (input.campaign.mintPriceWei === 0n ? 'free' : 'paid'), ...(boundary?.feePolicyId ? { feePolicyId: boundary.feePolicyId } : {}), ...(boundary?.feePolicyVersion ? { feePolicyVersion: boundary.feePolicyVersion } : {}), ...(boundary?.mintPeriodId ? { mintPeriodId: boundary.mintPeriodId } : {}), mintValueWei: (input.campaign.mintPriceWei * BigInt(input.campaign.quantity)).toString(), l2ExecutionGasWei: (fee.l2ExecutionGasBudgetWei ?? 0n).toString(), l1DataGasWei: (fee.l1DataGasBudgetWei ?? 0n).toString(), priorityFeeComponentWei: fee.configuredPriorityFeeWei.toString(), ...Object.fromEntries(Object.entries(PHASE1_ZERO_ADMISSION_BUFFERS).map(([key, value]) => [key, value.toString()])), allInExposureWei: this.exposure(input.campaign).toString() };
  }

  private assertCanonicalFeePolicy(campaign: Campaign, fee: FeePolicy): void {
    const profile = this.chainProfileForCampaign(campaign.id);
    if (!profile) throw new Error('CANONICAL_CHAIN_PROFILE_REQUIRED');
    if (profile.chainId === ROBINHOOD_CHAIN_ID && fee.kind === 'paid') throw new Error('ROBINHOOD_PAID_MINTS_DISABLED');
    const totalFee = fee.totalFeeBudgetWei ?? 0n;
    if (profile.chainId === ETHEREUM_CHAIN_ID && fee.kind === 'paid' && campaign.broadcastMode !== 'public') throw new Error('PAID_ETHEREUM_PUBLIC_MODE_REQUIRED');
    if (totalFee < 0n || totalFee > campaign.spendPolicy.gasCeilingWei) throw new Error('GAS_CEILING_EXCEEDED');
    const policy = this.db.prepare('SELECT max_total_fee_wei, free_mint_total_fee_cap_wei, paid_mints_enabled, zero_priority_fee_policy FROM fee_policy WHERE chain_profile_id = ? AND active = 1 ORDER BY rowid DESC LIMIT 1').get(profile.id) as { max_total_fee_wei: string; free_mint_total_fee_cap_wei: string; paid_mints_enabled: number; zero_priority_fee_policy: string } | undefined;
    if (!policy) throw new Error('FEE_POLICY_REQUIRED');
    if (fee.kind === 'paid' && policy.paid_mints_enabled !== 1) throw new Error('PAID_MINT_POLICY_REQUIRED');
    if (fee.kind === 'free' && totalFee > BigInt(policy.free_mint_total_fee_cap_wei)) throw new Error('FREE_TOTAL_SPEND_CAP_EXCEEDED');
    if (totalFee > BigInt(policy.max_total_fee_wei)) throw new Error('FEE_POLICY_CAP_EXCEEDED');
    if (fee.configuredPriorityFeeWei === 0n && policy.zero_priority_fee_policy !== 'allowed') throw new Error('ZERO_PRIORITY_FEE_POLICY_REQUIRED');
  }

  private assertCanonicalChainProfile(campaign: Campaign): void {
    const profile = this.db.prepare('SELECT id, chain_id, execution_enabled FROM chain_profile WHERE chain_id = ?').get(campaign.chainId) as { id: string; chain_id: number; execution_enabled: number } | undefined;
    if (!profile) throw new Error('CANONICAL_CHAIN_PROFILE_REQUIRED');
    if (profile.chain_id !== campaign.chainId) throw new Error('CHAIN_PROFILE_IDENTITY_MISMATCH');
    if (campaign.chainId === ROBINHOOD_CHAIN_ID) throw new Error('ROBINHOOD_EXECUTION_DISABLED');
    if (profile.execution_enabled !== 1) throw new Error('CHAIN_EXECUTION_DISABLED');
    const verification = this.db.prepare('SELECT status, evidence_json FROM chain_verification WHERE chain_profile_id = ? ORDER BY checked_at DESC, id DESC LIMIT 1').get(profile.id) as { status: string; evidence_json: string } | undefined;
    const evidence = decodeRecord<{ expiresAt?: string }>(verification?.evidence_json);
    if (verification?.status !== 'verified' || !evidence?.expiresAt || !Number.isFinite(Date.parse(evidence.expiresAt)) || Date.parse(evidence.expiresAt) <= this.now().getTime()) throw new Error('CHAIN_VERIFICATION_REQUIRED');
  }

  private assertCaps(walletId: string, campaign: Campaign, usageDate: string, amount: bigint, priorRunExposure: bigint): void {
    if (priorRunExposure + amount > campaign.spendPolicy.maxRunWei) throw new Error('SPEND_CAP_EXCEEDED');
    const dailyRows = this.db.prepare("SELECT COALESCE(reserved_amount_wei, amount_wei) AS amount FROM spend_reservation WHERE wallet_id = ? AND usage_date = ? AND status IN ('reserved', 'settled')").all(walletId, usageDate) as Array<{ amount: string }>;
    if (dailyRows.reduce((total, row) => total + BigInt(row.amount), 0n) + amount > campaign.spendPolicy.dailyCapWei) throw new Error('DAILY_SPEND_CAP_EXCEEDED');
  }

  private runExposure(runId: string): bigint {
    const rows = this.db.prepare("SELECT COALESCE(r.reserved_amount_wei, r.amount_wei) AS amount FROM spend_reservation r JOIN execution e ON e.id = r.execution_id WHERE e.run_id = ? AND r.status IN ('reserved', 'settled')").all(runId) as Array<{ amount: string }>;
    return rows.reduce((total, row) => total + BigInt(row.amount), 0n);
  }
}

export function rebindExecutionResult(result: ExecutionResult, prepared: readonly PreparedExecution[]): ExecutionResult {
  if (prepared.length === 0) return result;
  const byWallet = new Map(prepared.map((item) => [item.wallet.toLowerCase(), item.executionId]));
  const oldToNew = new Map<string, string>();
  const attempts = result.attempts.map((attempt) => {
    const executionId = byWallet.get(attempt.wallet.toLowerCase());
    if (!executionId) throw new Error('UNADMITTED_EXECUTION_WALLET');
    oldToNew.set(attempt.executionId, executionId);
    return { ...attempt, executionId };
  });
  const receipts = result.receipts.map((receipt) => {
    const executionId = oldToNew.get(receipt.executionId);
    if (!executionId) throw new Error('UNADMITTED_RECEIPT_EXECUTION');
    return { ...receipt, executionId };
  });
  const executionIds = result.executionIds.map((id) => oldToNew.get(id) ?? id);
  if (executionIds.some((id) => !prepared.some((item) => item.executionId === id))) throw new Error('UNADMITTED_EXECUTION_ID');
  return { ...result, executionIds, attempts, receipts };
}
