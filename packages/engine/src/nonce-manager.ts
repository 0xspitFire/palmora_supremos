/**
 * @module nonce-manager
 *
 * Per-wallet nonce tracking with local increment and chain re-fetch.
 *
 * Design decisions:
 * - Each wallet has its own nonce counter (no cross-wallet coupling)
 * - First call fetches from chain via eth_getTransactionCount("pending")
 * - Subsequent calls use the local counter (faster, no RPC round-trip)
 * - resetNonce() re-fetches from chain (used after NONCE_TOO_LOW errors)
 * - Thread-safe via per-wallet mutex (Promise-based lock)
 *
 * This is critical for multi-wallet fleet concurrency — nonce collisions
 * would cause all transactions after the first to fail.
 */

import type { Address, PublicClient } from 'viem';
import type { NonceManager as INonceManager } from './types.js';

/** Simple promise-based mutex for per-wallet synchronization. */
class Mutex {
  private _locked = false;
  private _queue: Array<() => void> = [];

  async acquire(): Promise<void> {
    if (!this._locked) {
      this._locked = true;
      return;
    }
    return new Promise<void>((resolve) => {
      this._queue.push(resolve);
    });
  }

  release(): void {
    if (this._queue.length > 0) {
      const next = this._queue.shift()!;
      next();
    } else {
      this._locked = false;
    }
  }
}

interface WalletNonceState {
  currentNonce: number;
  initialized: boolean;
  mutex: Mutex;
}

export class NonceManagerImpl implements INonceManager {
  private readonly wallets = new Map<Address, WalletNonceState>();
  private readonly client: PublicClient;

  constructor(client: PublicClient) {
    this.client = client;
  }

  async getNonce(address: Address): Promise<number> {
    const state = this.getOrCreateState(address);
    await state.mutex.acquire();

    try {
      if (!state.initialized) {
        // First call — fetch from chain
        const chainNonce = await this.client.getTransactionCount({
          address,
          blockTag: 'pending',
        });
        state.currentNonce = chainNonce;
        state.initialized = true;
      }
      return state.currentNonce;
    } finally {
      state.mutex.release();
    }
  }

  consumeNonce(address: Address): void {
    const state = this.wallets.get(address);
    if (!state || !state.initialized) {
      throw new Error(
        `Cannot consume nonce for ${address} — getNonce() hasn't been called yet.`
      );
    }
    state.currentNonce++;
  }

  async resetNonce(address: Address): Promise<number> {
    const state = this.getOrCreateState(address);
    await state.mutex.acquire();

    try {
      const chainNonce = await this.client.getTransactionCount({
        address,
        blockTag: 'pending',
      });
      state.currentNonce = chainNonce;
      state.initialized = true;
      return chainNonce;
    } finally {
      state.mutex.release();
    }
  }

  private getOrCreateState(address: Address): WalletNonceState {
    let state = this.wallets.get(address);
    if (!state) {
      state = {
        currentNonce: 0,
        initialized: false,
        mutex: new Mutex(),
      };
      this.wallets.set(address, state);
    }
    return state;
  }
}
