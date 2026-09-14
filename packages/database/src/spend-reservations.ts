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
}

export class SpendCapExceededError extends Error {
  constructor() { super('daily spend cap exceeded'); }
}

export class ReservationConflictError extends Error {
  constructor() { super('idempotency key was reused with a different request fingerprint'); }
}

function encode(value: unknown): string {
  const result = JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);
  if (result !== undefined && /"(?:private[_-]?key|mnemonic|seed(?:[_-]?phrase)?|passphrase|password|api[_-]?key|access[_-]?token|secret[_-]?key|auth[_-]?token)"\s*:/i.test(result)) throw new Error('secret-like values must remain in the approved secret store');
  return result ?? '{}';
}

function digest(value: unknown): string {
  return createHash('sha256').update(encode(value)).digest('hex');
}

function nonNegative(amounts: bigint[], message: string): void {
  if (amounts.some((amount) => amount < 0n)) throw new Error(message);
}

function componentExposure(row: {
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
}): bigint {
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
    const usageDate = at.toISOString().slice(0, 10);
    if (request.idempotencyKey.length === 0) throw new Error('idempotency key must not be empty');
    const requestFingerprint = request.requestFingerprint ?? digest({
      walletId: request.walletId,
      executionId: request.executionId ?? null,
      policyId: request.policyId,
      amountWei: request.amountWei.toString(),
      usageDate,
    });
    return this.immediate(() => {
      if (this.isKillSwitchEngaged()) throw new Error('kill switch engaged');
      if (request.executionId) {
        const execution = this.db.prepare('SELECT wallet_id FROM execution WHERE id = ?').get(request.executionId) as { wallet_id: string } | undefined;
        if (!execution || execution.wallet_id !== request.walletId) throw new Error('reservation execution does not match wallet');
      }
      const existing = this.db.prepare('SELECT status, request_fingerprint FROM spend_reservation WHERE idempotency_key = ?').get(request.idempotencyKey) as { status: ReservationStatus; request_fingerprint: string | null } | undefined;
      if (existing) {
        if (existing.request_fingerprint !== null && existing.request_fingerprint !== requestFingerprint) throw new ReservationConflictError();
        return existing.status;
      }
      const policy = this.db.prepare('SELECT daily_cap_wei AS cap FROM spend_policy WHERE id = ? AND wallet_id = ? AND active = 1').get(request.policyId, request.walletId) as { cap: string } | undefined;
      if (!policy) throw new Error('active spend policy not found');
      const rows = this.db.prepare("SELECT status, amount_wei, reserved_amount_wei, mint_value_wei, l2_execution_gas_wei, l1_data_gas_wei, priority_fee_component_wei, replacement_budget_wei, mint_value_buffer_wei, l2_execution_gas_buffer_wei, l1_data_gas_buffer_wei, priority_fee_buffer_wei FROM spend_reservation WHERE wallet_id = ? AND usage_date = ? AND status IN ('reserved', 'settled')").all(request.walletId, usageDate) as Array<{ status: ReservationStatus; amount_wei: string; reserved_amount_wei: string | null; mint_value_wei: string; l2_execution_gas_wei: string; l1_data_gas_wei: string; priority_fee_component_wei: string; replacement_budget_wei: string | null; mint_value_buffer_wei: string | null; l2_execution_gas_buffer_wei: string | null; l1_data_gas_buffer_wei: string | null; priority_fee_buffer_wei: string | null }>;
      const used = rows.reduce((total, row) => total + componentExposure(row), 0n);
      if (used + request.amountWei > BigInt(policy.cap)) throw new SpendCapExceededError();
      this.db.prepare('INSERT INTO spend_reservation (id, wallet_id, execution_id, idempotency_key, request_id, request_fingerprint, policy_id, amount_wei, reserved_amount_wei, usage_date, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, \'reserved\', ?)').run(request.id, request.walletId, request.executionId ?? null, request.idempotencyKey, request.requestId ?? request.idempotencyKey, requestFingerprint, request.policyId, request.amountWei.toString(), request.amountWei.toString(), usageDate, at.toISOString());
      return 'reserved';
    });
  }

  public transition(id: string, status: Exclude<ReservationStatus, 'reserved'>, at = new Date()): void {
    this.immediate(() => {
      const row = this.db.prepare("SELECT status, amount_wei FROM spend_reservation WHERE id = ? AND status = 'reserved'").get(id) as { status: ReservationStatus; amount_wei: string } | undefined;
      if (!row) throw new Error('reservation is missing or no longer reservable');
      const result = this.db.prepare("UPDATE spend_reservation SET status = ?, settled_at = CASE WHEN ? = 'settled' THEN ? ELSE settled_at END, settled_amount_wei = CASE WHEN ? = 'settled' THEN amount_wei ELSE settled_amount_wei END WHERE id = ? AND status = 'reserved'").run(status, status, at.toISOString(), status, id);
      if (result.changes !== 1) throw new Error('reservation is missing or no longer reservable');
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
    const usageDate = at.toISOString().slice(0, 10);
    const periodId = request.mintPeriodId ?? 'default';
    if (request.idempotencyKey.length === 0) throw new Error('idempotency key must not be empty');
    const priorityExposure = request.priorityFeeComponentWei + priorityFeeBufferWei;
    const feeExposure = request.l2ExecutionGasWei + l2ExecutionGasBufferWei + request.l1DataGasWei + l1DataGasBufferWei + priorityExposure + replacementBudgetWei;
    const exposure = request.mintValueWei + mintValueBufferWei + feeExposure;
    const requestFingerprint = request.requestFingerprint ?? digest({
      walletId: request.walletId,
      chainProfileId: request.chainProfileId,
      campaignId: request.campaignId,
      mintPeriodId: periodId,
      executionId: request.executionId ?? null,
      transactionIntentId: request.transactionIntentId ?? null,
      policyId: request.policyId,
      mintValueWei: request.mintValueWei.toString(),
      l2ExecutionGasWei: request.l2ExecutionGasWei.toString(),
      l1DataGasWei: request.l1DataGasWei.toString(),
      priorityFeeComponentWei: request.priorityFeeComponentWei.toString(),
      replacementBudgetWei: replacementBudgetWei.toString(),
      mintValueBufferWei: mintValueBufferWei.toString(),
      l2ExecutionGasBufferWei: l2ExecutionGasBufferWei.toString(),
      l1DataGasBufferWei: l1DataGasBufferWei.toString(),
      priorityFeeBufferWei: priorityFeeBufferWei.toString(),
      freeMint: request.freeMint,
    });
    if (exposure === 0n) throw new Error('reservation exposure must be positive');
    return this.immediate(() => {
      if (this.isKillSwitchEngaged()) throw new Error('kill switch engaged');
      const chain = this.db.prepare('SELECT chain_id, execution_enabled FROM chain_profile WHERE id = ?').get(request.chainProfileId) as { chain_id: number; execution_enabled: number } | undefined;
      if (!chain) throw new Error('chain profile not found');
      const wallet = this.db.prepare('SELECT chain_profile_id FROM wallet WHERE id = ?').get(request.walletId) as { chain_profile_id: string } | undefined;
      if (!wallet || wallet.chain_profile_id !== request.chainProfileId) throw new Error('reservation chain does not match wallet');
      const campaign = this.db.prepare('SELECT ct.chain_profile_id FROM campaign c JOIN "drop" d ON d.id = c.drop_id JOIN collection col ON col.id = d.collection_id JOIN contract ct ON ct.id = col.contract_id WHERE c.id = ?').get(request.campaignId) as { chain_profile_id: string } | undefined;
      if (!campaign || campaign.chain_profile_id !== request.chainProfileId) throw new Error('reservation chain does not match campaign');
      if (chain.chain_id === 4663 && !request.freeMint) throw new Error('paid Robinhood mints are blocked');
      if (chain.chain_id === 4663 && chain.execution_enabled !== 1) throw new Error('Robinhood execution is disabled');
      if (chain.chain_id === 4663 && request.mintValueWei !== 0n) throw new Error('Robinhood reservations must have zero mint value');
      const existing = this.db.prepare('SELECT status, request_fingerprint FROM spend_reservation WHERE idempotency_key = ?').get(request.idempotencyKey) as { status: ReservationStatus; request_fingerprint: string | null } | undefined;
      if (existing) {
        if (existing.request_fingerprint !== requestFingerprint) throw new ReservationConflictError();
        return existing.status;
      }
      const policy = this.db.prepare('SELECT daily_cap_wei AS cap, free_mint_wallet_cap_wei AS walletCap, free_mint_period_cap_wei AS periodCap FROM spend_policy WHERE id = ? AND wallet_id = ? AND active = 1').get(request.policyId, request.walletId) as { cap: string; walletCap: string; periodCap: string } | undefined;
      if (!policy) throw new Error('active spend policy not found');
      const feePolicy = this.db.prepare('SELECT max_total_fee_wei AS maxFee, free_mint_total_fee_cap_wei AS freeFee, free_mint_priority_fee_component_wei AS component, free_mint_priority_fee_multiplier AS multiplier, paid_mints_enabled AS paid, zero_priority_fee_policy AS zeroPolicy FROM fee_policy WHERE chain_profile_id = ? AND active = 1 ORDER BY rowid DESC LIMIT 1').get(request.chainProfileId) as { maxFee: string; freeFee: string; component: string; multiplier: number; paid: number; zeroPolicy: 'requires_po_resolution' | 'blocked' | 'allowed' } | undefined;
      if (!feePolicy) throw new Error('active fee policy not found');
      if (!request.freeMint && feePolicy.paid !== 1) throw new Error('paid-mint policy is not approved');
      if (priorityExposure === 0n && feePolicy.zeroPolicy === 'blocked') throw new Error('zero-priority-fee policy is blocked');
      if (priorityExposure === 0n && feePolicy.zeroPolicy !== 'allowed') throw new Error('zero-priority-fee policy requires PO resolution');
      if (request.freeMint && priorityExposure > BigInt(feePolicy.component) * BigInt(feePolicy.multiplier)) throw new Error('priority fee component exceeds free-mint policy');
      const feeCap = BigInt(request.freeMint ? feePolicy.freeFee : feePolicy.maxFee);
      if (feeExposure > feeCap) throw new Error('total fee exceeds policy');
      if (replacementBudgetWei > feeCap) throw new Error('replacement budget exceeds fee policy');
      const rows = this.db.prepare("SELECT status, amount_wei, reserved_amount_wei, mint_value_wei, l2_execution_gas_wei, l1_data_gas_wei, priority_fee_component_wei, replacement_budget_wei, mint_value_buffer_wei, l2_execution_gas_buffer_wei, l1_data_gas_buffer_wei, priority_fee_buffer_wei FROM spend_reservation WHERE wallet_id = ? AND usage_date = ? AND status IN ('reserved', 'settled')").all(request.walletId, usageDate) as Array<{ status: ReservationStatus; amount_wei: string; reserved_amount_wei: string | null; mint_value_wei: string; l2_execution_gas_wei: string; l1_data_gas_wei: string; priority_fee_component_wei: string; replacement_budget_wei: string | null; mint_value_buffer_wei: string | null; l2_execution_gas_buffer_wei: string | null; l1_data_gas_buffer_wei: string | null; priority_fee_buffer_wei: string | null }>;
      const used = rows.reduce((total, row) => total + componentExposure(row), 0n);
      if (used + exposure > BigInt(policy.cap)) throw new SpendCapExceededError();
      const scopedRows = this.db.prepare("SELECT status, amount_wei, reserved_amount_wei, mint_value_wei, l2_execution_gas_wei, l1_data_gas_wei, priority_fee_component_wei, replacement_budget_wei, mint_value_buffer_wei, l2_execution_gas_buffer_wei, l1_data_gas_buffer_wei, priority_fee_buffer_wei FROM spend_reservation WHERE wallet_id = ? AND chain_profile_id = ? AND campaign_id = ? AND mint_period_id = ? AND status IN ('reserved', 'settled')").all(request.walletId, request.chainProfileId, request.campaignId, periodId) as Array<{ status: ReservationStatus; amount_wei: string; reserved_amount_wei: string | null; mint_value_wei: string; l2_execution_gas_wei: string; l1_data_gas_wei: string; priority_fee_component_wei: string; replacement_budget_wei: string | null; mint_value_buffer_wei: string | null; l2_execution_gas_buffer_wei: string | null; l1_data_gas_buffer_wei: string | null; priority_fee_buffer_wei: string | null }>;
      const scopedExposure = scopedRows.reduce((total, row) => total + componentExposure(row), 0n);
      if (request.freeMint && scopedExposure + exposure > BigInt(policy.walletCap)) throw new SpendCapExceededError();
      const periodRows = this.db.prepare("SELECT status, amount_wei, reserved_amount_wei, mint_value_wei, l2_execution_gas_wei, l1_data_gas_wei, priority_fee_component_wei, replacement_budget_wei, mint_value_buffer_wei, l2_execution_gas_buffer_wei, l1_data_gas_buffer_wei, priority_fee_buffer_wei FROM spend_reservation WHERE chain_profile_id = ? AND campaign_id = ? AND mint_period_id = ? AND status IN ('reserved', 'settled')").all(request.chainProfileId, request.campaignId, periodId) as Array<{ status: ReservationStatus; amount_wei: string; reserved_amount_wei: string | null; mint_value_wei: string; l2_execution_gas_wei: string; l1_data_gas_wei: string; priority_fee_component_wei: string; replacement_budget_wei: string | null; mint_value_buffer_wei: string | null; l2_execution_gas_buffer_wei: string | null; l1_data_gas_buffer_wei: string | null; priority_fee_buffer_wei: string | null }>;
      const periodExposure = periodRows.reduce((total, row) => total + componentExposure(row), 0n);
      if (request.freeMint && periodExposure + exposure > BigInt(policy.periodCap)) throw new SpendCapExceededError();
      const snapshot = encode(request.policySnapshot ?? { chainProfileId: request.chainProfileId, campaignId: request.campaignId, freeMint: request.freeMint, mintValueWei: request.mintValueWei.toString(), l2ExecutionGasWei: request.l2ExecutionGasWei.toString(), l1DataGasWei: request.l1DataGasWei.toString(), priorityFeeComponentWei: request.priorityFeeComponentWei.toString(), replacementBudgetWei: replacementBudgetWei.toString(), mintValueBufferWei: mintValueBufferWei.toString(), l2ExecutionGasBufferWei: l2ExecutionGasBufferWei.toString(), l1DataGasBufferWei: l1DataGasBufferWei.toString(), priorityFeeBufferWei: priorityFeeBufferWei.toString(), priorityFeeMultiplier: feePolicy.multiplier });
      this.db.prepare("INSERT INTO spend_reservation (id, wallet_id, execution_id, idempotency_key, request_id, request_fingerprint, policy_id, amount_wei, reserved_amount_wei, usage_date, status, created_at, chain_profile_id, campaign_id, mint_value_wei, l2_execution_gas_wei, l1_data_gas_wei, priority_fee_component_wei, replacement_budget_wei, mint_value_buffer_wei, l2_execution_gas_buffer_wei, l1_data_gas_buffer_wei, priority_fee_buffer_wei, policy_snapshot_json, mint_period_id, transaction_intent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(request.id, request.walletId, request.executionId ?? null, request.idempotencyKey, request.requestId ?? request.idempotencyKey, requestFingerprint, request.policyId, exposure.toString(), exposure.toString(), usageDate, at.toISOString(), request.chainProfileId, request.campaignId, request.mintValueWei.toString(), request.l2ExecutionGasWei.toString(), request.l1DataGasWei.toString(), request.priorityFeeComponentWei.toString(), replacementBudgetWei.toString(), mintValueBufferWei.toString(), l2ExecutionGasBufferWei.toString(), l1DataGasBufferWei.toString(), priorityFeeBufferWei.toString(), snapshot, periodId, request.transactionIntentId ?? null);
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
    const row = this.db.prepare("SELECT wallet_id, execution_id, status, amount_wei, reserved_amount_wei, mint_value_wei, l2_execution_gas_wei, l1_data_gas_wei, priority_fee_component_wei, replacement_budget_wei, mint_value_buffer_wei, l2_execution_gas_buffer_wei, l1_data_gas_buffer_wei, priority_fee_buffer_wei FROM spend_reservation WHERE id = ? AND status = 'reserved'").get(id) as { wallet_id: string; execution_id: string | null; status: ReservationStatus; amount_wei: string; reserved_amount_wei: string; mint_value_wei: string; l2_execution_gas_wei: string; l1_data_gas_wei: string; priority_fee_component_wei: string; replacement_budget_wei: string; mint_value_buffer_wei: string; l2_execution_gas_buffer_wei: string; l1_data_gas_buffer_wei: string; priority_fee_buffer_wei: string } | undefined;
    if (!row) throw new Error('reservation is missing or no longer reservable');
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
