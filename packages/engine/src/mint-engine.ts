/**
 * @module mint-engine
 *
 * The MintEngine — core orchestrator for NFT public-mint execution.
 *
 * This is the central component that coordinates:
 * 1. Drop reading + validation (via MintStrategy)
 * 2. Pre-send simulation (T-minus gate)
 * 3. Wallet fleet preflight (funding, nonces, health)
 * 4. Concurrent multi-wallet mint execution
 * 5. Transaction broadcast (via pluggable Broadcaster)
 * 6. Receipt watching + confirmation
 * 7. Spend tracking + kill switch enforcement
 * 8. Structured logging throughout
 *
 * Architecture:
 * - Strategy pattern for mint contract types (SeaDrop, Manifold, raw calldata)
 * - Pluggable broadcaster (public, blast, Flashbots, sequencer)
 * - Per-wallet error isolation — one wallet's failure doesn't kill others
 * - Kill switch checked before every significant operation
 */

import {
  type Address,
  type Chain,
  createPublicClient,
  http,
  formatEther,
  parseGwei,
  serializeTransaction,
  type TransactionSerializableEIP1559,
} from 'viem';
import { mainnet, base } from 'viem/chains';
import type pino from 'pino';

import type {
  MintJobConfig,
  MintJobResult,
  WalletMintResult,
  DropConfig,
  Broadcaster,
  SupportedChainId,
} from './types.js';
import { MintError, MintErrorType } from './types.js';
import { getChainByName, getChainConfig } from './chains.js';
import { readAndValidateDrop, simulateMint, getStrategy } from './drop-reader.js';
import { NonceManagerImpl } from './nonce-manager.js';
import { ReceiptWatcherImpl } from './receipt-watcher.js';
import { LocalEncryptedSigner } from './signer.js';
import { createBroadcaster } from './broadcasters/index.js';
import { KillSwitch, SpendTracker } from './safety.js';
import { createLogger, childLogger } from './logger.js';

// ─────────────────────────────────────────────────────────────
// Viem chain mapping
// ─────────────────────────────────────────────────────────────

function getViemChain(chainId: SupportedChainId): Chain {
  switch (chainId) {
    case 1: return mainnet;
    case 8453: return base;
    case 4663:
      // Robinhood Chain — custom definition until viem adds native support
      return {
        id: 4663,
        name: 'Robinhood',
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: { default: { http: [] } },
      };
    default:
      throw new Error(`No viem chain for chainId ${chainId}`);
  }
}

// ─────────────────────────────────────────────────────────────
// MintEngine
// ─────────────────────────────────────────────────────────────

export class MintEngine {
  private readonly config: MintJobConfig;
  private readonly logger: pino.Logger;
  private readonly killSwitch: KillSwitch;
  private readonly spendTracker: SpendTracker;

  constructor(config: MintJobConfig) {
    this.config = config;
    this.logger = createLogger(config.observability.logLevel, config.observability.logFile);
    this.killSwitch = new KillSwitch(config.safety.killSwitchFile, this.logger);
    this.spendTracker = new SpendTracker(
      config.safety.maxSpendEth,
      config.safety.dailySpendCapEth,
      this.logger,
    );
  }

  /**
   * Execute a full mint job.
   *
   * Lifecycle:
   * 1. Resolve chain + strategy
   * 2. Create RPC client
   * 3. Read + validate drop
   * 4. Load + decrypt wallets
   * 5. Preflight checks (funding, simulation)
   * 6. Wait for mint start (if timing configured)
   * 7. Execute concurrent fleet mint
   * 8. Collect results
   * 9. Zeroize keys
   */
  async execute(passphrase: string): Promise<MintJobResult> {
    const jobId = `mint-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const engineLog = childLogger(this.logger, 'MintEngine', { jobId });
    const startedAt = new Date();

    engineLog.info({ event: 'job_start', config: this.sanitizeConfig() }, 'Mint job starting');

    let signer: LocalEncryptedSigner | null = null;

    try {
      // ── 1. Resolve chain ────────────────────────────────────
      const chainConfig = getChainByName(this.config.target.chain);
      const chainId = chainConfig.chainId;
      engineLog.info({ chain: chainConfig.name, chainId }, 'Chain resolved');

      // ── 2. Create RPC client ────────────────────────────────
      const rpcUrl = this.config.broadcast.rpcEndpoints[0] ?? chainConfig.rpcEndpoints[0];
      if (!rpcUrl) {
        throw new MintError(MintErrorType.RPC_ERROR, 'No RPC endpoint configured');
      }

      const viemChain = getViemChain(chainId);
      const publicClient = createPublicClient({
        chain: viemChain,
        transport: http(rpcUrl),
      });

      engineLog.info({ rpcUrl }, 'RPC client created');

      // ── 3. Read + validate drop ─────────────────────────────
      this.checkKill();
      const strategy = getStrategy(this.config.target.strategy);
      const { drop, validation } = await readAndValidateDrop(
        publicClient,
        this.config.target.contract,
        chainId,
        this.config.target.strategy,
      );

      engineLog.info({
        event: 'drop_read',
        mintPrice: formatEther(drop.mintPrice),
        maxPerWallet: drop.maxTotalMintableByWallet,
        startTime: new Date(drop.startTime * 1000).toISOString(),
        endTime: new Date(drop.endTime * 1000).toISOString(),
        totalMinted: drop.totalMinted.toString(),
        maxSupply: drop.maxTokenSupply.toString(),
      }, `Drop read: ${formatEther(drop.mintPrice)} ETH per token`);

      if (validation.warnings.length > 0) {
        validation.warnings.forEach((w) => engineLog.warn({ event: 'drop_warning' }, w));
      }
      if (!validation.valid) {
        throw new MintError(
          MintErrorType.DROP_NOT_ACTIVE,
          `Drop validation failed: ${validation.errors.join('; ')}`,
        );
      }

      // ── 4. Load wallets ─────────────────────────────────────
      this.checkKill();
      signer = await LocalEncryptedSigner.fromFile(this.config.fleet.walletFile, passphrase);
      const allWallets = await signer.listWallets();
      const wallets = allWallets.slice(0, this.config.fleet.maxWallets);
      engineLog.info({ walletCount: wallets.length }, 'Wallets loaded');

      // ── 5. Preflight checks ─────────────────────────────────
      this.checkKill();
      const nonceManager = new NonceManagerImpl(publicClient);
      const receiptWatcher = new ReceiptWatcherImpl(publicClient, {
        maxWaitMs: chainConfig.isL2 ? 30_000 : 120_000,
      });

      // Check funding
      const mintCostPerWallet = drop.mintPrice * BigInt(this.config.target.quantity);
      const gasLimitEstimate = await strategy.estimateGas(
        publicClient, drop, wallets[0]!.address, this.config.target.quantity,
      );
      const paddedGasLimit = BigInt(Math.ceil(Number(gasLimitEstimate) * this.config.fees.gasLimitPadding));
      const maxGasCostPerWallet = paddedGasLimit * parseGwei(this.config.fees.maxFeePerGasGwei.toString());
      const totalCostPerWallet = mintCostPerWallet + maxGasCostPerWallet;

      engineLog.info({
        event: 'cost_estimate',
        mintCostEth: formatEther(mintCostPerWallet),
        maxGasCostEth: formatEther(maxGasCostPerWallet),
        totalPerWalletEth: formatEther(totalCostPerWallet),
        gasLimit: paddedGasLimit.toString(),
      }, `Cost per wallet: ${formatEther(totalCostPerWallet)} ETH`);

      const fundedWallets: typeof wallets = [];
      for (const wallet of wallets) {
        const balance = await publicClient.getBalance({ address: wallet.address });
        if (balance >= totalCostPerWallet) {
          fundedWallets.push(wallet);
        } else {
          engineLog.warn({
            event: 'wallet_underfunded',
            walletIndex: wallet.index,
            address: wallet.address,
            balance: formatEther(balance),
            required: formatEther(totalCostPerWallet),
          }, `Wallet ${wallet.index} underfunded — skipping`);
        }
      }

      if (fundedWallets.length === 0) {
        throw new MintError(MintErrorType.INSUFFICIENT_FUNDS, 'No wallets have sufficient funds');
      }

      engineLog.info({ fundedCount: fundedWallets.length, total: wallets.length },
        `${fundedWallets.length}/${wallets.length} wallets funded`);

      // Pre-send simulation (T-minus gate — NOT on hot path)
      if (!this.config.safety.dryRun) {
        const simResult = await simulateMint(
          publicClient, strategy, drop, fundedWallets[0]!.address,
          this.config.target.quantity, mintCostPerWallet,
        );
        if (!simResult.success) {
          throw new MintError(MintErrorType.SIMULATION_FAILED, simResult.error ?? 'Simulation failed');
        }
        engineLog.info({ event: 'simulation_passed' }, 'Pre-send simulation passed ✓');
      }

      // ── 6. Create broadcaster ───────────────────────────────
      const broadcaster = createBroadcaster(
        chainConfig,
        this.config.broadcast.mode,
        this.config.broadcast.rpcEndpoints,
      );

      // Warmup connections
      if (broadcaster.warmup) {
        await broadcaster.warmup();
        engineLog.info({ broadcaster: broadcaster.name }, 'Broadcaster connections warmed');
      }

      // ── 7. Execute fleet mint ───────────────────────────────
      this.checkKill();
      engineLog.info({ event: 'fleet_mint_start', walletCount: fundedWallets.length },
        '🚀 Fleet mint starting');

      const walletResults = await this.executeFleet(
        fundedWallets.map((w) => w.index),
        signer,
        strategy,
        drop,
        broadcaster,
        nonceManager,
        receiptWatcher,
        chainConfig.chainId,
        paddedGasLimit,
        engineLog,
      );

      // ── 8. Collect results ──────────────────────────────────
      const successCount = walletResults.filter((r) => r.status === 'success').length;
      const failCount = walletResults.filter((r) => r.status === 'failed').length;
      const totalGasSpent = walletResults.reduce((sum, r) => sum + (r.gasUsed ?? 0n) * (r.effectiveGasPrice ?? 0n), 0n);
      const totalMintCost = mintCostPerWallet * BigInt(successCount);

      const result: MintJobResult = {
        jobId,
        nftContract: this.config.target.contract,
        chainId,
        strategy: this.config.target.strategy,
        startedAt,
        completedAt: new Date(),
        dryRun: this.config.safety.dryRun,
        walletResults,
        totalGasSpentWei: totalGasSpent,
        totalMintCostWei: totalMintCost,
        successCount,
        failCount,
      };

      engineLog.info({
        event: 'job_complete',
        successCount,
        failCount,
        totalGasEth: formatEther(totalGasSpent),
        totalMintCostEth: formatEther(totalMintCost),
        durationMs: result.completedAt.getTime() - result.startedAt.getTime(),
      }, `✅ Mint job complete: ${successCount} succeeded, ${failCount} failed`);

      return result;

    } catch (err) {
      engineLog.error({ event: 'job_error', error: err instanceof Error ? err.message : String(err) },
        'Mint job failed');
      throw err;
    } finally {
      // ── 9. Zeroize keys ─────────────────────────────────────
      if (signer) {
        signer.zeroize();
        engineLog.info({ event: 'keys_zeroized' }, 'Key material zeroized');
      }
    }
  }

  /**
   * Execute mint for all wallets concurrently.
   *
   * Uses Promise.allSettled for per-wallet error isolation.
   * Checks kill switch and spend cap between each wallet's completion.
   */
  private async executeFleet(
    walletIndices: number[],
    signer: LocalEncryptedSigner,
    strategy: ReturnType<typeof getStrategy>,
    drop: DropConfig,
    broadcaster: Broadcaster,
    nonceManager: NonceManagerImpl,
    receiptWatcher: ReceiptWatcherImpl,
    chainId: SupportedChainId,
    gasLimit: bigint,
    parentLog: pino.Logger,
  ): Promise<WalletMintResult[]> {
    // Concurrent execution with Promise.allSettled (per-wallet isolation)
    const promises = walletIndices.map(async (walletIndex): Promise<WalletMintResult> => {
      const walletLog = childLogger(parentLog, 'WalletMint', { walletIndex });
      const startTime = Date.now();
      const walletAddress = signer.getAccount(walletIndex).address;

      try {
        // Check kill switch
        if (this.killSwitch.isKilled()) {
          return {
            walletIndex, address: walletAddress, status: 'killed',
            error: this.killSwitch.getReason(), durationMs: Date.now() - startTime,
          };
        }

        // Check spend cap
        if (this.spendTracker.isCapExceeded()) {
          return {
            walletIndex, address: walletAddress, status: 'skipped',
            error: 'Spend cap exceeded', durationMs: Date.now() - startTime,
          };
        }

        // Build calldata
        const calldata = strategy.buildCalldata(drop, walletAddress, this.config.target.quantity);
        const nonce = await nonceManager.getNonce(walletAddress);
        const value = drop.mintPrice * BigInt(this.config.target.quantity);

        walletLog.info({
          event: 'tx_building', nonce, value: formatEther(value),
        }, `Building tx (nonce: ${nonce})`);

        // Build EIP-1559 transaction
        const tx: TransactionSerializableEIP1559 = {
          type: 'eip1559',
          chainId,
          nonce,
          to: drop.extra?.['seaDropAddress'] as Address ?? drop.nftContract,
          value,
          data: calldata,
          gas: gasLimit,
          maxFeePerGas: parseGwei(this.config.fees.maxFeePerGasGwei.toString()),
          maxPriorityFeePerGas: parseGwei(this.config.fees.maxPriorityFeePerGasGwei.toString()),
        };

        if (this.config.safety.dryRun) {
          const serialized = serializeTransaction(tx);
          walletLog.info({
            event: 'dry_run',
            serializedTx: serialized,
            to: tx.to,
            value: formatEther(value),
            gasLimit: gasLimit.toString(),
          }, '🏜️ DRY RUN — tx built but not sent');

          nonceManager.consumeNonce(walletAddress);
          return {
            walletIndex, address: walletAddress, status: 'success',
            durationMs: Date.now() - startTime,
          };
        }

        // Sign transaction
        const account = signer.getAccount(walletIndex);
        const signedTx = await account.signTransaction(tx);

        walletLog.info({ event: 'tx_signed' }, 'Transaction signed');

        // Broadcast
        const broadcastResults = await broadcaster.broadcast([signedTx]);
        const successResult = broadcastResults.find((r) => r.success);

        if (!successResult) {
          const errors = broadcastResults.map((r) => r.error).join('; ');
          throw new MintError(MintErrorType.RPC_ERROR, `All broadcast endpoints failed: ${errors}`, walletIndex);
        }

        walletLog.info({
          event: 'tx_broadcast', txHash: successResult.txHash,
          endpoint: successResult.endpoint, latencyMs: successResult.latencyMs,
        }, `Tx broadcast: ${successResult.txHash}`);

        nonceManager.consumeNonce(walletAddress);

        // Wait for receipt
        const chainConfig = getChainConfig(chainId);
        const receipt = await receiptWatcher.waitForReceipt(
          successResult.txHash,
          chainConfig.confirmationDepth,
        );

        walletLog.info({
          event: 'tx_confirmed', txHash: receipt.txHash, status: receipt.status,
          blockNumber: receipt.blockNumber.toString(), gasUsed: receipt.gasUsed.toString(),
          effectiveGasPrice: receipt.effectiveGasPrice.toString(),
        }, `Tx confirmed: ${receipt.status} in block ${receipt.blockNumber}`);

        // Record spend
        this.spendTracker.recordSpend(receipt.gasUsed, receipt.effectiveGasPrice, value);

        const totalCost = receipt.gasUsed * receipt.effectiveGasPrice + value;

        return {
          walletIndex,
          address: walletAddress,
          status: receipt.status === 'success' ? 'success' : 'failed',
          txHash: receipt.txHash,
          gasUsed: receipt.gasUsed,
          effectiveGasPrice: receipt.effectiveGasPrice,
          totalCostWei: totalCost,
          durationMs: Date.now() - startTime,
          error: receipt.status === 'reverted' ? 'Transaction reverted on-chain' : undefined,
        };

      } catch (err) {
        const error = err instanceof MintError ? err : new MintError(
          MintErrorType.UNKNOWN,
          err instanceof Error ? err.message : String(err),
          walletIndex,
        );

        walletLog.error({ event: 'wallet_error', errorType: error.type, error: error.message },
          `Wallet ${walletIndex} failed: ${error.message}`);

        return {
          walletIndex,
          address: walletAddress,
          status: 'failed',
          error: error.message,
          durationMs: Date.now() - startTime,
        };
      }
    });

    const settled = await Promise.allSettled(promises);

    return settled.map((result, index) => {
      if (result.status === 'fulfilled') {
        return result.value;
      }
      // This shouldn't happen since we catch inside, but safety net
      return {
        walletIndex: walletIndices[index]!,
        address: '0x' as Address,
        status: 'failed' as const,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        durationMs: 0,
      };
    });
  }

  /** Programmatic kill switch. */
  kill(reason: string): void {
    this.killSwitch.kill(reason);
  }

  /** Get spend summary. */
  getSpendSummary() {
    return this.spendTracker.getSummary();
  }

  /** Check kill switch — throws if killed. */
  private checkKill(): void {
    if (this.killSwitch.isKilled()) {
      throw new MintError(
        MintErrorType.KILLED,
        `Kill switch triggered: ${this.killSwitch.getReason()}`,
      );
    }
  }

  /** Return config with sensitive fields redacted (for logging). */
  private sanitizeConfig(): Record<string, unknown> {
    return {
      target: this.config.target,
      fleet: { maxWallets: this.config.fleet.maxWallets },
      timing: this.config.timing,
      fees: this.config.fees,
      safety: {
        ...this.config.safety,
        killSwitchFile: '***',
      },
      broadcast: {
        mode: this.config.broadcast.mode,
        endpointCount: this.config.broadcast.rpcEndpoints.length,
      },
    };
  }
}
