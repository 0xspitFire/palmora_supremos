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
  type Hash,
  type Chain,
  type PublicClient,
  createPublicClient,
  http,
  formatEther,
  parseEther,
  parseGwei,
  keccak256,
  serializeTransaction,
  type TransactionSerializableEIP1559,
} from 'viem';
import { randomUUID } from 'node:crypto';
import { mainnet, base } from 'viem/chains';
import type pino from 'pino';

import type {
  MintJobConfig,
  MintJobResult,
  WalletMintResult,
  DropConfig,
  Broadcaster,
  BroadcastResult,
  SupportedChainId,
  SpendReservationProvider,
  EngineLifecycleStore,
  LifecycleReconciliationRecord,
  Signer,
  SignerFactory,
  ExecutionIdentity,
  SimulationEvidence,
  TransactionIntent,
} from './types.js';
import { MintError, MintErrorType } from './types.js';
import { getChainConfig, resolveChainByNameFromSecrets } from './chains.js';
import { FREE_MINT_ACTIVE_PERIOD_RESERVE_CAP_WEI, replacementPriorityBudget, validateFeeBudget, validateFreeMintReserve, validateFreeMintSpend, validatePaidGasExposure, validatePaidQuantity } from './fee-guard.js';
import { readAndValidateDrop, simulateMint, getStrategy } from './drop-reader.js';
import { NonceManagerImpl } from './nonce-manager.js';
import { ReceiptReorgedError, ReceiptTimeoutError, ReceiptWatcherImpl } from './receipt-watcher.js';
import { EthereumFinalityObserver } from './finality-observer.js';
import type { FinalityObserver } from './finality-observer.js';
import { LocalEncryptedSigner } from './signer.js';
import { createBroadcaster } from './broadcasters/index.js';
import { buildFlashbotsAuthSigner } from './flashbots-auth.js';
import { KillSwitch, SpendTracker } from './safety.js';
import { createLogger, childLogger } from './logger.js';
import {
  assertDirectChainExecutionPolicy,
  assertDurableReservationProvider,
  assertSimulationFresh,
  assertTimingWindow,
  actualSettlementComponents,
  broadcastAttemptId,
  canonicalExecutionIdentity,
  classifyBroadcastResult,
  lifecycleStateForFinality,
  reconcileByHashAndNonce,
  reservationCampaignId,
  selectBroadcastAttempt,
  shouldSettleReceipt,
  LifecycleGateError,
} from './lifecycle.js';

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

function redactProviderError(message: string): string {
  return message
    .replace(/https?:\/\/\S+/gi, '[endpoint]')
    .replace(/0x[0-9a-f]{40,}/gi, '[hex]')
    .replace(/(?:private[_-]?key|mnemonic|seed|passphrase|password)\s*[:=]\s*\S+/gi, '[redacted]')
    .slice(0, 240);
}

function lifecycleErrorType(code: string): MintErrorType {
  switch (code) {
    case 'SIMULATION_FAILED': return MintErrorType.SIMULATION_FAILED;
    case 'STALE_SIMULATION': return MintErrorType.STALE_SIMULATION;
    case 'TIMING_GATE': return MintErrorType.TIMING_GATE;
    case 'DURABLE_RESERVATION_REQUIRED': return MintErrorType.DURABLE_RESERVATION_REQUIRED;
    case 'DURABLE_LIFECYCLE_STORE_REQUIRED': return MintErrorType.DURABLE_RESERVATION_REQUIRED;
    case 'PAID_ROBINHOOD_BLOCKED': return MintErrorType.PAID_ROBINHOOD_BLOCKED;
    case 'CHAIN_4663_EXECUTION_DISABLED': return MintErrorType.CHAIN_EXECUTION_DISABLED;
    case 'AMBIGUOUS_SUBMISSION': return MintErrorType.AMBIGUOUS_SUBMISSION;
    case 'INVALID_SIMULATION_FRESHNESS': return MintErrorType.INVALID_CONFIG;
    case 'INVALID_TIMING_GATE': return MintErrorType.INVALID_CONFIG;
    default: return MintErrorType.INVALID_CONFIG;
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

export interface MintEngineOptions {
  reservationProvider?: SpendReservationProvider;
  finalityObserver?: FinalityObserver;
  signerFactory?: SignerFactory;
  lifecycleStore?: EngineLifecycleStore;
  /** Backend's durable run identity. */
  runId?: string;
  /** Backend's durable run intent identity. */
  intentId?: string;
  requestId?: string;
  requestFingerprint?: string;
  /** Override identity allocation when Backend supplies canonical IDs directly. */
  identityForWallet?: (wallet: { index: number; address: Address }, runId: string) => ExecutionIdentity;
  now?: () => Date;
}

export class MintEngine {
  private readonly config: MintJobConfig;
  private readonly logger: pino.Logger;
  private readonly killSwitch: KillSwitch;
  /** Local accounting is a dry-run diagnostic only, never live authorization. */
  private readonly spendTracker?: SpendTracker;
  private readonly reservationProvider?: SpendReservationProvider;
  private readonly finalityObserver?: FinalityObserver;
  private readonly signerFactory: SignerFactory;
  private readonly lifecycleStore?: EngineLifecycleStore;
  private readonly runId?: string;
  private readonly intentId?: string;
  private readonly requestId?: string;
  private readonly requestFingerprint?: string;
  private readonly identityForWallet?: MintEngineOptions['identityForWallet'];
  private readonly now: () => Date;

  constructor(config: MintJobConfig, options?: MintEngineOptions) {
    this.config = config;
    this.logger = createLogger(config.observability.logLevel, config.observability.logFile);
    this.killSwitch = new KillSwitch(config.safety.killSwitchFile, this.logger);
    if (config.safety.dryRun) {
      this.spendTracker = new SpendTracker(
        config.safety.maxSpendEth,
        config.safety.dailySpendCapEth,
        this.logger,
      );
    }
    this.reservationProvider = options?.reservationProvider;
    this.finalityObserver = options?.finalityObserver;
    this.signerFactory = options?.signerFactory ?? ((passphrase) => LocalEncryptedSigner.fromFile(this.config.fleet.walletFile, passphrase));
    this.lifecycleStore = options?.lifecycleStore;
    this.runId = options?.runId;
    this.intentId = options?.intentId;
    this.requestId = options?.requestId;
    this.requestFingerprint = options?.requestFingerprint;
    this.identityForWallet = options?.identityForWallet;
    this.now = options?.now ?? (() => new Date());
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
    const jobId = this.runId ?? `mint-${randomUUID()}`;
    const engineLog = childLogger(this.logger, 'MintEngine', { jobId });
    const startedAt = this.now();

    engineLog.info({ event: 'job_start', config: this.sanitizeConfig() }, 'Mint job starting');

    let signer: Signer | null = null;

    try {
      const configuredChainId = this.config.target.chain === 'ethereum' ? 1 : this.config.target.chain === 'base' ? 8453 : 4663;
      // This runs before any mutable chain registry flag is consulted.
      assertDirectChainExecutionPolicy(configuredChainId, undefined, this.config.safety.dryRun);
      assertDurableReservationProvider(this.reservationProvider, this.config.safety.dryRun);
      if (!this.config.safety.dryRun && (!this.lifecycleStore || this.lifecycleStore.durable !== true || this.lifecycleStore.storeKind !== 'normalized-sqlite')) {
        throw new LifecycleGateError('DURABLE_LIFECYCLE_STORE_REQUIRED', 'admission', 'Live execution requires a normalized durable lifecycle store');
      }
      if (!this.config.safety.dryRun && (!this.runId || !this.intentId || !this.config.target.campaignId)) {
        throw new LifecycleGateError('DURABLE_IDENTITY_REQUIRED', 'admission', 'Live execution requires Backend run, intent, and campaign identities');
      }
      if (this.lifecycleStore) {
        const timestamp = this.now().toISOString();
        await this.lifecycleStore.persistRun({
          runId: jobId,
          requestId: this.requestId ?? jobId,
          requestFingerprint: this.requestFingerprint ?? `${this.config.target.chain}:${this.config.target.contract.toLowerCase()}:${this.config.target.quantity}`,
          campaignId: this.config.target.campaignId ?? `contract:${this.config.target.contract.toLowerCase()}`,
          state: this.config.safety.dryRun ? 'prepared' : 'active',
          createdAt: timestamp,
          updatedAt: timestamp,
        });
      }
      // ── 1. Resolve chain ────────────────────────────────────
      const scope = this.config.broadcast.secretScope ?? 'mainnet';
      const secretRoot = this.config.broadcast.secretRoot ?? 'Rets';
      const chainConfig = await resolveChainByNameFromSecrets(this.config.target.chain, scope, secretRoot);
      const chainId = chainConfig.chainId;
      engineLog.info({ chain: chainConfig.name, chainId }, 'Chain resolved');
      if (!this.config.safety.dryRun && !chainConfig.executionEnabled) {
        throw new MintError(MintErrorType.RPC_ERROR, `Execution is disabled for ${chainConfig.name} by the Phase 1 chain policy`);
      }
      if (!this.config.safety.dryRun && chainConfig.verificationStatus !== 'verified') {
        throw new MintError(MintErrorType.RPC_ERROR, `Execution is blocked for ${chainConfig.name}: chain verification status is "${chainConfig.verificationStatus}"`);
      }

      // Robinhood requires staged finality and integrated operational gates that
      // are not available in this standalone engine path. Fail closed rather
      // than reporting a receipt as product success before Ethereum finality.
      assertDirectChainExecutionPolicy(chainId, undefined, this.config.safety.dryRun);

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
      const mintCostPerWallet = drop.mintPrice * BigInt(this.config.target.quantity);
      assertDirectChainExecutionPolicy(chainId, mintCostPerWallet, this.config.safety.dryRun);
      if (!this.config.safety.dryRun) {
        assertTimingWindow(
          drop.startTime,
          this.now().getTime() / 1000,
          this.config.timing.armBeforeMs,
        );
      }

      // ── 4. Load wallets ─────────────────────────────────────
      this.checkKill();
      signer = await this.signerFactory(passphrase);
      const allWallets = await signer.listWallets();
      const wallets = allWallets.slice(0, this.config.fleet.maxWallets);
      engineLog.info({ walletCount: wallets.length }, 'Wallets loaded');

      // ── 5. Preflight checks ─────────────────────────────────
      this.checkKill();
      const nonceManager = new NonceManagerImpl(publicClient);
      const finalityObserver = this.finalityObserver ?? (chainConfig.chainId === 1
        ? new EthereumFinalityObserver({
          chainId: 1,
          currentBlockNumber: () => publicClient.getBlockNumber(),
          receiptBlockHash: async (hash: Hash) => (await publicClient.getTransactionReceipt({ hash })).blockHash,
        }, chainConfig.confirmationDepth)
        : undefined);
      const receiptWatcher = new ReceiptWatcherImpl(publicClient, {
        maxWaitMs: chainConfig.isL2 ? 30_000 : 120_000,
        finalityPolicy: chainConfig.finalityPolicy,
        ...(finalityObserver ? { finalityObserver } : {}),
      });

      // Check funding
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
        this.checkKill();
        const estimate = await strategy.estimateGas(publicClient, drop, wallet.address, this.config.target.quantity);
        const padded = BigInt(Math.ceil(Number(estimate) * this.config.fees.gasLimitPadding));
        gasLimits.set(wallet.index, padded);
        const simulation = await simulateMint(
          publicClient, strategy, drop, wallet.address,
          this.config.target.quantity, mintCostPerWallet, wallet.index,
        );
        this.checkKill();
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
      let admittedFreeReserveWei = 0n;
      const freeReserveByWallet = new Map<number, bigint>();
      const freeReserveErrorByWallet = new Map<number, string>();
      if (mintCostPerWallet === 0n) {
        for (const wallet of wallets) {
          const gasLimit = gasLimits.get(wallet.index) ?? 0n;
          const l1DataGas = chainConfig.isL2 ? BigInt(Math.ceil(Number(gasLimit) / 16)) : 0n;
          const reserve = gasLimit * parseGwei(this.config.fees.maxFeePerGasGwei.toString()) + l1DataGas;
          const reserveVerdict = validateFreeMintReserve({ perWalletReserveWei: reserve, activePeriodReserveWei: reserve });
          if (!reserveVerdict.allowed) freeReserveErrorByWallet.set(wallet.index, reserveVerdict.reason);
          else freeReserveByWallet.set(wallet.index, reserve);
        }
      }
      for (const wallet of wallets) {
        if (!this.config.safety.dryRun && !simulations.get(wallet.index)?.success) {
          preflightResults.push({ walletIndex: wallet.index, address: wallet.address, status: 'skipped', error: simulations.get(wallet.index)?.error ?? 'Simulation unavailable', simulation: simulations.get(wallet.index), durationMs: 0 });
          continue;
        }
        const walletGasLimit = gasLimits.get(wallet.index) ?? paddedGasLimit;
        const walletMaxCost = mintCostPerWallet + walletGasLimit * parseGwei(this.config.fees.maxFeePerGasGwei.toString()) + (mintCostPerWallet === 0n && chainConfig.isL2 ? BigInt(Math.ceil(Number(walletGasLimit) / 16)) : 0n);
        const balance = await publicClient.getBalance({ address: wallet.address });
        const freeReserve = freeReserveByWallet.get(wallet.index) ?? 0n;
        if (freeReserveErrorByWallet.has(wallet.index)) {
          preflightResults.push({ walletIndex: wallet.index, address: wallet.address, status: 'skipped', error: freeReserveErrorByWallet.get(wallet.index), simulation: simulations.get(wallet.index), durationMs: 0 });
        } else if (mintCostPerWallet === 0n && admittedFreeReserveWei + freeReserve > FREE_MINT_ACTIVE_PERIOD_RESERVE_CAP_WEI) {
          preflightResults.push({ walletIndex: wallet.index, address: wallet.address, status: 'skipped', error: 'FREE-mint active-period reserve cap reached; wallet capacity is not transferable', simulation: simulations.get(wallet.index), durationMs: 0 });
        } else if (balance < walletMaxCost) {
          preflightResults.push({ walletIndex: wallet.index, address: wallet.address, status: 'skipped', error: `Insufficient funds: required ${formatEther(walletMaxCost)} ETH`, simulation: simulations.get(wallet.index), durationMs: 0 });
        } else if (mintCostPerWallet > 0n && admittedMintValueWei + mintCostPerWallet > runMintValueCapWei) {
          preflightResults.push({ walletIndex: wallet.index, address: wallet.address, status: 'skipped', error: `Run mint-value cap reached (${formatEther(runMintValueCapWei)} ETH); wallet capacity is not transferable`, simulation: simulations.get(wallet.index), durationMs: 0 });
        } else {
          fundedWallets.push(wallet);
          admittedMintValueWei += mintCostPerWallet;
          admittedFreeReserveWei += freeReserve;
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
      const totalGasSpent = walletResults.reduce((sum, r) => sum + (r.totalFeeWei ?? (r.gasUsed ?? 0n) * (r.effectiveGasPrice ?? 0n)), 0n);
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
    signer: Signer,
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
    assertDirectChainExecutionPolicy(
      chainId,
      drop.mintPrice * BigInt(this.config.target.quantity),
      this.config.safety.dryRun,
    );
    assertDurableReservationProvider(this.reservationProvider, this.config.safety.dryRun);
    const admissionGate = new AdmissionGate();
    // Concurrent execution with Promise.allSettled (per-wallet isolation)
    const promises = walletIndices.map(async (walletIndex): Promise<WalletMintResult> => {
      const walletLog = childLogger(parentLog, 'WalletMint', { walletIndex });
      const startTime = this.now().getTime();
      let builtNonce: number | undefined;
      const walletInfo = (await signer.listWallets()).find((wallet) => wallet.index === walletIndex);
      if (!walletInfo) throw new Error(`Wallet index ${walletIndex} not found`);
      const walletAddress = walletInfo.address;
      let reservation: import('./types.js').SpendReservation | undefined;
      let releaseAdmission: (() => void) | undefined;
      let submittedHash: import('viem').Hash | undefined;
      let attemptIds: string[] = [];
      let submissionAttemptId: string | undefined;
      let executionId: string | undefined;
      let transactionIntentId: string | undefined;

      try {
        // Check kill switch
        if (this.killSwitch.isKilled()) {
          return {
            walletIndex, address: walletAddress, status: 'killed',
            error: this.killSwitch.getReason(), durationMs: Date.now() - startTime,
          };
        }

        const simulation = simulations.get(walletIndex);
        if (!this.config.safety.dryRun && !simulation?.success) {
          return { walletIndex, address: walletAddress, status: 'skipped', error: simulation?.error ?? 'Simulation unavailable', simulation, durationMs: Date.now() - startTime };
        }

        // Build calldata
        const calldata = strategy.buildCalldata(drop, walletAddress, this.config.target.quantity);
        const nonce = await nonceManager.getNonce(walletAddress);
        builtNonce = nonce;
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

        const identity = this.identityForWallet?.({ index: walletIndex, address: walletAddress }, runId)
          ?? canonicalExecutionIdentity(runId, this.intentId, walletIndex, walletAddress);

        if (this.config.safety.dryRun) {
          const serialized = serializeTransaction(tx);
          walletLog.info({
            event: 'dry_run',
            transactionDigest: keccak256(serialized),
            to: tx.to,
            value: formatEther(value),
            gasLimit: gasLimit.toString(),
          }, '🏜️ DRY RUN — tx built but not sent');

          return {
            walletIndex,
            address: walletAddress,
            status: 'prepared',
            executionId: identity.executionId,
            transactionIntentId: identity.transactionIntentId,
            lifecycleState: 'prepared',
            simulation,
            durationMs: Date.now() - startTime,
          };
        }

        executionId = identity.executionId;
        transactionIntentId = identity.transactionIntentId;
        const intent: TransactionIntent = {
          chainId,
          from: walletAddress,
          to: tx.to!,
          value,
          data: calldata,
          nonce,
          gasLimit,
          maxFeePerGas: tx.maxFeePerGas!,
          maxPriorityFeePerGas: tx.maxPriorityFeePerGas!,
          campaignId: this.config.target.campaignId,
          runId,
          policyRef: this.config.target.policyRef ?? 'phase-1',
        };
        if (!this.config.safety.dryRun) {
          assertSimulationFresh(
            simulation,
            this.now(),
            this.config.timing.simulationFreshnessMs ?? 120_000,
          );
        }
        this.checkKill();
        if (this.lifecycleStore) {
          await this.lifecycleStore.persistIntent({
            id: transactionIntentId,
            executionId,
            intent,
            createdAt: this.now().toISOString(),
          });
        }
        // Serialize the irreversible admission boundary. A kill arriving while
        // another wallet is being signed cannot let this wallet pass unnoticed.
        releaseAdmission = await admissionGate.enter();
        if (this.killSwitch.isKilled()) throw new MintError(MintErrorType.KILLED, 'Kill switch triggered before signing', walletIndex);
        if (!this.reservationProvider) throw new MintError(MintErrorType.DURABLE_RESERVATION_REQUIRED, 'Live execution requires a normalized durable reservation provider', walletIndex);
        this.checkKill();
        reservation = await this.reservationProvider.reserve({
            idempotencyKey: `${transactionIntentId}:reservation`,
            chainId,
            walletIndex,
            address: walletAddress,
            valueWei: value,
            maxGasCostWei: gasLimit * tx.maxFeePerGas!,
            campaignId: reservationCampaignId(this.config.target.campaignId, this.config.target.contract),
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
              policyRef: this.config.target.policyRef ?? 'phase-1',
              chainId,
              freeMint: value === 0n,
              priorityFeeComponentWei: tx.maxPriorityFeePerGas!.toString(),
            },
          });
        this.checkKill();
        const signedTx = await signer.signTransaction(walletIndex, intent);
        this.checkKill();

        walletLog.info({ event: 'tx_signed' }, 'Transaction signed');

        const signedHash = keccak256(signedTx);
        attemptIds = [`${executionId}:attempt:signed`];
        await this.lifecycleStore?.persistAttempt({
          id: attemptIds[0]!,
          executionId,
          transactionIntentId,
          endpoint: 'signer',
          responseClass: 'signed',
          txHash: signedHash,
          nonce,
          attemptedAt: this.now().toISOString(),
        });

        // Broadcast
        if (this.killSwitch.isKilled()) {
          throw new MintError(MintErrorType.KILLED, 'Kill switch triggered before broadcast', walletIndex);
        }
        let broadcastResults: BroadcastResult[];
        try {
          broadcastResults = await broadcaster.broadcast([signedTx], broadcaster.name === 'flashbots'
            ? { targetBlock: (await publicClient.getBlockNumber()) + 1n, maxBumps: this.config.safety.maxReplacementBumps }
            : { maxBumps: this.config.safety.maxReplacementBumps });
          const observed = broadcastResults.find((result) => result.success || result.ambiguous || classifyBroadcastResult(result) === 'ambiguous' || classifyBroadcastResult(result) === 'timeout');
          if (observed) submittedHash = observed.txHash !== '0x' ? observed.txHash : signedHash;
        } catch (error) {
          // A provider exception after signing is indistinguishable from a
          // lost response. Retain the signed hash for hash/nonce recovery.
          submittedHash = signedHash;
          await this.persistReconciliation({
            executionId,
            txHash: signedHash,
            fromAddress: walletAddress,
            nonce,
            state: 'ambiguous',
            source: 'broadcast',
            details: { reason: redactProviderError(error instanceof Error ? error.message : String(error)) },
          });
          if (error instanceof MintError) throw new MintError(error.type, redactProviderError(error.message), error.walletIndex);
          throw new MintError(MintErrorType.PROVIDER_UNAVAILABLE, redactProviderError(error instanceof Error ? error.message : String(error)), walletIndex);
        }
        this.checkKill();
        const attemptIdByResultIndex = new Map<number, string>();
        for (const [resultIndex, result] of broadcastResults.entries()) {
          const responseClass = classifyBroadcastResult(result);
          const resultHash = result.txHash !== '0x' ? result.txHash : undefined;
          const attemptId = broadcastAttemptId(executionId, resultIndex, responseClass);
          attemptIds.push(attemptId);
          attemptIdByResultIndex.set(resultIndex, attemptId);
          await this.lifecycleStore?.persistAttempt({
            id: attemptId,
            executionId,
            transactionIntentId,
            endpoint: result.endpoint,
            responseClass,
            ...(resultHash ? { txHash: resultHash } : {}),
            nonce,
            redactedError: result.error ? redactProviderError(result.error) : undefined,
            attemptedAt: this.now().toISOString(),
          });
        }
        releaseAdmission();
        releaseAdmission = undefined;
        const selectedSubmission = selectBroadcastAttempt(executionId, broadcastResults);
        const successResultIndex = selectedSubmission?.resultIndex ?? -1;
        const successResult = selectedSubmission?.result;

        if (!successResult) {
          const errors = broadcastResults.map((r) => r.error).join('; ');
          const ambiguousResultIndex = broadcastResults.findIndex((r) => r.ambiguous || classifyBroadcastResult(r) === 'ambiguous' || classifyBroadcastResult(r) === 'timeout');
          const ambiguousResult = ambiguousResultIndex >= 0 ? broadcastResults[ambiguousResultIndex] : undefined;
          if (ambiguousResult) {
            submittedHash = ambiguousResult.txHash !== '0x' ? ambiguousResult.txHash : signedHash;
            submissionAttemptId = attemptIdByResultIndex.get(ambiguousResultIndex);
            nonceManager.consumeNonce(walletAddress);
            await this.persistReconciliation({
              executionId,
              transactionAttemptId: attemptIdByResultIndex.get(ambiguousResultIndex),
              txHash: submittedHash,
              fromAddress: walletAddress,
              nonce,
              state: 'ambiguous',
              source: 'broadcast',
              details: { responseClass: classifyBroadcastResult(ambiguousResult), reason: redactProviderError(ambiguousResult.error ?? 'provider response was lost') },
            });
            throw new MintError(MintErrorType.AMBIGUOUS_SUBMISSION, `Broadcast outcome is ambiguous: ${errors}`, walletIndex);
          }
          throw new MintError(MintErrorType.RPC_ERROR, `All broadcast endpoints failed: ${errors}`, walletIndex);
        }

        walletLog.info({
          event: 'tx_broadcast', txHash: successResult.txHash,
          endpoint: successResult.endpoint, latencyMs: successResult.latencyMs,
        }, `Tx broadcast: ${successResult.txHash}`);
        submittedHash = successResult.txHash;
        submissionAttemptId = selectedSubmission?.attemptId ?? attemptIdByResultIndex.get(successResultIndex);

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

        const actualGasCostWei = receipt.gasUsed * receipt.effectiveGasPrice;
        const actualMintValueWei = receipt.status === 'success' ? value : 0n;
        const reconciliation = reconcileByHashAndNonce({
          originalHash: signedHash,
          observedHash: receipt.txHash,
          receiptVisible: true,
          receiptStatus: receipt.status,
          receiptCanonical: true,
        });
        const lifecycleState = lifecycleStateForFinality(chainId, receipt.finalityStage, receipt.status);
        const productSuccess = receipt.status === 'success' && (chainId !== 4663 || receipt.finalityStage === 'ethereum_final');
        const reconciliationState = reconciliation.state === 'matched'
          ? 'matched'
          : reconciliation.state === 'reorged' ? 'reorged' : 'ambiguous';
        await this.lifecycleStore?.persistReceipt({
          id: `${executionId}:receipt:${receipt.blockHash}`,
          executionId,
          transactionAttemptId: submissionAttemptId ?? `${executionId}:attempt:signed`,
          txHash: receipt.txHash,
          status: receipt.status === 'success' ? (productSuccess ? 'confirmed' : 'pending') : 'reverted',
          blockNumber: receipt.blockNumber,
          blockHash: receipt.blockHash,
          confirmations: receipt.confirmations,
          gasUsed: receipt.gasUsed,
          effectiveGasPrice: receipt.effectiveGasPrice,
          ...(receipt.l1DataFeeWei === undefined ? {} : { l1DataFeeWei: receipt.l1DataFeeWei }),
          finalityStage: receipt.finalityStage,
          finalitySource: chainId === 4663 ? 'robinhood-staged-observer' : 'ethereum-confirmation',
          observedAt: this.now().toISOString(),
        });
        await this.persistReconciliation({
          executionId,
          transactionAttemptId: submissionAttemptId,
          txHash: receipt.txHash,
          fromAddress: walletAddress,
          nonce,
          state: reconciliationState,
          source: 'receipt-watcher',
          details: { finalityStage: receipt.finalityStage, reason: reconciliation.reason },
        });
        if (shouldSettleReceipt(chainId, receipt.status, receipt.finalityStage)) {
          const components = {
            ...actualSettlementComponents(
              actualGasCostWei,
              receipt.l1DataFeeWei ?? 0n,
              receipt.priorityFeeComponentWei ?? 0n,
            ),
            actualMintValueWei,
          };
          if (reservation.settleComponents) await reservation.settleComponents(components);
          else await reservation.settle(
            actualMintValueWei,
            actualGasCostWei + (receipt.l1DataFeeWei ?? 0n),
          );
        }

        const actualL1DataFeeWei = receipt.l1DataFeeWei ?? 0n;
        const totalFeeWei = actualGasCostWei + actualL1DataFeeWei;
        // totalCostWei is the all-in amount. L1 is added only when the chain
        // provides an authoritative receipt component.
        const totalCost = totalFeeWei + actualMintValueWei;

        return {
          walletIndex,
          address: walletAddress,
          status: productSuccess ? 'success' : receipt.status === 'reverted' ? 'failed' : 'timeout',
          txHash: receipt.txHash,
          nonce,
          blockNumber: receipt.blockNumber,
          blockHash: receipt.blockHash,
          finalityStage: receipt.finalityStage,
          gasUsed: receipt.gasUsed,
          effectiveGasPrice: receipt.effectiveGasPrice,
          l1DataFeeWei: actualL1DataFeeWei,
          totalFeeWei,
          totalCostWei: totalCost,
          executionId,
          transactionIntentId,
          reservationId: reservation.reservationId,
          attemptIds,
          submittedAttemptId: submissionAttemptId,
          lifecycleState,
          reconciliationState,
          durationMs: this.now().getTime() - startTime,
          error: receipt.status === 'reverted'
            ? 'Transaction reverted on-chain'
            : productSuccess ? undefined : 'Robinhood finality is pending Ethereum finality',
          simulation,
        };

      } catch (err) {
        releaseAdmission?.();
        // A submitted transaction may still be mined after a timeout or RPC
        // error. Keep its reservation for reconciliation; release only work
        // that never crossed the broadcast boundary.
        if (!submittedHash) await reservation?.release();
        const error = err instanceof MintError ? err : err instanceof ReceiptReorgedError
          ? new MintError(MintErrorType.REORGED_TRANSACTION, err.message, walletIndex)
          : err instanceof ReceiptTimeoutError
            ? new MintError(MintErrorType.TIMEOUT, err.message, walletIndex)
          : err instanceof LifecycleGateError
            ? new MintError(lifecycleErrorType(err.code), err.message, walletIndex)
            : new MintError(
              MintErrorType.UNKNOWN,
              err instanceof Error ? err.message : String(err),
              walletIndex,
            );
        let recoveryState: WalletMintResult['reconciliationState'];
        if (submittedHash && executionId && builtNonce !== undefined) {
          let nonceConsumedByDifferentHash = false;
          if (!(err instanceof ReceiptReorgedError)) {
            try {
              nonceConsumedByDifferentHash = (await publicClient.getTransactionCount({ address: walletAddress, blockTag: 'pending' })) > builtNonce;
            } catch {
              // A failed nonce read is itself unresolved; never infer a drop.
            }
          }
          const unresolved = err instanceof ReceiptReorgedError
            ? { state: 'reorged' as const, reason: err.message, blockNumber: err.blockNumber }
            : reconcileByHashAndNonce({
              originalHash: submittedHash,
              observedHash: submittedHash,
              receiptVisible: false,
              nonceConsumedByDifferentHash,
            });
          recoveryState = unresolved.state;
          await this.persistReconciliation({
            executionId,
            transactionAttemptId: submissionAttemptId ?? attemptIds.at(-1),
            txHash: submittedHash,
            fromAddress: walletAddress,
            nonce: builtNonce,
            state: unresolved.state,
            source: error.type === MintErrorType.AMBIGUOUS_SUBMISSION ? 'broadcast' : 'receipt-watcher',
            details: {
              reason: redactProviderError(error.message),
              errorType: error.type,
              ...(err instanceof ReceiptReorgedError ? { blockNumber: err.blockNumber.toString() } : {}),
            },
          });
        }

        walletLog.error({ event: 'wallet_error', errorType: error.type, error: error.message },
          `Wallet ${walletIndex} failed: ${error.message}`);

        return {
          walletIndex,
          address: walletAddress,
          status: submittedHash ? 'timeout' : 'failed',
          ...(submittedHash ? { txHash: submittedHash } : {}),
          nonce: builtNonce,
          ...(executionId ? { executionId } : {}),
          ...(transactionIntentId ? { transactionIntentId } : {}),
          ...(reservation ? { reservationId: reservation.reservationId } : {}),
          ...(attemptIds.length > 0 ? { attemptIds } : {}),
          ...(submissionAttemptId ? { submittedAttemptId: submissionAttemptId } : {}),
          ...(submittedHash
            ? recoveryState === 'reorged'
              ? { lifecycleState: 'reorged' as const, reconciliationState: 'reorged' as const }
              : recoveryState === 'replaced'
                ? { lifecycleState: 'replaced' as const, reconciliationState: 'replaced' as const }
                : recoveryState === 'dropped'
                  ? { lifecycleState: 'dropped' as const, reconciliationState: 'dropped' as const }
                  : { lifecycleState: 'submitted' as const, reconciliationState: recoveryState ?? 'ambiguous' as const }
            : {}),
          error: error.message,
          simulation: simulations.get(walletIndex),
          durationMs: this.now().getTime() - startTime,
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

  private async persistReconciliation(
    record: Omit<LifecycleReconciliationRecord, 'id' | 'checkedAt'> & { transactionAttemptId?: string },
  ): Promise<void> {
    if (!this.lifecycleStore) return;
    const timestamp = this.now().toISOString();
    await this.lifecycleStore.persistReconciliation({
      ...record,
      id: `${record.executionId}:reconciliation:${timestamp}`,
      checkedAt: timestamp,
    });
  }

  /** Programmatic kill switch. */
  kill(reason: string): void {
    this.killSwitch.kill(reason);
  }

  /** Get spend summary. */
  getSpendSummary() {
    return this.spendTracker?.getSummary() ?? {
      mintSpendEth: '0',
      dailySpendEth: '0',
      mintCapEth: this.config.safety.maxSpendEth.toString(),
      dailyCapEth: this.config.safety.dailySpendCapEth.toString(),
    };
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
