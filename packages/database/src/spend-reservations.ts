import type { SqliteDatabase } from './database.js';

export type ReservationStatus = 'reserved' | 'settled' | 'released' | 'expired';

export interface ReservationRequest {
  id: string;
  walletId: string;
  executionId?: string;
  idempotencyKey: string;
  policyId: string;
  amountWei: bigint;
  at?: Date;
}

export interface ExecutionReservationRequest {
  id: string;
  walletId: string;
  chainProfileId: string;
  campaignId: string;
  idempotencyKey: string;
  policyId: string;
  mintValueWei: bigint;
  l2ExecutionGasWei: bigint;
  l1DataGasWei: bigint;
  priorityFeeComponentWei: bigint;
  freeMint: boolean;
  policySnapshot?: unknown;
  at?: Date;
}

export class SpendCapExceededError extends Error {
  constructor() { super('daily spend cap exceeded'); }
}

export class SpendReservations {
  public constructor(private readonly db: SqliteDatabase) {}

  public reserve(request: ReservationRequest): ReservationStatus {
    const at = request.at ?? new Date();
    const usageDate = at.toISOString().slice(0, 10);
    const reserve = this.db.transaction((): ReservationStatus => {
      const existing = this.db.prepare('SELECT status FROM spend_reservation WHERE idempotency_key = ?').get(request.idempotencyKey) as { status: ReservationStatus } | undefined;
      if (existing) return existing.status;
      const policy = this.db.prepare('SELECT daily_cap_wei AS cap FROM spend_policy WHERE id = ? AND wallet_id = ? AND active = 1').get(request.policyId, request.walletId) as { cap: string } | undefined;
      if (!policy) throw new Error('active spend policy not found');
      const amounts = this.db.prepare("SELECT amount_wei FROM spend_reservation WHERE wallet_id = ? AND usage_date = ? AND status IN ('reserved', 'settled')").all(request.walletId, usageDate) as Array<{ amount_wei: string }>;
      const used = amounts.reduce((total, row) => total + BigInt(row.amount_wei), 0n);
      if (used + request.amountWei > BigInt(policy.cap)) throw new SpendCapExceededError();
      this.db.prepare('INSERT INTO spend_reservation (id, wallet_id, execution_id, idempotency_key, policy_id, amount_wei, usage_date, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, \'reserved\', ?)').run(request.id, request.walletId, request.executionId ?? null, request.idempotencyKey, request.policyId, request.amountWei.toString(), usageDate, at.toISOString());
      return 'reserved';
    });
    return reserve();
  }

  public transition(id: string, status: Exclude<ReservationStatus, 'reserved'>, at = new Date()): void {
    const result = this.db.prepare("UPDATE spend_reservation SET status = ?, settled_at = CASE WHEN ? = 'settled' THEN ? ELSE settled_at END WHERE id = ? AND status = 'reserved'").run(status, status, at.toISOString(), id);
    if (result.changes !== 1) throw new Error('reservation is missing or no longer reservable');
  }

  public reserveExecution(request: ExecutionReservationRequest): ReservationStatus {
    const amounts = [request.mintValueWei, request.l2ExecutionGasWei, request.l1DataGasWei, request.priorityFeeComponentWei];
    if (amounts.some((amount) => amount < 0n)) throw new Error('reservation amounts must be non-negative');
    const at = request.at ?? new Date();
    const usageDate = at.toISOString().slice(0, 10);
    const reserve = this.db.transaction((): ReservationStatus => {
      const existing = this.db.prepare('SELECT status FROM spend_reservation WHERE idempotency_key = ?').get(request.idempotencyKey) as { status: ReservationStatus } | undefined;
      if (existing) return existing.status;
      const policy = this.db.prepare('SELECT daily_cap_wei AS cap FROM spend_policy WHERE id = ? AND wallet_id = ? AND active = 1').get(request.policyId, request.walletId) as { cap: string } | undefined;
      if (!policy) throw new Error('active spend policy not found');
      const feePolicy = this.db.prepare('SELECT free_mint_priority_fee_component_wei AS component, free_mint_priority_fee_multiplier AS multiplier, paid_mints_enabled AS paid FROM fee_policy WHERE chain_profile_id = ? AND active = 1 ORDER BY rowid DESC LIMIT 1').get(request.chainProfileId) as { component: string; multiplier: number; paid: number } | undefined;
      if (!feePolicy) throw new Error('active fee policy not found');
      if (!request.freeMint && feePolicy.paid !== 1) throw new Error('paid-mint policy is not approved');
      if (request.freeMint && request.priorityFeeComponentWei > BigInt(feePolicy.component) * BigInt(feePolicy.multiplier)) throw new Error('priority fee component exceeds free-mint policy');
      const exposure = request.mintValueWei + request.l2ExecutionGasWei + request.l1DataGasWei;
      const rows = this.db.prepare("SELECT mint_value_wei, l2_execution_gas_wei, l1_data_gas_wei, amount_wei FROM spend_reservation WHERE wallet_id = ? AND usage_date = ? AND status IN ('reserved', 'settled')").all(request.walletId, usageDate) as Array<{ mint_value_wei: string; l2_execution_gas_wei: string; l1_data_gas_wei: string; amount_wei: string }>;
      const used = rows.reduce((total, row) => total + (row.mint_value_wei === '0' && row.l2_execution_gas_wei === '0' && row.l1_data_gas_wei === '0' ? BigInt(row.amount_wei) : BigInt(row.mint_value_wei) + BigInt(row.l2_execution_gas_wei) + BigInt(row.l1_data_gas_wei)), 0n);
      if (used + exposure > BigInt(policy.cap)) throw new SpendCapExceededError();
      const snapshot = JSON.stringify(request.policySnapshot ?? { chainProfileId: request.chainProfileId, campaignId: request.campaignId, freeMint: request.freeMint, priorityFeeComponentWei: request.priorityFeeComponentWei.toString(), priorityFeeMultiplier: feePolicy.multiplier, mintValueWei: request.mintValueWei.toString(), l2ExecutionGasWei: request.l2ExecutionGasWei.toString(), l1DataGasWei: request.l1DataGasWei.toString() });
      this.db.prepare("INSERT INTO spend_reservation (id, wallet_id, idempotency_key, policy_id, amount_wei, usage_date, status, created_at, chain_profile_id, campaign_id, mint_value_wei, l2_execution_gas_wei, l1_data_gas_wei, priority_fee_component_wei, policy_snapshot_json) VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?, ?, ?, ?, ?, ?)").run(request.id, request.walletId, request.idempotencyKey, request.policyId, exposure.toString(), usageDate, at.toISOString(), request.chainProfileId, request.campaignId, request.mintValueWei.toString(), request.l2ExecutionGasWei.toString(), request.l1DataGasWei.toString(), request.priorityFeeComponentWei.toString(), snapshot);
      return 'reserved';
    });
    return reserve();
  }

  public settleExecution(id: string, actualMintValueWei: bigint, actualL2ExecutionGasWei: bigint, actualL1DataGasWei: bigint, at = new Date()): void {
    if ([actualMintValueWei, actualL2ExecutionGasWei, actualL1DataGasWei].some((amount) => amount < 0n)) throw new Error('settled amounts must be non-negative');
    const result = this.db.prepare("UPDATE spend_reservation SET status = 'settled', amount_wei = ?, settled_at = ? WHERE id = ? AND status = 'reserved'").run((actualMintValueWei + actualL2ExecutionGasWei + actualL1DataGasWei).toString(), at.toISOString(), id);
    if (result.changes !== 1) throw new Error('reservation is missing or no longer reservable');
  }
}
