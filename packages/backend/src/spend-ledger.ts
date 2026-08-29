import { randomUUID } from 'node:crypto';
import type { BackendStore } from './store.js';
import type { BackendState, Reservation } from './types.js';
export class SpendLedger {
  constructor(private readonly store: BackendStore) {}
  async reserve(runId: string, campaignId: string, wallet: string, amountWei: bigint, capWei: bigint, chainId?: 1 | 4663, dailyCapWei?: bigint): Promise<Reservation> {
    return (await this.reserveBatch(runId, campaignId, [wallet], amountWei, capWei, chainId, dailyCapWei))[0]!;
  }
  async reserveBatch(runId: string, campaignId: string, wallets: readonly string[], amountWei: bigint, capWei: bigint, chainId?: 1 | 4663, dailyCapWei?: bigint, beforeReserve?: (state: BackendState) => void): Promise<Reservation[]> {
    if (wallets.length === 0) throw new Error('EMPTY_RESERVATION_BATCH');
    if (amountWei < 0n || capWei < 0n || (dailyCapWei !== undefined && dailyCapWei < 0n)) throw new Error('INVALID_SPEND_AMOUNT');
    if (new Set(wallets.map(wallet => wallet.toLowerCase())).size !== wallets.length) throw new Error('DUPLICATE_WALLET');
    return this.store.transaction(state => {
      beforeReserve?.(state);
      if (state.reservations.some(item => item.runId === runId && item.status !== 'released')) throw new Error('RUN_ALREADY_RESERVED');
      const exposure = state.reservations.filter(r => r.status !== 'released' && r.runId === runId).reduce((n, r) => n + BigInt(r.amountWei), 0n);
      const batchAmount = amountWei * BigInt(wallets.length);
      if (exposure + batchAmount > capWei) throw new Error('SPEND_CAP_EXCEEDED');
      const now = new Date();
      const accountingDate = now.toISOString().slice(0, 10);
      if (chainId !== undefined && dailyCapWei !== undefined) {
        const dailyExposure = state.reservations.filter(r => r.status !== 'released' && r.chainId === chainId && r.accountingDate === accountingDate).reduce((n, r) => n + BigInt(r.amountWei), 0n);
        if (dailyExposure + batchAmount > dailyCapWei) throw new Error('DAILY_SPEND_CAP_EXCEEDED');
      }
      const reservations = wallets.map(wallet => ({ id: `res_${randomUUID()}`, runId, campaignId, ...(chainId === undefined ? {} : { chainId }), wallet, amountWei, accountingDate, status: 'reserved' as const, createdAt: now.toISOString(), updatedAt: now.toISOString() }));
      state.reservations.push(...reservations);
      return reservations;
    });
  }
  async settle(id: string, actualAmountWei?: bigint): Promise<void> { await this.change(id, 'settled', actualAmountWei); }
  async release(id: string): Promise<void> { await this.change(id, 'released'); }
  available(runId: string, capWei: bigint): bigint { const s = this.store.snapshot(); return capWei - s.reservations.filter(r => r.runId === runId && r.status !== 'released').reduce((n, r) => n + BigInt(r.amountWei), 0n); }
  private async change(id: string, status: Reservation['status'], actualAmountWei?: bigint): Promise<void> { await this.store.transaction(state => { const item = state.reservations.find(r => r.id === id); if (!item) throw new Error('RESERVATION_NOT_FOUND'); if (item.status !== 'reserved') throw new Error('INVALID_RESERVATION_TRANSITION'); if (actualAmountWei !== undefined && (actualAmountWei < 0n || actualAmountWei > item.amountWei)) throw new Error('INVALID_SETTLEMENT_AMOUNT'); item.status = status; item.updatedAt = new Date().toISOString(); if (status === 'settled') item.actualAmountWei = actualAmountWei ?? item.amountWei; }); }
}
