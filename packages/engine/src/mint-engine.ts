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
  type PublicClient,
  createPublicClient,
  http,
  formatEther,
  parseEther,
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
  SpendReservationProvider,
  SimulationEvidence,
  TransactionIntent,
} from './types.js';
import { MintError, MintErrorType } from './types.js';
import { getChainConfig, resolveChainByNameFromSecrets } from './chains.js';
import { replacementPriorityBudget, validateFeeBudget, validateFreeMintSpend, validatePaidGasExposure, validatePaidQuantity } from './fee-guard.js';
import { readAndValidateDrop, simulateMint, getStrategy } from './drop-reader.js';
import { NonceManagerImpl } from './nonce-manager.js';
import { ReceiptWatcherImpl } from './receipt-watcher.js';
import { LocalEncryptedSigner } from './signer.js';
import { createBroadcaster } from './broadcasters/index.js';
import { buildFlashbotsAuthSigner } from './flashbots-auth.js';
import { KillSwitch, SpendTracker } from './safety.js';
import { createLogger, childLogger } from './logger.js';

class AdmissionGate {
  private tail: Promise<void> = Promise.resolve();

  async enter(): Promise<() => void> {
    let release!: () => void;
    const turn = new Promise<void>((resolve) => { release = resolve; });
    const previous = this.tail;
    this.tail = previous.then(() => turn);
    await previous;
    return release;
  }
}

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
  private readonly reservationProvider?: SpendReservationProvider;

  constructor(config: MintJobConfig, options?: { reservationProvider?: SpendReservationProvider }) {
    this.config = config;
    this.logger = createLogger(config.observability.logLevel, config.observability.logFile);
    this.killSwitch = new KillSwitch(config.safety.killSwitchFile, this.logger);
    this.spendTracker = new SpendTracker(
      config.safety.maxSpendEth,
      config.safety.dailySpendCapEth,
      this.logger,
    );
    this.reservationProvider = options?.reservationProvider;
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
      const scope = this.config.broadcast.secretScope ?? 'mainnet';
      const secretRoot = this.config.broadcast.secretRoot ?? 'Rets';
      const chainConfig = await resolveChainByNameFromSecrets(this.config.target.chain, scope, secretRoot);
      const chainId = chainConfig.chainId;
      engineLog.info({ chain: chainConfig.name, chainId }, 'Chain resolved');
if (!chainConfig.executionEnabled) {
        throw new MintError(MintErrorType.RPC_ERROR, `Execution is disabled for ${chainConfig.name} by the Phase 1 chain policy`);
      }
      if (chainConfig.verificationStatus !== 'verified') {
        throw new MintError(MintErrorType.RPC_ERROR, `Execution is blocked for ${chainConfig.name}: chain verification status is "${chainConfig.verificationStatus}"`);
      }

      // ── 2. Create RPC client ────────────────────────────────
      const rpcUrl = this.config.broadcast.rpcEndpoints[0] ?? chainConfig.rpcEndpoints[0];
      if (!rpcUrl) {
        throw new MintError(MintErrorType.RPC_ERROR, `No RPC endpoint configured for ${chainConfig.name}; configure the approved secret reference before execution`);
      }

      const viemChain = getViemChain(chainId);
      const publicClient = createPublicClient({
        chain: viemChain,
        transport: http(rpcUrl),
      }) as PublicClient;

      const observedChainId = await publicClient.getChainId();
      if (observedChainId !== chainId) {
        throw new MintError(MintErrorType.RPC_ERROR, `RPC chain mismatch: expected ${chainId}, observed ${observedChainId}`);
      }

      engineLog.info({ endpointConfigured: true }, 'RPC client created');

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
      if (mintCostPerWallet > 0n) {
        const quantityPolicy = validatePaidQuantity({
          requestedQuantity: this.config.target.quantity,
          contractWalletLimit: drop.maxTotalMintableByWallet,
          configuredWalletLimit: this.config.safety.paidMaxQuantityPerWallet,
        });
        if (!quantityPolicy.allowed) {
          throw new MintError(MintErrorType.INVALID_CONFIG, quantityPolicy.reason);
        }
        if (!this.reservationProvider && !this.config.safety.dryRun) {
          throw new MintError(MintErrorType.INVALID_CONFIG, 'Paid live execution requires a durable spend reservation provider');
        }
        const paidRunCapEth = this.config.safety.paidRunMintValueCapEth ?? 0.3;
        if (!Number.isFinite(paidRunCapEth) || paidRunCapEth <= 0) {
          throw new MintError(MintErrorType.INVALID_CONFIG, 'Paid run mint-value cap must be greater than zero');
        }
      }
      const gasLimits = new Map<number, bigint>();
      const simulations = new Map<number, SimulationEvidence>();
      for (const wallet of wallets) {
        const estimate = await strategy.estimateGas(publicClient, drop, wallet.address, this.config.target.quantity);
        const padded = BigInt(Math.ceil(Number(estimate) * this.config.fees.gasLimitPadding));
        gasLimits.set(wallet.index, padded);
        const simulation = await simulateMint(
          publicClient, strategy, drop, wallet.address,
          this.config.target.quantity, mintCostPerWallet, wallet.index,
        );
        simulations.set(wallet.index, { ...simulation, gasEstimate: estimate });
        if (!this.config.safety.dryRun && !simulation.success) {
          engineLog.warn({ event: 'wallet_simulation_failed', walletIndex: wallet.index, error: simulation.error }, 'Wallet simulation failed — skipping');
        }
      }
const gasLimitEstimate = gasLimits.get(wallets[0]?.index ?? -1) ?? 0n;
      const paddedGasLimit = gasLimitEstimate;
      const maxGasCostPerWallet = paddedGasLimit * parseGwei(this.config.fees.maxFeePerGasGwei.toString());
      const totalCostPerWallet = mintCostPerWallet + maxGasCostPerWallet;

      // Free-mint budget guard. The priority fee alone is NOT the total cost:
      // type-2 L2 execution charges gas + (base+priority) and an L1 data fee.
      const budgetVerdict = validateFeeBudget({
        valueWei: mintCostPerWallet,
        maxFeePerGasWei: parseGwei(this.config.fees.maxFeePerGasGwei.toString()),
        gasLimit: paddedGasLimit,
        // Robinhood/Base charge an L1 data fee. When undeclared, require the
        // operator to have supplied a bound via the config that covers it.
        l1DataFeeAllowanceWei: chainConfig.isL2 ? BigInt(Math.ceil(Number(paddedGasLimit) / 16)) : 0n,
      });
      if (!budgetVerdict.ok) {
        throw new MintError(MintErrorType.INVALID_CONFIG, `Fee budget refuses to arm: ${budgetVerdict.reason}`);
      }
      if (mintCostPerWallet === 0n) {
        const freeExposure = validateFreeMintSpend({
          configuredPriorityFeeWei: parseGwei(this.config.fees.maxPriorityFeePerGasGwei.toString()),
          actualPriorityComponentWei: 0n,
          l2ExecutionGasReservationWei: maxGasCostPerWallet,
          l1DataGasReservationWei: chainConfig.isL2 ? BigInt(Math.ceil(Number(paddedGasLimit) / 16)) : 0n,
        });
        if (freeExposure.status !== 'ok') {
          throw new MintError(MintErrorType.INVALID_CONFIG, 'FREE-mint fee exposure policy rejected the configuration');
        }
        engineLog.info({
          event: 'free_mint_exposure_reserved',
          priorityComponentCapWei: freeExposure.priorityComponentCapWei.toString(),
          l2ExecutionGasReservationWei: freeExposure.l2ExecutionGasReservationWei.toString(),
          l1DataGasReservationWei: freeExposure.l1DataGasReservationWei.toString(),
        }, 'FREE-mint exposure validated with independent gas reservations');
      }
      if (mintCostPerWallet > 0n) {
        for (const gasLimit of gasLimits.values()) {
          const exposure = validatePaidGasExposure({
            gasLimit,
            configuredPriorityFeeWei: parseGwei(this.config.fees.maxPriorityFeePerGasGwei.toString()),
            actualPriorityComponentWei: 0n,
            l1DataGasReservationWei: chainConfig.isL2 ? BigInt(Math.ceil(Number(gasLimit) / 16)) : 0n,
          });
          if (!exposure.allowed) throw new MintError(MintErrorType.INVALID_CONFIG, exposure.reason);
        }
      }
      engineLog.info({ feeBudgetOk: true, worstCaseTotalEth: formatEther(budgetVerdict.worstCaseTotalWei) }, 'Fee budget validated');

      engineLog.info({
        event: 'cost_estimate',
        mintCostEth: formatEther(mintCostPerWallet),
        maxGasCostEth: formatEther(maxGasCostPerWallet),
        totalPerWalletEth: formatEther(totalCostPerWallet),
        gasLimit: paddedGasLimit.toString(),
      }, `Cost per wallet: ${formatEther(totalCostPerWallet)} ETH`);

      const preflightResults: WalletMintResult[] = [];
      const fundedWallets: typeof wallets = [];
      const runMintValueCapWei = parseEther((this.config.safety.paidRunMintValueCapEth ?? 0.3).toString());
      let admittedMintValueWei = 0n;
      for (const wallet of wallets) {
        if (!this.config.safety.dryRun && !simulations.get(wallet.index)?.success) {
          preflightResults.push({ walletIndex: wallet.index, address: wallet.address, status: 'skipped', error: simulations.get(wallet.index)?.error ?? 'Simulation unavailable', simulation: simulations.get(wallet.index), durationMs: 0 });
          continue;
        }
        const walletGasLimit = gasLimits.get(wallet.index) ?? paddedGasLimit;
        const walletMaxCost = mintCostPerWallet + walletGasLimit * parseGwei(this.config.fees.maxFeePerGasGwei.toString());
        const balance = await publicClient.getBalance({ address: wallet.address });
        if (balance < walletMaxCost) {
          preflightResults.push({ walletIndex: wallet.index, address: wallet.address, status: 'skipped', error: `Insufficient funds: required ${formatEther(walletMaxCost)} ETH`, simulation: simulations.get(wallet.index), durationMs: 0 });
        } else if (mintCostPerWallet > 0n && admittedMintValueWei + mintCostPerWallet > runMintValueCapWei) {
          preflightResults.push({ walletIndex: wallet.index, address: wallet.address, status: 'skipped', error: `Run mint-value cap reached (${formatEther(runMintValueCapWei)} ETH); wallet capacity is not transferable`, simulation: simulations.get(wallet.index), durationMs: 0 });
        } else {
          fundedWallets.push(wallet);
          admittedMintValueWei += mintCostPerWallet;
        }
      }

      if (fundedWallets.length === 0) {
        throw new MintError(MintErrorType.INSUFFICIENT_FUNDS, 'No wallets have sufficient funds');
      }

      engineLog.info({ fundedCount: fundedWallets.length, total: wallets.length },
        `${fundedWallets.length}/${wallets.length} wallets funded`);

      engineLog.info({ event: 'simulation_passed', walletCount: simulations.size }, 'Per-wallet setup simulation complete');

// ── 6. Create broadcaster ───────────────────────────────
      let flashbotsAuth = this.config.broadcast.flashbotsAuthSigner;
      if (
        !flashbotsAuth &&
        !chainConfig.isL2 &&
        (this.config.broadcast.mode === 'auto' || this.config.broadcast.mode === 'flashbots') &&
        scope === 'mainnet'
      ) {
        // Resolve the dedicated relay-auth signer from the approved key-path
        // reference. Raw keys must never enter configuration or logs.
        flashbotsAuth = await buildFlashbotsAuthSigner('FLASHBOTS_KEY_PATH', scope, secretRoot);
      }
      const broadcaster = createBroadcaster(
        chainConfig,
        this.config.broadcast.mode,
        this.config.broadcast.rpcEndpoints,
        flashbotsAuth
          ? { flashbots: { authSigner: flashbotsAuth, relayUrl: chainConfig.flashbotsRelayUrl } }
          : undefined,
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

      const executedWalletResults = await this.executeFleet(
        jobId,
        fundedWallets.map((w) => w.index),
        signer,
        publicClient,
        strategy,
        drop,
        broadcaster,
        nonceManager,
        receiptWatcher,
        chainConfig.chainId,
        gasLimits,
        simulations,
        engineLog,
      );
      const walletResults = [...preflightResults, ...executedWalletResults];

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
    runId: string,
    walletIndices: number[],
    signer: LocalEncryptedSigner,
    publicClient: PublicClient,
    strategy: ReturnType<typeof getStrategy>,
    drop: DropConfig,
    broadcaster: Broadcaster,
    nonceManager: NonceManagerImpl,
    receiptWatcher: ReceiptWatcherImpl,
    chainId: SupportedChainId,
    gasLimits: Map<number, bigint>,
    simulations: Map<number, SimulationEvidence>,
    parentLog: pino.Logger,
  ): Promise<WalletMintResult[]> {
    const admissionGate = new AdmissionGate();
    // Concurrent execution with Promise.allSettled (per-wallet isolation)
    const promises = walletIndices.map(async (walletIndex): Promise<WalletMintResult> => {
      const walletLog = childLogger(parentLog, 'WalletMint', { walletIndex });
      const startTime = Date.now();
      const walletInfo = (await signer.listWallets()).find((wallet) => wallet.index === walletIndex);
      if (!walletInfo) throw new Error(`Wallet index ${walletIndex} not found`);
      const walletAddress = walletInfo.address;
      let reservation: import('./types.js').SpendReservation | undefined;
      let releaseAdmission: (() => void) | undefined;

      try {
        // Check kill switch
        if (this.killSwitch.isKilled()) {
          return {
            walletIndex, address: walletAddress, status: 'killed',
            error: this.killSwitch.getReason(), durationMs: Date.now() - startTime,
          };
        }

        // Check spend cap
        if (!this.reservationProvider && this.spendTracker.isCapExceeded()) {
          return {
            walletIndex, address: walletAddress, status: 'skipped',
            error: 'Spend cap exceeded', durationMs: Date.now() - startTime,
          };
        }

        const simulation = simulations.get(walletIndex);
        if (!this.config.safety.dryRun && !simulation?.success) {
          return { walletIndex, address: walletAddress, status: 'skipped', error: simulation?.error ?? 'Simulation unavailable', simulation, durationMs: Date.now() - startTime };
        }

        // Build calldata
        const calldata = strategy.buildCalldata(drop, walletAddress, this.config.target.quantity);
        const nonce = await nonceManager.getNonce(walletAddress);
        const value = drop.mintPrice * BigInt(this.config.target.quantity);

        walletLog.info({
          event: 'tx_building', nonce, value: formatEther(value),
        }, `Building tx (nonce: ${nonce})`);

        // Build EIP-1559 transaction
        const gasLimit = gasLimits.get(walletIndex) ?? 0n;
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

          return {
            walletIndex, address: walletAddress, status: 'prepared', simulation,
            durationMs: Date.now() - startTime,
          };
        }

        const executionId = `${runId}:wallet:${walletIndex}`;
        const transactionIntentId = `${executionId}:intent`;
        const intent: TransactionIntent = { chainId, from: walletAddress, to: tx.to!, value, data: calldata, nonce, gasLimit, maxFeePerGas: tx.maxFeePerGas!, maxPriorityFeePerGas: tx.maxPriorityFeePerGas!, runId, policyRef: 'phase-1' };
        // Serialize the irreversible admission boundary. A kill arriving while
        // another wallet is being signed cannot let this wallet pass unnoticed.
        releaseAdmission = await admissionGate.enter();
        if (this.killSwitch.isKilled()) throw new MintError(MintErrorType.KILLED, 'Kill switch triggered before signing', walletIndex);
        reservation = this.reservationProvider
          ? await this.reservationProvider.reserve({
            idempotencyKey: `${transactionIntentId}:reservation`,
            chainId,
            walletIndex,
            address: walletAddress,
            valueWei: value,
            maxGasCostWei: gasLimit * tx.maxFeePerGas!,
            campaignId: `contract:${this.config.target.contract.toLowerCase()}`,
            runId,
            executionId,
            transactionIntentId,
            mintValueWei: value,
            l2ExecutionGasWei: gasLimit * tx.maxFeePerGas!,
            l1DataGasWei: chainId === 4663 ? BigInt(Math.ceil(Number(gasLimit) / 16)) : 0n,
            priorityFeeComponentWei: tx.maxPriorityFeePerGas!,
            replacementBudgetWei: replacementPriorityBudget(tx.maxPriorityFeePerGas!),
            freeMint: value === 0n,
            policySnapshot: {
              policyRef: 'phase-1',
              chainId,
              freeMint: value === 0n,
              priorityFeeComponentWei: tx.maxPriorityFeePerGas!.toString(),
            },
          })
          : undefined;
        const signedTx = await signer.signTransaction(walletIndex, intent);

        walletLog.info({ event: 'tx_signed' }, 'Transaction signed');

        // Broadcast
        if (this.killSwitch.isKilled()) {
          throw new MintError(MintErrorType.KILLED, 'Kill switch triggered before broadcast', walletIndex);
        }
        const broadcastResults = await broadcaster.broadcast([signedTx], broadcaster.name === 'flashbots'
          ? { targetBlock: (await publicClient.getBlockNumber()) + 1n, maxBumps: this.config.safety.maxReplacementBumps }
          : { maxBumps: this.config.safety.maxReplacementBumps });
        releaseAdmission();
        releaseAdmission = undefined;
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
        if (!this.reservationProvider) this.spendTracker.recordSpend(receipt.gasUsed, receipt.effectiveGasPrice, value);
        await reservation?.settle(value, receipt.gasUsed * receipt.effectiveGasPrice);

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
          simulation,
        };

      } catch (err) {
        releaseAdmission?.();
        await reservation?.release();
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
          simulation: simulations.get(walletIndex),
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
