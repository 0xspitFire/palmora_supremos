/**
 * @module safety
 *
 * Kill switch + spend tracking — P0 safety mechanisms.
 *
 * Kill Switch (§6 correction #10):
 * - File-based: if the killswitch file exists, abort immediately.
 *   Simplest possible mechanism — works even if the API is down.
 * - Programmatic: engine.kill() callable from orchestrator.
 *
 * Spend Tracking:
 * - Running total of (gasUsed × effectiveGasPrice) + mintPrice per wallet
 * - Per-mint hard cap (maxSpendEth)
 * - Daily cumulative cap (dailySpendCapEth)
 * - Abort remaining wallets if either cap is exceeded
 */

import { existsSync } from 'node:fs';
import { formatEther, parseEther } from 'viem';
import type pino from 'pino';

// ─────────────────────────────────────────────────────────────
// Kill Switch
// ─────────────────────────────────────────────────────────────

export class KillSwitch {
  private killed = false;
  private killReason?: string;
  private readonly killSwitchFile: string;
  private readonly logger: pino.Logger;

  constructor(killSwitchFile: string, logger: pino.Logger) {
    this.killSwitchFile = killSwitchFile;
    this.logger = logger;
  }

  /** Check if the kill switch has been triggered. */
  isKilled(): boolean {
    if (this.killed) return true;

    // Check file-based kill switch
    if (this.killSwitchFile && existsSync(this.killSwitchFile)) {
      this.killed = true;
      this.killReason = `Kill switch file detected: ${this.killSwitchFile}`;
      this.logger.warn({ event: 'kill_switch_triggered', reason: this.killReason },
        'KILL SWITCH TRIGGERED — aborting all operations');
      return true;
    }

    return false;
  }

  /** Programmatically trigger the kill switch. */
  kill(reason: string): void {
    this.killed = true;
    this.killReason = reason;
    this.logger.warn({ event: 'kill_switch_triggered', reason },
      'KILL SWITCH TRIGGERED — aborting all operations');
  }

  /** Get the kill reason, if killed. */
  getReason(): string | undefined {
    return this.killReason;
  }

  /** Reset the kill switch (for testing). */
  reset(): void {
    this.killed = false;
    this.killReason = undefined;
  }
}

// ─────────────────────────────────────────────────────────────
// Spend Tracker
// ─────────────────────────────────────────────────────────────

export class SpendTracker {
  private mintSpendWei = 0n;
  private dailySpendWei = 0n;
  private readonly maxMintSpendWei: bigint;
  private readonly maxDailySpendWei: bigint;
  private readonly logger: pino.Logger;

  constructor(
    maxSpendEth: number,
    dailySpendCapEth: number,
    logger: pino.Logger,
  ) {
    this.maxMintSpendWei = parseEther(maxSpendEth.toString());
    this.maxDailySpendWei = parseEther(dailySpendCapEth.toString());
    this.logger = logger;
  }

  /**
   * Record spend for a wallet's transaction.
   * Returns true if spend is within caps, false if a cap is exceeded.
   */
  recordSpend(gasUsed: bigint, effectiveGasPrice: bigint, mintPrice: bigint): boolean {
    const gasCost = gasUsed * effectiveGasPrice;
    const totalCost = gasCost + mintPrice;

    this.mintSpendWei += totalCost;
    this.dailySpendWei += totalCost;

    this.logger.info({
      event: 'spend_recorded',
      gasCostEth: formatEther(gasCost),
      mintPriceEth: formatEther(mintPrice),
      totalCostEth: formatEther(totalCost),
      mintCumulativeEth: formatEther(this.mintSpendWei),
      dailyCumulativeEth: formatEther(this.dailySpendWei),
    }, `Spend recorded: ${formatEther(totalCost)} ETH`);

    return !this.isCapExceeded();
  }

  /** Check if any spend cap is exceeded. */
  isCapExceeded(): boolean {
    if (this.mintSpendWei > this.maxMintSpendWei) {
      this.logger.error({
        event: 'mint_spend_cap_exceeded',
        currentEth: formatEther(this.mintSpendWei),
        capEth: formatEther(this.maxMintSpendWei),
      }, 'MINT SPEND CAP EXCEEDED — aborting remaining wallets');
      return true;
    }

    if (this.dailySpendWei > this.maxDailySpendWei) {
      this.logger.error({
        event: 'daily_spend_cap_exceeded',
        currentEth: formatEther(this.dailySpendWei),
        capEth: formatEther(this.maxDailySpendWei),
      }, 'DAILY SPEND CAP EXCEEDED — refusing to arm new jobs');
      return true;
    }

    return false;
  }

  /** Get current spend summary. */
  getSummary(): { mintSpendEth: string; dailySpendEth: string; mintCapEth: string; dailyCapEth: string } {
    return {
      mintSpendEth: formatEther(this.mintSpendWei),
      dailySpendEth: formatEther(this.dailySpendWei),
      mintCapEth: formatEther(this.maxMintSpendWei),
      dailyCapEth: formatEther(this.maxDailySpendWei),
    };
  }
}
