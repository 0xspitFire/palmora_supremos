import { randomUUID } from 'node:crypto';
import type { DurableStore } from './store.js';
import type { Reservation } from './types.js';
export class SpendLedger {
  constructor(private readonly store: DurableStore) {}
  async reserve(runId: string, campaignId: string, wallet: string, amountWei: bigint, capWei: bigint, chainId?: 1 | 4663, dailyCapWei?: bigint): Promise<Reservation> {
    return this.store.transaction(state => {
      const exposure = state.reservations.filter(r => r.status !== 'released' && r.campaignId === campaignId).reduce((n, r) => n + BigInt(r.amountWei), 0n);
      if (exposure + amountWei > capWei) throw new Error('SPEND_CAP_EXCEEDED');
      const now = new Date();
      if (chainId !== undefined && dailyCapWei !== undefined) {
        const day = now.toISOString().slice(0, 10);
        const dailyExposure = state.reservations.filter(r => r.status !== 'released' && r.chainId === chainId && r.createdAt.startsWith(day)).reduce((n, r) => n + BigInt(r.amountWei), 0n);
        if (dailyExposure + amountWei > dailyCapWei) throw new Error('DAILY_SPEND_CAP_EXCEEDED');
      }
      const reservation: Reservation = { id: `res_${randomUUID()}`, runId, campaignId, ...(chainId === undefined ? {} : { chainId }), wallet, amountWei, status: 'reserved', createdAt: now.toISOString() };
      state.reservations.push(reservation);
      return reservation;
    });
  }
  async settle(id: string): Promise<void> { await this.change(id, 'settled'); }
  async release(id: string): Promise<void> { await this.change(id, 'released'); }
  available(campaignId: string, capWei: bigint): bigint { const s = this.store.snapshot(); return capWei - s.reservations.filter(r => r.campaignId === campaignId && r.status !== 'released').reduce((n, r) => n + BigInt(r.amountWei), 0n); }
  private async change(id: string, status: Reservation['status']): Promise<void> { await this.store.transaction(state => { const item = state.reservations.find(r => r.id === id); if (!item) throw new Error('RESERVATION_NOT_FOUND'); item.status = status; }); }
}
