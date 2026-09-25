import { createHash } from 'node:crypto';
import type { SqliteDatabase } from './database.js';

export type ReservationStatus = 'reserved' | 'settled' | 'released' | 'expired';

export interface ReservationRequest {
  id: string;
  walletId: string;
  executionId?: string;
  idempotencyKey: string;
  requestId?: string;
  requestFingerprint?: string;
  policyId: string;
  amountWei: bigint;
  at?: Date;
}

export interface ExecutionReservationRequest {
  id: string;
  walletId: string;
  chainProfileId: string;
  campaignId: string;
  mintPeriodId?: string;
  executionId?: string;
  transactionIntentId?: string;
  idempotencyKey: string;
  requestId?: string;
  requestFingerprint?: string;
  policyId: string;
  mintValueWei: bigint;
  l2ExecutionGasWei: bigint;
  l1DataGasWei: bigint;
  priorityFeeComponentWei: bigint;
  replacementBudgetWei?: bigint;
  mintValueBufferWei?: bigint;
  l2ExecutionGasBufferWei?: bigint;
  l1DataGasBufferWei?: bigint;
  priorityFeeBufferWei?: bigint;
  freeMint: boolean;
  policySnapshot?: unknown;
  at?: Date;
}

export interface SettlementComponents {
  actualMintValueWei: bigint;
  actualL2ExecutionGasWei: bigint;
  actualL1DataGasWei: bigint;
  actualPriorityFeeComponentWei?: bigint;
  actualReplacementBudgetWei?: bigint;
  authoritativeReceiptId?: string;
  authoritativeReconciliationId?: string;
}

interface StoredReservationRow {
  status: ReservationStatus;
  amount_wei: string;
  reserved_amount_wei: string | null;
  mint_value_wei: string;
  l2_execution_gas_wei: string;
  l1_data_gas_wei: string;
  priority_fee_component_wei: string;
  replacement_budget_wei: string | null;
  mint_value_buffer_wei: string | null;
  l2_execution_gas_buffer_wei: string | null;
  l1_data_gas_buffer_wei: string | null;
  priority_fee_buffer_wei: string | null;
}

export class SpendCapExceededError extends Error {
  constructor() { super('daily spend cap exceeded'); }
}

export class ReservationConflictError extends Error {
  constructor() { super('idempotency key was reused with a different request fingerprint'); }
}

function encode(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (typeof item === 'bigint') return item.toString();
    if (Array.isArray(item)) return item.map((entry) => normalize(entry));
    if (item !== null && typeof item === 'object') return Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, normalize(entry)]));
    return item;
  };
  const result = JSON.stringify(normalize(value));
  if (result !== undefined && /"(?:private[_-]?key|mnemonic|seed(?:[_-]?phrase)?|passphrase|password|api[_-]?key|access[_-]?token|secret[_-]?key|auth[_-]?token)"\s*:/i.test(result)) throw new Error('secret-like values must remain in the approved secret store');
  return result ?? '{}';
}

function digest(value: unknown): string {
  return createHash('sha256').update(encode(value)).digest('hex');
}

function policyUsageDate(at: Date, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
    const values = new Map(parts.map((part) => [part.type, part.value]));
    const year = values.get('year');
    const month = values.get('month');
    const day = values.get('day');
    if (!year || !month || !day) throw new Error('invalid policy timezone');
    return `${year}-${month}-${day}`;
  } catch {
    throw new Error('invalid spend policy timezone');
  }
}

function nonNegative(amounts: bigint[], message: string): void {
  if (amounts.some((amount) => amount < 0n)) throw new Error(message);
}

function componentExposure(row: StoredReservationRow): bigint {
  if (row.status === 'reserved') return BigInt(row.reserved_amount_wei === null || row.reserved_amount_wei === '0' ? row.amount_wei : row.reserved_amount_wei);
  if (row.status === 'settled') return BigInt(row.amount_wei);
  return 0n;
}

export class SpendReservations {
  public constructor(private readonly db: SqliteDatabase) {}

  private immediate<T>(operation: () => T): T {
    if (this.db.inTransaction) return operation();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  public setKillSwitch(engaged: boolean, changedBy: string, at = new Date()): void {
    this.immediate(() => {
      this.db.prepare("UPDATE runtime_control SET kill_switch_engaged = ?, changed_by = ?, changed_at = ? WHERE id = 'global'").run(engaged ? 1 : 0, changedBy, at.toISOString());
    });
  }

  public isKillSwitchEngaged(): boolean {
    const row = this.db.prepare("SELECT kill_switch_engaged FROM runtime_control WHERE id = 'global'").get() as { kill_switch_engaged: number };
    return row.kill_switch_engaged === 1;
  }

  public reserve(request: ReservationRequest): ReservationStatus {
    nonNegative([request.amountWei], 'reservation amount must be non-negative');
    if (request.amountWei === 0n) throw new Error('reservation amount must be positive');
    const at = request.at ?? new Date();
    if (request.idempotencyKey.length === 0) throw new Error('idempotency key must not be empty');
    return this.immediate(() => {
      if (this.isKillSwitchEngaged()) throw new Error('kill switch engaged');
      if (request.executionId) {
        const execution = this.db.prepare('SELECT wallet_id FROM execution WHERE id = ?').get(request.executionId) as { wallet_id: string } | undefined;
        if (!execution || execution.wallet_id !== request.walletId) throw new Error('reservation execution does not match wallet');
      }
      const policy = this.db.prepare('SELECT daily_cap_wei AS cap, timezone FROM spend_policy WHERE id = ? AND wallet_id = ? AND active = 1').get(request.policyId, request.walletId) as { cap: string; timezone: string } | undefined;
      if (!policy) throw new Error('active spend policy not found');
      const day = policyUsageDate(at, policy.timezone);
      const computedFingerprint = digest({
        walletId: request.walletId,
        executionId: request.executionId ?? null,
        policyId: request.policyId,
        amountWei: request.amountWei.toString(),
        usageDate: day,
        timezone: policy.timezone,
      });
      if (request.requestFingerprint !== undefined && request.requestFingerprint !== computedFingerprint) throw new ReservationConflictError();
      const existing = this.db.prepare('SELECT status, request_fingerprint FROM spend_reservation WHERE idempotency_key = ?').get(request.idempotencyKey) as { status: ReservationStatus; request_fingerprint: string | null } | undefined;
      if (existing) {
        if (existing.request_fingerprint !== computedFingerprint) throw new ReservationConflictError();
        return existing.status;
      }
      const rows = this.db.prepare("SELECT status, amount_wei, reserved_amount_wei, mint_value_wei, l2_execution_gas_wei, l1_data_gas_wei, priority_fee_component_wei, replacement_budget_wei, mint_value_buffer_wei, l2_execution_gas_buffer_wei, l1_data_gas_buffer_wei, priority_fee_buffer_wei FROM spend_reservation WHERE wallet_id = ? AND usage_date = ? AND status IN ('reserved', 'settled')").all(request.walletId, day) as Array<{ status: ReservationStatus; amount_wei: string; reserved_amount_wei: string | null; mint_value_wei: string; l2_execution_gas_wei: string; l1_data_gas_wei: string; priority_fee_component_wei: string; replacement_budget_wei: string | null; mint_value_buffer_wei: string | null; l2_execution_gas_buffer_wei: string | null; l1_data_gas_buffer_wei: string | null; priority_fee_buffer_wei: string | null }>;
      const used = rows.reduce((total, row) => total + componentExposure(row), 0n);
      if (used + request.amountWei > BigInt(policy.cap)) throw new SpendCapExceededError();
      this.db.prepare('INSERT INTO spend_reservation (id, wallet_id, execution_id, idempotency_key, request_id, request_fingerprint, policy_id, amount_wei, reserved_amount_wei, usage_date, status, created_at, mint_class) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, \'reserved\', ?, \'legacy\')').run(request.id, request.walletId, request.executionId ?? null, request.idempotencyKey, request.requestId ?? request.idempotencyKey, computedFingerprint, request.policyId, request.amountWei.toString(), request.amountWei.toString(), day, at.toISOString());
      return 'reserved';
    });
  }

  public transition(id: string, status: Exclude<ReservationStatus, 'reserved'>, at = new Date()): void {
    this.immediate(() => {
      const row = this.db.prepare("SELECT status, amount_wei, execution_id, transaction_intent_id, mint_value_wei, l2_execution_gas_wei, l1_data_gas_wei, priority_fee_component_wei, replacement_budget_wei FROM spend_reservation WHERE id = ? AND status = 'reserved'").get(id) as { status: ReservationStatus; amount_wei: string; execution_id: string | null; transaction_intent_id: string | null; mint_value_wei: string; l2_execution_gas_wei: string; l1_data_gas_wei: string; priority_fee_component_wei: string; replacement_budget_wei: string } | undefined;
      if (!row) throw new Error('reservation is missing or no longer reservable');
      if (status === 'settled' && (row.execution_id !== null || row.transaction_intent_id !== null || [row.mint_value_wei, row.l2_execution_gas_wei, row.l1_data_gas_wei, row.priority_fee_component_wei, row.replacement_budget_wei].some((amount) => amount !== '0'))) throw new Error('linked reservations require authoritative component settlement');
      if (status === 'released' || status === 'expired') {
        const attempts = row.execution_id ? this.db.prepare('SELECT COUNT(*) AS count FROM transaction_attempt WHERE execution_id = ?').get(row.execution_id) as { count: number } : row.transaction_intent_id ? this.db.prepare('SELECT COUNT(*) AS count FROM transaction_attempt WHERE transaction_intent_id = ?').get(row.transaction_intent_id) as { count: number } : { count: 0 };
        if (attempts.count > 0) throw new Error('submitted reservations cannot be released or expired');
      }
      const result = this.db.prepare("UPDATE spend_reservation SET status = ?, settled_at = CASE WHEN ? = 'settled' THEN ? ELSE settled_at END, settled_amount_wei = CASE WHEN ? = 'settled' THEN amount_wei ELSE settled_amount_wei END WHERE id = ? AND status = 'reserved'").run(status, status, at.toISOString(), status, id);
      if (result.changes !== 1) throw new Error('reservation is missing or no longer reservable');
      if (status === 'settled') this.db.prepare('INSERT INTO spend_ledger_entry (id, wallet_id, execution_id, reservation_id, entry_type, component, amount_wei, created_at) SELECT ?, wallet_id, execution_id, id, \'mint\', \'total\', amount_wei, ? FROM spend_reservation WHERE id = ?').run(`${id}:settled:total`, at.toISOString(), id);
    });
  }

  public reserveExecution(request: ExecutionReservationRequest): ReservationStatus {
    const replacementBudgetWei = request.replacementBudgetWei ?? 0n;
    const mintValueBufferWei = request.mintValueBufferWei ?? 0n;
    const l2ExecutionGasBufferWei = request.l2ExecutionGasBufferWei ?? 0n;
    const l1DataGasBufferWei = request.l1DataGasBufferWei ?? 0n;
    const priorityFeeBufferWei = request.priorityFeeBufferWei ?? 0n;
    const amounts = [request.mintValueWei, request.l2ExecutionGasWei, request.l1DataGasWei, request.priorityFeeComponentWei, replacementBudgetWei, mintValueBufferWei, l2ExecutionGasBufferWei, l1DataGasBufferWei, priorityFeeBufferWei];
    nonNegative(amounts, 'reservation amounts must be non-negative');
    const at = request.at ?? new Date();
    let usageDate = at.toISOString().slice(0, 10);
    let periodId = request.mintPeriodId ?? 'default';
    if (request.idempotencyKey.length === 0) throw new Error('idempotency key must not be empty');
    const priorityExposure = request.priorityFeeComponentWei + priorityFeeBufferWei;
    const feeExposure = request.l2ExecutionGasWei + l2ExecutionGasBufferWei + request.l1DataGasWei + l1DataGasBufferWei + priorityExposure + replacementBudgetWei;
    const exposure = request.mintValueWei + mintValueBufferWei + feeExposure;
    if (exposure === 0n) throw new Error('reservation exposure must be positive');
    return this.immediate(() => {
      if (this.isKillSwitchEngaged()) throw new Error('kill switch engaged');
      const chain = this.db.prepare('SELECT chain_id, execution_enabled, verification_status FROM chain_profile WHERE id = ?').get(request.chainProfileId) as { chain_id: number; execution_enabled: number; verification_status: string } | undefined;
      if (!chain) throw new Error('chain profile not found');
      if (chain.chain_id === 4663 && !request.freeMint) throw new Error('paid Robinhood mints are blocked');
      if (chain.chain_id === 4663 && chain.execution_enabled !== 1) throw new Error('Robinhood execution is disabled');
      if (chain.verification_status !== 'verified' || chain.execution_enabled !== 1) throw new Error('chain execution is not enabled or verified');
      if (chain.chain_id === 4663 && request.mintValueWei !== 0n) throw new Error('Robinhood reservations must have zero mint value');
      if (!request.executionId || !request.transactionIntentId) throw new Error('execution reservation requires execution and transaction intent linkage');
      const wallet = this.db.prepare('SELECT chain_profile_id FROM wallet WHERE id = ?').get(request.walletId) as { chain_profile_id: string } | undefined;
      if (!wallet || wallet.chain_profile_id !== request.chainProfileId) throw new Error('reservation chain does not match wallet');
      const campaign = this.db.prepare('SELECT ct.chain_profile_id FROM campaign c JOIN "drop" d ON d.id = c.drop_id JOIN collection col ON col.id = d.collection_id JOIN contract ct ON ct.id = col.contract_id WHERE c.id = ?').get(request.campaignId) as { chain_profile_id: string } | undefined;
      if (!campaign || campaign.chain_profile_id !== request.chainProfileId) throw new Error('reservation chain does not match campaign');
      const membership = this.db.prepare('SELECT enabled FROM campaign_wallet WHERE campaign_id = ? AND wallet_id = ?').get(request.campaignId, request.walletId) as { enabled: number } | undefined;
      if (!membership || membership.enabled !== 1) throw new Error('reservation requires enabled campaign wallet membership');
      const linkage = this.db.prepare('SELECT e.wallet_id AS execution_wallet_id, e.campaign_id AS execution_campaign_id, e.reservation_id, i.wallet_id AS intent_wallet_id, i.campaign_id AS intent_campaign_id, i.chain_profile_id AS intent_chain_profile_id, i.value_wei AS intent_value_wei FROM execution e JOIN transaction_intent i ON i.id = e.transaction_intent_id WHERE e.id = ? AND i.id = ?').get(request.executionId, request.transactionIntentId) as { execution_wallet_id: string; execution_campaign_id: string; reservation_id: string | null; intent_wallet_id: string; intent_campaign_id: string; intent_chain_profile_id: string | null; intent_value_wei: string } | undefined;
      if (!linkage || linkage.execution_wallet_id !== request.walletId || linkage.execution_campaign_id !== request.campaignId || linkage.intent_wallet_id !== request.walletId || linkage.intent_campaign_id !== request.campaignId || linkage.intent_chain_profile_id !== request.chainProfileId) throw new Error('reservation execution and intent linkage mismatch');
      if (BigInt(linkage.intent_value_wei) !== request.mintValueWei) throw new Error('reservation mint value does not match transaction intent');
      if (linkage.reservation_id !== null) throw new Error('execution already has a reservation');
      periodId = request.mintPeriodId ?? `campaign:${request.campaignId}`;
      const period = this.db.prepare('SELECT id FROM campaign_period WHERE id = ? AND campaign_id = ?').get(periodId, request.campaignId) as { id: string } | undefined;
      if (!period) throw new Error('reservation period is not an approved campaign period');
      const policy = this.db.prepare('SELECT daily_cap_wei AS cap, timezone, campaign_cap_wei AS campaignCap, free_mint_wallet_cap_wei AS walletCap, free_mint_period_cap_wei AS periodCap FROM spend_policy WHERE id = ? AND wallet_id = ? AND active = 1').get(request.policyId, request.walletId) as { cap: string; timezone: string; campaignCap: string | null; walletCap: string; periodCap: string } | undefined;
      if (!policy) throw new Error('active spend policy not found');
      usageDate = policyUsageDate(at, policy.timezone);
      const feePolicy = this.db.prepare('SELECT id, version, max_total_fee_wei AS maxFee, free_mint_total_fee_cap_wei AS freeFee, free_mint_priority_fee_component_wei AS component, free_mint_priority_fee_multiplier AS multiplier, paid_mints_enabled AS paid, zero_priority_fee_policy AS zeroPolicy FROM fee_policy WHERE chain_profile_id = ? AND active = 1').get(request.chainProfileId) as { id: string; version: string; maxFee: string; freeFee: string; component: string; multiplier: number; paid: number; zeroPolicy: 'requires_po_resolution' | 'blocked' | 'allowed' } | undefined;
      if (!feePolicy) throw new Error('active fee policy not found');
      if (!request.freeMint && feePolicy.paid !== 1) throw new Error('paid-mint policy is not approved');
      if (request.freeMint !== (request.mintValueWei === 0n)) throw new Error('reservation mint classification does not match transaction intent value');
      if (request.priorityFeeComponentWei === 0n && feePolicy.zeroPolicy === 'blocked') throw new Error('zero-priority-fee policy is blocked');
      if (request.priorityFeeComponentWei === 0n && feePolicy.zeroPolicy !== 'allowed') throw new Error('zero-priority-fee policy requires PO resolution');
      if (request.freeMint && priorityExposure > BigInt(feePolicy.component) * BigInt(feePolicy.multiplier)) throw new Error('priority fee component exceeds free-mint policy');
      const feeCap = BigInt(request.freeMint ? feePolicy.freeFee : feePolicy.maxFee);
      if (feeExposure > feeCap) throw new Error('total fee exceeds policy');
      if (replacementBudgetWei > feeCap) throw new Error('replacement budget exceeds fee policy');
      const computedFingerprint = digest({ walletId: request.walletId, chainProfileId: request.chainProfileId, campaignId: request.campaignId, mintPeriodId: periodId, executionId: request.executionId, transactionIntentId: request.transactionIntentId, policyId: request.policyId, mintClass: request.freeMint ? 'free' : 'paid', mintValueWei: request.mintValueWei.toString(), l2ExecutionGasWei: request.l2ExecutionGasWei.toString(), l1DataGasWei: request.l1DataGasWei.toString(), priorityFeeComponentWei: request.priorityFeeComponentWei.toString(), replacementBudgetWei: replacementBudgetWei.toString(), mintValueBufferWei: mintValueBufferWei.toString(), l2ExecutionGasBufferWei: l2ExecutionGasBufferWei.toString(), l1DataGasBufferWei: l1DataGasBufferWei.toString(), priorityFeeBufferWei: priorityFeeBufferWei.toString(), policySnapshot: request.policySnapshot ?? null, effectiveSpendPolicy: { id: request.policyId, cap: policy.cap, timezone: policy.timezone, campaignCap: policy.campaignCap, walletCap: policy.walletCap, periodCap: policy.periodCap }, effectiveFeePolicy: { id: feePolicy.id, version: feePolicy.version, maxFee: feePolicy.maxFee, freeFee: feePolicy.freeFee, component: feePolicy.component, multiplier: feePolicy.multiplier, paid: feePolicy.paid, zeroPolicy: feePolicy.zeroPolicy }, usageDate });
      if (request.requestFingerprint !== undefined && request.requestFingerprint !== computedFingerprint) throw new ReservationConflictError();
      const existing = this.db.prepare('SELECT status, request_fingerprint FROM spend_reservation WHERE idempotency_key = ?').get(request.idempotencyKey) as { status: ReservationStatus; request_fingerprint: string | null } | undefined;
      if (existing) {
        if (existing.request_fingerprint !== computedFingerprint) throw new ReservationConflictError();
        return existing.status;
      }
      const rows = this.db.prepare("SELECT status, amount_wei, reserved_amount_wei, mint_value_wei, l2_execution_gas_wei, l1_data_gas_wei, priority_fee_component_wei, replacement_budget_wei, mint_value_buffer_wei, l2_execution_gas_buffer_wei, l1_data_gas_buffer_wei, priority_fee_buffer_wei FROM spend_reservation WHERE wallet_id = ? AND usage_date = ? AND status IN ('reserved', 'settled')").all(request.walletId, usageDate) as StoredReservationRow[];
      const used = rows.reduce((total, row) => total + componentExposure(row), 0n);
      if (used + exposure > BigInt(policy.cap)) throw new SpendCapExceededError();
      const scopedRows = this.db.prepare("SELECT status, amount_wei, reserved_amount_wei, mint_value_wei, l2_execution_gas_wei, l1_data_gas_wei, priority_fee_component_wei, replacement_budget_wei, mint_value_buffer_wei, l2_execution_gas_buffer_wei, l1_data_gas_buffer_wei, priority_fee_buffer_wei FROM spend_reservation WHERE wallet_id = ? AND mint_class = 'free' AND status IN ('reserved', 'settled')").all(request.walletId) as StoredReservationRow[];
      const scopedExposure = scopedRows.reduce((total, row) => total + componentExposure(row), 0n);
      if (request.freeMint && scopedExposure + exposure > BigInt(policy.walletCap)) throw new SpendCapExceededError();
      const campaignCap = policy.campaignCap === null ? BigInt(policy.cap) : BigInt(policy.campaignCap);
      const campaignRows = this.db.prepare("SELECT status, amount_wei, reserved_amount_wei, mint_value_wei, l2_execution_gas_wei, l1_data_gas_wei, priority_fee_component_wei, replacement_budget_wei, mint_value_buffer_wei, l2_execution_gas_buffer_wei, l1_data_gas_buffer_wei, priority_fee_buffer_wei FROM spend_reservation WHERE wallet_id = ? AND campaign_id = ? AND status IN ('reserved', 'settled')").all(request.walletId, request.campaignId) as StoredReservationRow[];
      const campaignExposure = campaignRows.reduce((total, row) => total + componentExposure(row), 0n);
      if (campaignExposure + exposure > campaignCap) throw new SpendCapExceededError();
      const periodRows = this.db.prepare("SELECT status, amount_wei, reserved_amount_wei, mint_value_wei, l2_execution_gas_wei, l1_data_gas_wei, priority_fee_component_wei, replacement_budget_wei, mint_value_buffer_wei, l2_execution_gas_buffer_wei, l1_data_gas_buffer_wei, priority_fee_buffer_wei FROM spend_reservation WHERE chain_profile_id = ? AND campaign_id = ? AND mint_period_id = ? AND mint_class = 'free' AND status IN ('reserved', 'settled')").all(request.chainProfileId, request.campaignId, periodId) as StoredReservationRow[];
      const periodExposure = periodRows.reduce((total, row) => total + componentExposure(row), 0n);
      if (request.freeMint && periodExposure + exposure > BigInt(policy.periodCap)) throw new SpendCapExceededError();
      const snapshot = encode(request.policySnapshot ?? { chainProfileId: request.chainProfileId, campaignId: request.campaignId, mintClass: request.freeMint ? 'free' : 'paid', mintValueWei: request.mintValueWei.toString(), l2ExecutionGasWei: request.l2ExecutionGasWei.toString(), l1DataGasWei: request.l1DataGasWei.toString(), priorityFeeComponentWei: request.priorityFeeComponentWei.toString(), replacementBudgetWei: replacementBudgetWei.toString(), mintValueBufferWei: mintValueBufferWei.toString(), l2ExecutionGasBufferWei: l2ExecutionGasBufferWei.toString(), l1DataGasBufferWei: l1DataGasBufferWei.toString(), priorityFeeBufferWei: priorityFeeBufferWei.toString(), feePolicyId: feePolicy.id, feePolicyVersion: feePolicy.version, feePolicyMaxFeeWei: feePolicy.maxFee, feePolicyFreeFeeWei: feePolicy.freeFee, zeroPriorityFeePolicy: feePolicy.zeroPolicy, usageDate });
      const feePolicySnapshot = encode({ id: feePolicy.id, version: feePolicy.version, maxFee: feePolicy.maxFee, freeFee: feePolicy.freeFee, component: feePolicy.component, multiplier: feePolicy.multiplier, paid: feePolicy.paid, zeroPolicy: feePolicy.zeroPolicy });
      this.db.prepare("INSERT INTO spend_reservation (id, wallet_id, execution_id, idempotency_key, request_id, request_fingerprint, policy_id, amount_wei, reserved_amount_wei, usage_date, status, created_at, chain_profile_id, campaign_id, mint_value_wei, l2_execution_gas_wei, l1_data_gas_wei, priority_fee_component_wei, replacement_budget_wei, mint_value_buffer_wei, l2_execution_gas_buffer_wei, l1_data_gas_buffer_wei, priority_fee_buffer_wei, policy_snapshot_json, mint_period_id, transaction_intent_id, mint_class, fee_policy_id, fee_policy_version, fee_policy_snapshot_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(request.id, request.walletId, request.executionId, request.idempotencyKey, request.requestId ?? request.idempotencyKey, computedFingerprint, request.policyId, exposure.toString(), exposure.toString(), usageDate, at.toISOString(), request.chainProfileId, request.campaignId, request.mintValueWei.toString(), request.l2ExecutionGasWei.toString(), request.l1DataGasWei.toString(), request.priorityFeeComponentWei.toString(), replacementBudgetWei.toString(), mintValueBufferWei.toString(), l2ExecutionGasBufferWei.toString(), l1DataGasBufferWei.toString(), priorityFeeBufferWei.toString(), snapshot, periodId, request.transactionIntentId, request.freeMint ? 'free' : 'paid', feePolicy.id, feePolicy.version, feePolicySnapshot);
      const result = this.db.prepare('UPDATE execution SET reservation_id = ? WHERE id = ? AND reservation_id IS NULL').run(request.id, request.executionId);
      if (result.changes !== 1) throw new Error('execution reservation linkage could not be established');
      return 'reserved';
    });
  }

  public settleExecution(id: string, actualMintValueWei: bigint, actualL2ExecutionGasWei: bigint, actualL1DataGasWei: bigint, atOrPriority: Date | bigint = new Date(), priorityOrAt?: bigint | Date, actualReplacementBudgetWei = 0n): void {
    const at = atOrPriority instanceof Date ? atOrPriority : priorityOrAt instanceof Date ? priorityOrAt : new Date();
    const actualPriorityFeeComponentWei = typeof atOrPriority === 'bigint' ? atOrPriority : typeof priorityOrAt === 'bigint' ? priorityOrAt : 0n;
    this.immediate(() => {
      const row = this.db.prepare("SELECT id FROM spend_reservation WHERE id = ? AND status = 'reserved'").get(id) as { id: string } | undefined;
      if (!row) throw new Error('reservation is missing or no longer reservable');
      this.settleExecutionComponentsInTransaction(id, { actualMintValueWei, actualL2ExecutionGasWei, actualL1DataGasWei, actualPriorityFeeComponentWei, actualReplacementBudgetWei }, at);
    });
  }

  public settleExecutionComponents(id: string, components: SettlementComponents, at = new Date()): void {
    this.immediate(() => this.settleExecutionComponentsInTransaction(id, components, at));
  }

  private settleExecutionComponentsInTransaction(id: string, components: SettlementComponents, at: Date): void {
    const actualPriorityFeeComponentWei = components.actualPriorityFeeComponentWei ?? 0n;
    const actualReplacementBudgetWei = components.actualReplacementBudgetWei ?? 0n;
    nonNegative([components.actualMintValueWei, components.actualL2ExecutionGasWei, components.actualL1DataGasWei, actualPriorityFeeComponentWei, actualReplacementBudgetWei], 'settled amounts must be non-negative');
    const row = this.db.prepare("SELECT wallet_id, execution_id, transaction_intent_id, status, amount_wei, reserved_amount_wei, mint_value_wei, l2_execution_gas_wei, l1_data_gas_wei, priority_fee_component_wei, replacement_budget_wei, mint_value_buffer_wei, l2_execution_gas_buffer_wei, l1_data_gas_buffer_wei, priority_fee_buffer_wei FROM spend_reservation WHERE id = ? AND status = 'reserved'").get(id) as { wallet_id: string; execution_id: string | null; transaction_intent_id: string | null; status: ReservationStatus; amount_wei: string; reserved_amount_wei: string; mint_value_wei: string; l2_execution_gas_wei: string; l1_data_gas_wei: string; priority_fee_component_wei: string; replacement_budget_wei: string; mint_value_buffer_wei: string; l2_execution_gas_buffer_wei: string; l1_data_gas_buffer_wei: string; priority_fee_buffer_wei: string } | undefined;
    if (!row) throw new Error('reservation is missing or no longer reservable');
    if (row.execution_id !== null) {
      const latestReceipt = this.db.prepare('SELECT r.id, r.status, r.finality_stage, r.observed_at, c.success_finality_stage, c.execution_enabled FROM transaction_receipt r JOIN transaction_attempt a ON a.id = r.transaction_attempt_id JOIN transaction_intent i ON i.id = a.transaction_intent_id JOIN wallet w ON w.id = i.wallet_id JOIN chain_profile c ON c.id = w.chain_profile_id WHERE a.execution_id = ? AND r.id = (SELECT r2.id FROM transaction_receipt r2 JOIN transaction_attempt a2 ON a2.id = r2.transaction_attempt_id WHERE a2.execution_id = ? ORDER BY r2.observed_at DESC, r2.id DESC LIMIT 1)').get(row.execution_id, row.execution_id) as { id: string; status: string; finality_stage: string; observed_at: string; success_finality_stage: string; execution_enabled: number } | undefined;
      const latestReconciliation = this.db.prepare('SELECT rr.id, rr.state, rr.checked_at FROM reconciliation_record rr WHERE rr.execution_id = ? ORDER BY rr.checked_at DESC, rr.id DESC LIMIT 1').get(row.execution_id) as { id: string; state: string; checked_at: string } | undefined;
      if (!latestReceipt && !latestReconciliation) throw new Error('settlement requires authoritative receipt or reconciliation');
      if (latestReceipt?.status === 'confirmed' && (latestReceipt.execution_enabled !== 1 || latestReceipt.finality_stage !== latestReceipt.success_finality_stage)) throw new Error('settlement requires enabled-chain finality');
      const reconciliationIsLatest = latestReconciliation !== undefined && (latestReceipt === undefined || latestReconciliation.checked_at >= latestReceipt.observed_at);
      if (latestReceipt && !['confirmed', 'reverted', 'reorged', 'dropped'].includes(latestReceipt.status) && (!reconciliationIsLatest || (latestReconciliation.state !== 'final' && latestReconciliation.state !== 'reorged'))) throw new Error('settlement outcome is not authoritative');
      if (latestReconciliation?.state === 'ambiguous') throw new Error('ambiguous reconciliation cannot settle');
      if (components.authoritativeReceiptId !== undefined && components.authoritativeReceiptId !== latestReceipt?.id) throw new Error('settlement receipt is not the latest authoritative receipt');
      if (components.authoritativeReconciliationId !== undefined && components.authoritativeReconciliationId !== latestReconciliation?.id) throw new Error('settlement reconciliation is not the latest authoritative record');
    }
    const mintBound = BigInt(row.mint_value_wei) + BigInt(row.mint_value_buffer_wei);
    const l2Bound = BigInt(row.l2_execution_gas_wei) + BigInt(row.l2_execution_gas_buffer_wei);
    const l1Bound = BigInt(row.l1_data_gas_wei) + BigInt(row.l1_data_gas_buffer_wei);
    const priorityBound = BigInt(row.priority_fee_component_wei) + BigInt(row.priority_fee_buffer_wei);
    const replacementBound = BigInt(row.replacement_budget_wei);
    if (components.actualMintValueWei > mintBound || components.actualL2ExecutionGasWei > l2Bound || components.actualL1DataGasWei > l1Bound || actualPriorityFeeComponentWei > priorityBound || actualReplacementBudgetWei > replacementBound) throw new Error('settled amount exceeds reservation bound');
    const actualTotal = components.actualMintValueWei + components.actualL2ExecutionGasWei + components.actualL1DataGasWei + actualPriorityFeeComponentWei + actualReplacementBudgetWei;
    if (actualTotal > BigInt(row.reserved_amount_wei)) throw new Error('settled amount exceeds all-in reservation');
    this.db.prepare("UPDATE spend_reservation SET status = 'settled', amount_wei = ?, settled_amount_wei = ?, settled_mint_value_wei = ?, settled_l2_execution_gas_wei = ?, settled_l1_data_gas_wei = ?, settled_priority_fee_component_wei = ?, settled_replacement_budget_wei = ?, settled_at = ? WHERE id = ? AND status = 'reserved'").run(actualTotal.toString(), actualTotal.toString(), components.actualMintValueWei.toString(), components.actualL2ExecutionGasWei.toString(), components.actualL1DataGasWei.toString(), actualPriorityFeeComponentWei.toString(), actualReplacementBudgetWei.toString(), at.toISOString(), id);
    const entries = [
      ['mint', 'mint_value', components.actualMintValueWei],
      ['gas', 'l2_execution_gas', components.actualL2ExecutionGasWei],
      ['gas', 'l1_data_gas', components.actualL1DataGasWei],
      ['gas', 'priority_fee', actualPriorityFeeComponentWei],
      ['gas', 'replacement_budget', actualReplacementBudgetWei],
    ] as const;
    const insert = this.db.prepare('INSERT INTO spend_ledger_entry (id, wallet_id, execution_id, reservation_id, entry_type, component, amount_wei, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const [entryType, component, amount] of entries) insert.run(`${id}:settled:${component}`, row.wallet_id, row.execution_id, id, entryType, component, amount.toString(), at.toISOString());
    const refund = BigInt(row.reserved_amount_wei) - actualTotal;
    if (refund > 0n) insert.run(`${id}:settled:refund`, row.wallet_id, row.execution_id, id, 'refund', 'refund', refund.toString(), at.toISOString());
  }
}
