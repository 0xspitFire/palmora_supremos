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
 * - Strategy pattern for mint contract types (today: SeaDrop v1 public only; no raw-calldata path, D-006)
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
import { exceedsRunReserveCap, freeMintReserveCapsForChain, replacementPriorityBudget, validateFeeBudget, validateFreeMintReserve, validateFreeMintSpend, validatePaidGasExposure, validatePaidQuantity } from './fee-guard.js';
import { readAndValidateDrop, simulateMint, getStrategy } from './drop-reader.js';
import { CAMPAIGN_CHANGED_MID_RUN, createDropRecheck } from './drop-recheck.js';
import { assertSignedMatchesIntent, reserveThenSign, robinhoodL1DataGasWei } from './pre-sign.js';
import { runReplacementLadder, type LadderDeps } from './replacement-ladder.js';
import { ceilingWithinPolicy, requiredCeiling, type Fees } from './replacement-policy.js';
import { quoteBaseFeeBound } from './base-fees.js';
import { NonceManagerImpl } from './nonce-manager.js';
import { ReceiptReorgedError, ReceiptTimeoutError, ReceiptWatcherImpl } from './receipt-watcher.js';
import { BaseFinalityObserver, EthereumFinalityObserver, IndependentBaseFinalityObserver } from './finality-observer.js';
import type { FinalityObserver } from './finality-observer.js';
import { LocalEncryptedSigner } from './signer.js';
import { createBroadcaster } from './broadcasters/index.js';
import { selectFleetWallets } from './fleet-selection.js';
import { buildFlashbotsAuthSigner } from './flashbots-auth.js';
import { assertBaseProviderAgreement, type BaseAgreementClient } from './base-provider-agreement.js';
import { KillSwitch, SpendTracker } from './safety.js';
import { failoverTransport } from './rpc-transport.js';
import { createLogger, childLogger } from './logger.js';
import { safeEndpointReference } from './endpoint-reference.js';
import {
  assertDirectChainExecutionPolicy,
  authorizedBaseExecutionProfile,
  authorizedRobinhoodExecutionProfile,
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
    case 'CHAIN_8453_EXECUTION_DISABLED': return MintErrorType.CHAIN_EXECUTION_DISABLED;
    case 'PAID_BASE_BLOCKED': return MintErrorType.CHAIN_EXECUTION_DISABLED;
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

/** viem throws this when a transaction has no receipt yet; any other error means the answer is unknown. */
function isReceiptNotFound(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  return name === 'TransactionReceiptNotFoundError' || /could not be found/i.test(error instanceof Error ? error.message : '');
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
  /** T-094: executions whose replacement ladder already ran in this process. A ladder never starts twice for one execution, so its bump count cannot be reset. */
  private readonly laddersStarted = new Set<string>();

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
      assertDirectChainExecutionPolicy(configuredChainId, undefined, this.config.safety.dryRun, this.config.safety.robinhoodGrant, this.now(), this.config.safety.baseGrant);
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
      // The admission assertion above has already proved that the relevant
      // grant exists *and is current*.  Do not turn mere object presence into
      // an authorization signal here: an expired object must never bypass the
      // registry's disabled flag.
      const ownerGrantAuthorized = !this.config.safety.dryRun && (chainId === 8453 || chainId === 4663);
      if (!this.config.safety.dryRun && !chainConfig.executionEnabled && !ownerGrantAuthorized) {
        throw new MintError(MintErrorType.RPC_ERROR, `Execution is disabled for ${chainConfig.name} by the Phase 1 chain policy`);
      }
      if (!this.config.safety.dryRun && chainConfig.verificationStatus !== 'verified' && !ownerGrantAuthorized) {
        throw new MintError(MintErrorType.RPC_ERROR, `Execution is blocked for ${chainConfig.name}: chain verification status is "${chainConfig.verificationStatus}"`);
      }

      // Robinhood requires staged finality and integrated operational gates that
      // are not available in this standalone engine path. Fail closed rather
      // than reporting a receipt as product success before Ethereum finality.
      assertDirectChainExecutionPolicy(chainId, undefined, this.config.safety.dryRun, this.config.safety.robinhoodGrant, this.now(), this.config.safety.baseGrant);

      // ── 2. Create RPC client ────────────────────────────────
      const rpcUrl = this.config.broadcast.rpcEndpoints[0] ?? chainConfig.rpcEndpoints[0];
      if (!rpcUrl) {
        throw new MintError(MintErrorType.RPC_ERROR, `No RPC endpoint configured for ${chainConfig.name}; configure the approved secret reference before execution`);
      }

      const viemChain = getViemChain(chainId);
      const baseFallbackUrl = chainId === 8453
        ? this.config.broadcast.rpcEndpoints[1] ?? chainConfig.rpcEndpoints.find((endpoint) => endpoint !== rpcUrl)
        : undefined;
      // Reads fail over to the next configured provider on a timeout or failure. On Base the independent cross-check provider is
      // kept out of that list, so the agreement check never asks the same provider twice.
      const readEndpoints = [...new Set([rpcUrl, ...this.config.broadcast.rpcEndpoints, ...chainConfig.rpcEndpoints])].filter((endpoint) => endpoint !== baseFallbackUrl);
      const publicClient = createPublicClient({
        chain: viemChain,
        transport: failoverTransport(readEndpoints),
      }) as PublicClient;
      if (chainId === 8453 && !this.config.safety.dryRun && (!baseFallbackUrl || baseFallbackUrl === rpcUrl)) {
        throw new MintError(MintErrorType.RPC_ERROR, 'Base live execution requires an independent fallback RPC');
      }
      const baseFallbackClient = baseFallbackUrl
        ? createPublicClient({ chain: viemChain, transport: http(baseFallbackUrl) }) as PublicClient
        : undefined;

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
        this.now(),
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
      assertDirectChainExecutionPolicy(chainId, mintCostPerWallet, this.config.safety.dryRun, this.config.safety.robinhoodGrant, this.now(), this.config.safety.baseGrant);
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
      const wallets = selectFleetWallets(allWallets, this.config.fleet);
      engineLog.info({ walletCount: wallets.length }, 'Wallets loaded');

      if (chainId === 8453 && !this.config.safety.dryRun) {
        await assertBaseProviderAgreement(
          publicClient as unknown as BaseAgreementClient,
          baseFallbackClient as unknown as BaseAgreementClient,
          wallets.map((wallet) => wallet.address),
        );
      }

      // ── 5. Preflight checks ─────────────────────────────────
      this.checkKill();
      const nonceManager = new NonceManagerImpl(publicClient);
      const finalityObserver = this.finalityObserver ?? (chainConfig.chainId === 1
        ? new EthereumFinalityObserver({
          chainId: 1,
          currentBlockNumber: () => publicClient.getBlockNumber(),
          receiptBlockHash: async (hash: Hash) => (await publicClient.getTransactionReceipt({ hash })).blockHash,
          canonicalBlockHash: async (blockNumber: bigint) => (await publicClient.getBlock({ blockNumber })).hash,
        }, chainConfig.confirmationDepth)
        : chainConfig.chainId === 8453
          ? new IndependentBaseFinalityObserver(
            new BaseFinalityObserver({ chainId: 8453, currentBlockNumber: () => publicClient.getBlockNumber(), receiptBlockHash: async (hash: Hash) => (await publicClient.getTransactionReceipt({ hash })).blockHash, canonicalBlockHash: async (blockNumber: bigint) => (await publicClient.getBlock({ blockNumber })).hash, safeBlockNumber: async () => (await publicClient.getBlock({ blockTag: 'safe' })).number, finalizedBlockNumber: async () => (await publicClient.getBlock({ blockTag: 'finalized' })).number }),
            new BaseFinalityObserver({ chainId: 8453, currentBlockNumber: () => baseFallbackClient!.getBlockNumber(), receiptBlockHash: async (hash: Hash) => (await baseFallbackClient!.getTransactionReceipt({ hash })).blockHash, canonicalBlockHash: async (blockNumber: bigint) => (await baseFallbackClient!.getBlock({ blockNumber })).hash, safeBlockNumber: async () => (await baseFallbackClient!.getBlock({ blockTag: 'safe' })).number, finalizedBlockNumber: async () => (await baseFallbackClient!.getBlock({ blockTag: 'finalized' })).number }),
          )
        : undefined);
      const receiptWatcher = new ReceiptWatcherImpl(publicClient, {
        chainId: chainConfig.chainId,
        maxWaitMs: chainConfig.isL2 ? 30_000 : 120_000,
        finalityPolicy: chainConfig.finalityPolicy,
        ...(finalityObserver ? { finalityObserver } : {}),
        ...(baseFallbackClient ? { baseFallbackClient } : {}),
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
          this.config.target.quantity, mintCostPerWallet, wallet.index, this.now(),
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
        l1DataFeeAllowanceWei: chainConfig.chainId === 4663 ? robinhoodL1DataGasWei(paddedGasLimit, parseGwei(this.config.fees.maxFeePerGasGwei.toString())) : 0n,
      });
      if (!budgetVerdict.ok) {
        throw new MintError(MintErrorType.INVALID_CONFIG, `Fee budget refuses to arm: ${budgetVerdict.reason}`);
      }
      if (mintCostPerWallet === 0n) {
        const freeExposure = validateFreeMintSpend({
          configuredPriorityFeeWei: parseGwei(this.config.fees.maxPriorityFeePerGasGwei.toString()),
          actualPriorityComponentWei: 0n,
          l2ExecutionGasReservationWei: maxGasCostPerWallet,
          l1DataGasReservationWei: chainConfig.chainId === 4663 ? robinhoodL1DataGasWei(paddedGasLimit, parseGwei(this.config.fees.maxFeePerGasGwei.toString())) : 0n,
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
            l1DataGasReservationWei: chainConfig.chainId === 4663 ? robinhoodL1DataGasWei(gasLimit, parseGwei(this.config.fees.maxFeePerGasGwei.toString())) : 0n,
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
      // Only Ethereum may use supplied caps, and they are validated once here; anything else gets the strict default (D-042).
      const freeReserveCaps = freeMintReserveCapsForChain(this.config.target.chain, this.config.safety.freeMintReserveCaps);
      const freeReserveByWallet = new Map<number, bigint>();
      const freeReserveErrorByWallet = new Map<number, string>();
      if (mintCostPerWallet === 0n) {
        for (const wallet of wallets) {
          const gasLimit = gasLimits.get(wallet.index) ?? 0n;
          const l1DataGas = chainConfig.chainId === 4663 ? robinhoodL1DataGasWei(gasLimit, parseGwei(this.config.fees.maxFeePerGasGwei.toString())) : 0n;
          const reserve = gasLimit * parseGwei(this.config.fees.maxFeePerGasGwei.toString()) + l1DataGas;
          const reserveVerdict = validateFreeMintReserve({ perWalletReserveWei: reserve, activePeriodReserveWei: reserve }, freeReserveCaps);
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
        const walletMaxCost = mintCostPerWallet + walletGasLimit * parseGwei(this.config.fees.maxFeePerGasGwei.toString()) + (mintCostPerWallet === 0n && chainConfig.chainId === 4663 ? robinhoodL1DataGasWei(walletGasLimit, parseGwei(this.config.fees.maxFeePerGasGwei.toString())) : 0n);
        const balance = await publicClient.getBalance({ address: wallet.address });
        const freeReserve = freeReserveByWallet.get(wallet.index) ?? 0n;
        if (freeReserveErrorByWallet.has(wallet.index)) {
          preflightResults.push({ walletIndex: wallet.index, address: wallet.address, status: 'skipped', error: freeReserveErrorByWallet.get(wallet.index), simulation: simulations.get(wallet.index), durationMs: 0 });
        } else if (mintCostPerWallet === 0n && exceedsRunReserveCap(admittedFreeReserveWei, freeReserve, freeReserveCaps)) {
          preflightResults.push({ walletIndex: wallet.index, address: wallet.address, status: 'skipped', error: `FREE-mint active-period reserve cap (${formatEther(freeReserveCaps.activePeriodCapWei)} ETH) reached; wallet capacity is not transferable`, simulation: simulations.get(wallet.index), durationMs: 0 });
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

      // Re-check immediately before broadcaster construction so simulation or
      // funding latency cannot turn an earlier agreement into stale authority.
      if (chainId === 8453 && !this.config.safety.dryRun) {
        await assertBaseProviderAgreement(
          publicClient as unknown as BaseAgreementClient,
          baseFallbackClient as unknown as BaseAgreementClient,
          fundedWallets.map((wallet) => wallet.address),
        );
      }

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
      const broadcastChainConfig = chainId === 8453
        ? authorizedBaseExecutionProfile(chainConfig, this.config.safety.dryRun, this.config.safety.baseGrant, this.now())
        : chainId === 4663
          ? authorizedRobinhoodExecutionProfile(chainConfig, this.config.safety.dryRun, this.config.safety.robinhoodGrant, this.now(), mintCostPerWallet)
          : chainConfig;
      const broadcaster = createBroadcaster(
        broadcastChainConfig,
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
      this.config.safety.robinhoodGrant,
      this.now(),
      this.config.safety.baseGrant,
    );
    assertDurableReservationProvider(this.reservationProvider, this.config.safety.dryRun);
    const admissionGate = new AdmissionGate();
    // D-081: live runs re-read the drop just before each wallet is prepared and stop sending if it changed since approval.
    const recheckDrop = this.config.safety.dryRun ? undefined : createDropRecheck({
      initial: drop,
      read: () => readAndValidateDrop(publicClient, this.config.target.contract, chainId, this.config.target.strategy, this.now()),
      now: () => this.now().getTime(),
      onUnavailable: () => parentLog.warn({ event: 'drop_recheck_unavailable' }, 'Drop could not be re-read in time; continuing under the existing gates'),
    });
    // T-094 / D-080: bounded same-nonce replacement. Undefined (the default) means nothing is ever replaced.
    const replacement = this.replacementPlan(chainId, broadcaster.name);
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
      // T-094: filled only when a wallet has more than one attempt for its nonce.
      const attemptHashes: Record<string, import('viem').Hash> = {};
      const attemptReplacements: Record<string, string> = {};
      const replacedAttemptIds: string[] = [];
      const replacementFacts = () => ({
        ...(Object.keys(attemptHashes).length > 0 ? { attemptHashes: { ...attemptHashes } } : {}),
        ...(Object.keys(attemptReplacements).length > 0 ? { attemptReplacements: { ...attemptReplacements } } : {}),
        ...(replacedAttemptIds.length > 0 ? { replacedAttemptIds: [...replacedAttemptIds] } : {}),
      });

      try {
        // Check kill switch
        if (this.killSwitch.isKilled()) {
          return {
            walletIndex, address: walletAddress, status: 'killed',
            error: this.killSwitch.getReason(), durationMs: Date.now() - startTime,
          };
        }
        // Robinhood only: the owner's enablement must still be current at the moment this wallet is about to be prepared and signed (D-050).
        assertDirectChainExecutionPolicy(chainId, drop.mintPrice * BigInt(this.config.target.quantity), this.config.safety.dryRun, this.config.safety.robinhoodGrant, this.now(), this.config.safety.baseGrant);

        const dropChange = await recheckDrop?.();
        if (dropChange && dropChange !== 'unknown') {
          walletLog.warn({ event: 'campaign_changed_mid_run', changed: dropChange }, 'Drop changed after approval; this wallet is not sent');
          return { walletIndex, address: walletAddress, status: 'skipped', error: `${CAMPAIGN_CHANGED_MID_RUN}: ${dropChange}`, simulation: simulations.get(walletIndex), durationMs: Date.now() - startTime };
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

        const baseFeeBound = chainId === 8453 ? await quoteBaseFeeBound(publicClient, tx) : undefined;
        // With replacements enabled the whole worst case is reserved up front at the CEILING fee (D-019), so no replacement can spend more than was reserved.
        const reserveFee = replacement ? replacement.ceiling.maxFeePerGas : tx.maxFeePerGas!;
        const reserveTip = replacement ? replacement.ceiling.maxPriorityFeePerGas : tx.maxPriorityFeePerGas!;
        const nonL2ExecutionReserveWei = baseFeeBound?.totalWei ?? (chainId === 4663 ? robinhoodL1DataGasWei(gasLimit, reserveFee) : 0n);
        if (value === 0n) {
          const reserveVerdict = validateFreeMintReserve({
            perWalletReserveWei: gasLimit * reserveFee + nonL2ExecutionReserveWei,
            activePeriodReserveWei: gasLimit * reserveFee + nonL2ExecutionReserveWei,
          }, freeMintReserveCapsForChain(this.config.target.chain, this.config.safety.freeMintReserveCaps));
          if (!reserveVerdict.allowed) throw new MintError(MintErrorType.INVALID_CONFIG, reserveVerdict.reason, walletIndex);
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
          ...(chainId === 4663 ? { familyContext: { nftContract: drop.nftContract, feeRecipient: drop.feePayer } } : {}),
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
        const reservationProvider = this.reservationProvider;
        const reserveRequest = {
            idempotencyKey: `${transactionIntentId}:reservation`,
            chainId,
            walletIndex,
            address: walletAddress,
            valueWei: value,
            maxGasCostWei: gasLimit * reserveFee,
            campaignId: reservationCampaignId(this.config.target.campaignId, this.config.target.contract),
            runId,
            executionId,
            transactionIntentId,
            mintValueWei: value,
            l2ExecutionGasWei: gasLimit * reserveFee,
            l1DataGasWei: nonL2ExecutionReserveWei,
            priorityFeeComponentWei: reserveTip,
            replacementBudgetWei: replacementPriorityBudget(reserveTip),
            freeMint: value === 0n,
            policySnapshot: {
              policyRef: this.config.target.policyRef ?? 'phase-1',
              chainId,
              freeMint: value === 0n,
              priorityFeeComponentWei: reserveTip.toString(),
              ...(baseFeeBound ? {
                baseL1DataFeeBoundWei: baseFeeBound.l1DataFeeWei.toString(),
                baseOperatorFeeBoundWei: baseFeeBound.operatorFeeWei.toString(),
                baseUnsignedTxSize: baseFeeBound.unsignedTxSize,
              } : {}),
            },
          };
        // T-021: the amounts reserved must be the amounts in the transaction, the signer is only called after
        // the reservation is accepted, and the signed bytes must decode back to the checked transaction.
        const { reservation: reserved, signedTx } = await reserveThenSign({
          intent,
          request: reserveRequest,
          reserve: () => reservationProvider.reserve(reserveRequest),
          sign: () => signer.signTransaction(walletIndex, intent),
          checkKill: () => this.checkKill(),
          ...(replacement ? { reservedMaxFeePerGas: replacement.ceiling.maxFeePerGas } : {}),
          // Set at once so the catch block below releases the reservation if the kill switch, the signer or the
          // signed-bytes check refuses after the reserve step.
          onReserved: (created) => { reservation = created; },
        });
        reservation = reserved;

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
            ? { targetBlock: (await publicClient.getBlockNumber()) + 1n, maxBumps: replacement ? 0 : this.config.safety.maxReplacementBumps }
            : { maxBumps: replacement ? 0 : this.config.safety.maxReplacementBumps });
          const observed = broadcastResults.find((result) => result.success || result.ambiguous || classifyBroadcastResult(result) === 'ambiguous' || classifyBroadcastResult(result) === 'timeout');
          if (observed) submittedHash = observed.txHash !== '0x' ? observed.txHash : signedHash;
        } catch (error) {
          // A provider exception after signing is indistinguishable from a
          // lost response. Retain the signed hash for hash/nonce recovery.
          submittedHash = signedHash;
          await this.persistReconciliation({
            executionId,
            transactionAttemptId: attemptIds[0],
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
            endpoint: safeEndpointReference(result.endpoint),
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
          endpoint: safeEndpointReference(successResult.endpoint), latencyMs: successResult.latencyMs,
        }, `Tx broadcast: ${successResult.txHash}`);
        submittedHash = successResult.txHash;
        submissionAttemptId = selectedSubmission?.attemptId ?? attemptIdByResultIndex.get(successResultIndex);

        nonceManager.consumeNonce(walletAddress);

        // Wait for receipt
        const chainConfig = getChainConfig(chainId);
        const firstHash = successResult.txHash;
        // The accepted attempt that carries each hash, so a receipt is linked to the attempt that actually sent that transaction.
        const acceptedAttemptByHash = new Map<string, string>([[firstHash.toLowerCase(), submissionAttemptId ?? attemptIds[0]!]]);
        let watched: import('viem').Hash[] = [firstHash];
        let winnerHint: import('viem').Hash | undefined;
        if (replacement && !this.laddersStarted.has(executionId!)) {
          this.laddersStarted.add(executionId!);
          // Both are set long before a transaction can be sent; captured here so the closures below keep their types.
          const exId = executionId!;
          const intId = transactionIntentId!;
          const originalAttemptIds = [...attemptIds];
          for (const id of originalAttemptIds) attemptHashes[id] = firstHash;
          let gateRelease: (() => void) | undefined;
          const ladderDeps: LadderDeps = {
            now: () => this.now().getTime(),
            sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
            findMinedHash: async (hashes) => {
              for (const hash of hashes) {
                try { await publicClient.getTransactionReceipt({ hash }); return hash; } catch (error) { if (!isReceiptNotFound(error)) throw error; }
              }
              return undefined;
            },
            nonceState: async () => ((await publicClient.getTransactionCount({ address: walletAddress, blockTag: 'latest' })) > nonce ? 'consumed' : 'free'),
            preChecks: async () => {
              try {
                this.checkKill();
                assertDirectChainExecutionPolicy(chainId, drop.mintPrice * BigInt(this.config.target.quantity), this.config.safety.dryRun, this.config.safety.robinhoodGrant, this.now(), this.config.safety.baseGrant);
              } catch (error) { return error instanceof MintError ? error.type : 'REPLACEMENT_NOT_PERMITTED'; }
              // The store's own live gate, exactly as before the first signature: stored owner enablement still current, store kill flag, reservation still held.
              const provider = this.reservationProvider;
              if (!provider?.reconfirm) return 'REPLACEMENT_GATE_UNAVAILABLE';
              try { await provider.reconfirm(reserveRequest); } catch (error) { return `REPLACEMENT_GATE_REFUSED: ${redactProviderError(error instanceof Error ? error.message : String(error)).slice(0, 80)}`; }
              try {
                const changed = await recheckDrop?.();
                if (changed && changed !== 'unknown') return `${CAMPAIGN_CHANGED_MID_RUN}: ${changed}`;
              } catch { /* an unreadable drop never adds a refusal; the simulation below still gates the replacement */ }
              try {
                const fresh = await simulateMint(publicClient, strategy, drop, walletAddress, this.config.target.quantity, value, walletIndex, this.now());
                if (!fresh.success) return 'REPLACEMENT_SIMULATION_FAILED';
              } catch { return 'REPLACEMENT_SIMULATION_FAILED'; }
              return undefined;
            },
            prepare: async (next, bump, replacesAttemptId) => {
              // The same critical section as the first send, so a kill cannot slip between checks and signing.
              const release = await admissionGate.enter();
              gateRelease = release;
              try {
                this.checkKill();
                // Inside the admission gate, right before signing: the store's live gate once more, so a revocation between the pre-checks and now is seen.
                await this.reservationProvider?.reconfirm?.(reserveRequest);
                if (next.maxFeePerGas > replacement.ceiling.maxFeePerGas || next.maxPriorityFeePerGas > replacement.ceiling.maxPriorityFeePerGas) throw new Error('REPLACEMENT_ABOVE_CEILING');
                // Only the fees differ from the checked, reserved transaction: calldata, value, gas limit, nonce and sender are the same.
                const replacementIntent: TransactionIntent = { ...intent, maxFeePerGas: next.maxFeePerGas, maxPriorityFeePerGas: next.maxPriorityFeePerGas };
                const replacementSigned = await signer.signTransaction(walletIndex, replacementIntent);
                this.checkKill();
                await assertSignedMatchesIntent(replacementSigned, replacementIntent);
                const replacementHash = keccak256(replacementSigned);
                const signedAttemptId = `${exId}:attempt:replacement-${bump}:signed`;
                await this.lifecycleStore?.persistAttempt({
                  id: signedAttemptId,
                  executionId: exId,
                  transactionIntentId: intId,
                  endpoint: 'signer',
                  responseClass: 'signed',
                  txHash: replacementHash,
                  nonce,
                  replacementOfId: replacesAttemptId,
                  attemptedAt: this.now().toISOString(),
                });
                attemptIds.push(signedAttemptId);
                attemptHashes[signedAttemptId] = replacementHash;
                attemptReplacements[signedAttemptId] = replacesAttemptId;
                // Until a broadcast attempt is stored, this signed attempt (same hash) is the one a receipt for this hash links to.
                acceptedAttemptByHash.set(replacementHash.toLowerCase(), signedAttemptId);
                return { signedTx: replacementSigned, hash: replacementHash, attemptId: signedAttemptId };
              } catch (error) {
                gateRelease = undefined;
                release();
                throw error;
              }
            },
            send: async (prepared, bump, replacesAttemptId) => {
              try {
                this.checkKill();
                const results = await broadcaster.broadcast([prepared.signedTx], { maxBumps: 0 });
                const sentId = `${exId}:replacement-${bump}`;
                for (const [resultIndex, result] of results.entries()) {
                  const responseClass = classifyBroadcastResult(result);
                  const attemptId = broadcastAttemptId(sentId, resultIndex, responseClass);
                  await this.lifecycleStore?.persistAttempt({
                    id: attemptId,
                    executionId: exId,
                    transactionIntentId: intId,
                    endpoint: safeEndpointReference(result.endpoint),
                    responseClass,
                    txHash: prepared.hash,
                    nonce,
                    replacementOfId: replacesAttemptId,
                    redactedError: result.error ? redactProviderError(result.error) : undefined,
                    attemptedAt: this.now().toISOString(),
                  });
                  attemptIds.push(attemptId);
                  attemptHashes[attemptId] = prepared.hash;
                  attemptReplacements[attemptId] = replacesAttemptId;
                }
                const selected = selectBroadcastAttempt(sentId, results);
                acceptedAttemptByHash.set(prepared.hash.toLowerCase(), selected?.attemptId ?? prepared.attemptId);
                if (results.some((result) => result.success)) return 'accepted';
                return results.some((result) => result.ambiguous || classifyBroadcastResult(result) === 'ambiguous' || classifyBroadcastResult(result) === 'timeout') ? 'ambiguous' : 'rejected';
              } finally {
                const held = gateRelease;
                gateRelease = undefined;
                held?.();
              }
            },
          };
          const ladder = await runReplacementLadder({
            attempts: [{ hash: firstHash, attemptId: originalAttemptIds[0]!, fees: { maxFeePerGas: tx.maxFeePerGas!, maxPriorityFeePerGas: tx.maxPriorityFeePerGas! } }],
            maxBumps: replacement.maxBumps,
            ceiling: replacement.ceiling,
            stuckAfterMs: replacement.stuckAfterMs,
            pollMs: 1_000,
            lastSentAt: this.now().getTime(),
          }, ladderDeps);
          watched = ladder.attempts.map((attempt) => attempt.hash);
          winnerHint = ladder.winner;
          walletLog.info({ event: 'replacement_ladder_done', stop: ladder.stop, attempts: ladder.attempts.length, ...(ladder.detail ? { detail: ladder.detail } : {}) }, `Replacement ladder finished: ${ladder.stop}`);
        }
        // Watch every hash we sent for this nonce; whichever mines first is the one that counts.
        const receipt = await (async () => {
          if (winnerHint) return receiptWatcher.waitForReceipt(winnerHint, chainConfig.confirmationDepth);
          if (watched.length === 1) return receiptWatcher.waitForReceipt(watched[0]!, chainConfig.confirmationDepth);
          try { return await Promise.any(watched.map((hash) => receiptWatcher.waitForReceipt(hash, chainConfig.confirmationDepth))); }
          catch (error) { throw error instanceof AggregateError ? (error.errors[0] ?? error) : error; }
        })();
        const winnerAttemptId = acceptedAttemptByHash.get(receipt.txHash.toLowerCase()) ?? submissionAttemptId;
        if (watched.length > 1) {
          submittedHash = receipt.txHash;
          submissionAttemptId = winnerAttemptId;
          for (const [attemptId, hash] of Object.entries(attemptHashes)) {
            if (hash.toLowerCase() !== receipt.txHash.toLowerCase()) replacedAttemptIds.push(attemptId);
          }
        }

        walletLog.info({
          event: 'tx_confirmed', txHash: receipt.txHash, status: receipt.status,
          blockNumber: receipt.blockNumber.toString(), gasUsed: receipt.gasUsed.toString(),
          effectiveGasPrice: receipt.effectiveGasPrice.toString(),
        }, `Tx confirmed: ${receipt.status} in block ${receipt.blockNumber}`);

        const actualGasCostWei = receipt.gasUsed * receipt.effectiveGasPrice;
        const actualMintValueWei = receipt.status === 'success' ? value : 0n;
        const reconciliation = reconcileByHashAndNonce({
          originalHash: signedHash,
          ownHashes: watched,
          observedHash: receipt.txHash,
          receiptVisible: true,
          receiptStatus: receipt.status,
          receiptCanonical: true,
        });
        const lifecycleState = lifecycleStateForFinality(chainId, receipt.finalityStage, receipt.status);
        const authoritative = chainId === 1 || receipt.finalityStage === 'ethereum_final';
        const productSuccess = receipt.status === 'success' && authoritative;
        const reconciliationState = reconciliation.state === 'matched'
          ? 'matched'
          : reconciliation.state === 'reorged' ? 'reorged' : 'ambiguous';
        await this.lifecycleStore?.persistReceipt({
          id: `${executionId}:receipt:${receipt.blockHash}`,
          executionId,
          transactionAttemptId: winnerAttemptId ?? `${executionId}:attempt:signed`,
          txHash: receipt.txHash,
          status: receipt.status === 'success' ? (productSuccess ? 'confirmed' : 'pending') : 'reverted',
          blockNumber: receipt.blockNumber,
          blockHash: receipt.blockHash,
          confirmations: receipt.confirmations,
          gasUsed: receipt.gasUsed,
          effectiveGasPrice: receipt.effectiveGasPrice,
          ...(receipt.l1DataFeeWei === undefined ? {} : { l1DataFeeWei: receipt.l1DataFeeWei }),
          ...(receipt.operatorFeeWei === undefined ? {} : { operatorFeeWei: receipt.operatorFeeWei }),
          finalityStage: receipt.finalityStage,
          finalitySource: chainId === 4663 ? 'robinhood-staged-observer' : chainId === 8453 ? 'base-safe-finalized-heads' : 'ethereum-confirmation',
          observedAt: this.now().toISOString(),
        });
        await this.persistReconciliation({
          executionId,
          transactionAttemptId: winnerAttemptId,
          txHash: receipt.txHash,
          fromAddress: walletAddress,
          nonce,
          state: reconciliationState,
          source: 'receipt-watcher',
          details: { finalityStage: receipt.finalityStage, reason: reconciliation.reason },
        });
        // The attempts that lost the race are not given a reconciliation row: the database's reconciliation states have no "replaced" value
        // (a rebuild of that audit table was judged too risky). They are identified by their replacement link, the winner's `matched`
        // reconciliation above, and `replacedAttemptIds` in the result, which the backend records as state Replaced.
        if (shouldSettleReceipt(chainId, receipt.status, receipt.finalityStage)) {
          const components = {
            ...actualSettlementComponents(
              actualGasCostWei,
              (receipt.l1DataFeeWei ?? 0n) + (receipt.operatorFeeWei ?? 0n),
              receipt.priorityFeeComponentWei ?? 0n,
            ),
            actualMintValueWei,
          };
          if (reservation.settleComponents) await reservation.settleComponents(components);
          else await reservation.settle(
            actualMintValueWei,
            actualGasCostWei + (receipt.l1DataFeeWei ?? 0n) + (receipt.operatorFeeWei ?? 0n),
          );
        }

        const actualL1DataFeeWei = receipt.l1DataFeeWei ?? 0n;
        const actualOperatorFeeWei = receipt.operatorFeeWei ?? 0n;
        const totalFeeWei = actualGasCostWei + actualL1DataFeeWei + actualOperatorFeeWei;
        // totalCostWei is the all-in amount. L1 is added only when the chain
        // provides an authoritative receipt component.
        const totalCost = totalFeeWei + actualMintValueWei;

        return {
          walletIndex,
          address: walletAddress,
          status: productSuccess ? 'success' : receipt.status === 'reverted' && authoritative ? 'failed' : 'timeout',
          txHash: receipt.txHash,
          nonce,
          blockNumber: receipt.blockNumber,
          blockHash: receipt.blockHash,
          finalityStage: receipt.finalityStage,
          gasUsed: receipt.gasUsed,
          effectiveGasPrice: receipt.effectiveGasPrice,
          l1DataFeeWei: actualL1DataFeeWei,
          operatorFeeWei: actualOperatorFeeWei,
          totalFeeWei,
          totalCostWei: totalCost,
          executionId,
          transactionIntentId,
          reservationId: reservation.reservationId,
          attemptIds,
          submittedAttemptId: submissionAttemptId,
          ...replacementFacts(),
          lifecycleState,
          reconciliationState,
          durationMs: this.now().getTime() - startTime,
          error: receipt.status === 'reverted'
            ? authoritative ? 'Transaction reverted on-chain' : `${chainId === 8453 ? 'Base' : 'Robinhood'} revert is pending Ethereum finality`
            : productSuccess ? undefined : `${chainId === 8453 ? 'Base' : 'Robinhood'} finality is pending Ethereum finality`,
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
        let recoveryPersistenceError: string | undefined;
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
              // T-094: once a replacement was sent, the nonce being used may be OUR replacement, which is not a foreign transaction.
              // Without replacements nothing is passed and the old behaviour is unchanged.
              ...(new Set(Object.values(attemptHashes).map((hash) => hash.toLowerCase())).size > 1 ? { ownHashes: [submittedHash, ...Object.values(attemptHashes)] } : {}),
              observedHash: submittedHash,
              receiptVisible: false,
              nonceConsumedByDifferentHash,
            });
          recoveryState = unresolved.state;
          try {
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
          } catch (persistenceError) {
            // The signed/broadcast lifecycle facts are already durable. Keep
            // their canonical identity in the engine result so the coordinator
            // can reconcile them instead of replacing the useful result with
            // an identity-free Promise.allSettled fallback.
            recoveryPersistenceError = redactProviderError(persistenceError instanceof Error ? persistenceError.message : String(persistenceError));
          }
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
          ...replacementFacts(),
          ...(submittedHash
            ? recoveryState === 'reorged'
              ? { lifecycleState: 'reorged' as const, reconciliationState: 'reorged' as const }
              : recoveryState === 'replaced'
                ? { lifecycleState: 'replaced' as const, reconciliationState: 'replaced' as const }
                : recoveryState === 'dropped'
                  ? { lifecycleState: 'dropped' as const, reconciliationState: 'dropped' as const }
                  : { lifecycleState: 'submitted' as const, reconciliationState: recoveryState ?? 'ambiguous' as const }
            : {}),
          error: recoveryPersistenceError ? `${error.message}; recovery persistence failed: ${recoveryPersistenceError}` : error.message,
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
    idSuffix?: string,
  ): Promise<void> {
    if (!this.lifecycleStore) return;
    const timestamp = this.now().toISOString();
    await this.lifecycleStore.persistReconciliation({
      ...record,
      id: `${record.executionId}:reconciliation:${timestamp}${idSuffix ? `:${idSuffix}` : ''}`,
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
  /**
   * T-094 / D-080: whether this run may replace a stuck transaction, and with what. Only live, public or sequencer paths on Base and
   * Robinhood; never Ethereum private bundles. The ceiling must allow every configured bump from the first fee, otherwise the run is
   * refused before anything is signed rather than failing half way up the ladder.
   */
  private replacementPlan(chainId: SupportedChainId, broadcasterName: string): { ceiling: Fees; maxBumps: number; stuckAfterMs: number } | undefined {
    const configured = this.config.fees.replacement;
    const maxBumps = this.config.safety.maxReplacementBumps;
    if (this.config.safety.dryRun || !configured || !(maxBumps > 0)) return undefined;
    if ((chainId !== 8453 && chainId !== 4663) || broadcasterName === 'flashbots') return undefined;
    const ceiling: Fees = { maxFeePerGas: parseGwei(configured.ceilingMaxFeePerGasGwei.toString()), maxPriorityFeePerGas: parseGwei(configured.ceilingMaxPriorityFeePerGasGwei.toString()) };
    const first: Fees = { maxFeePerGas: parseGwei(this.config.fees.maxFeePerGasGwei.toString()), maxPriorityFeePerGas: parseGwei(this.config.fees.maxPriorityFeePerGasGwei.toString()) };
    let needed: Fees;
    try { needed = requiredCeiling(first, maxBumps); } catch { throw new MintError(MintErrorType.INVALID_CONFIG, 'Replacement settings are invalid'); }
    if (needed.maxFeePerGas > ceiling.maxFeePerGas || needed.maxPriorityFeePerGas > ceiling.maxPriorityFeePerGas || ceiling.maxPriorityFeePerGas > ceiling.maxFeePerGas) {
      throw new MintError(MintErrorType.INVALID_CONFIG, 'Replacement ceiling is too low for the configured number of replacements');
    }
    // The signed provider policy pins a maximum for each fee. The ceiling is fixed here and used for the whole run (never re-read from live config).
    const limits = configured.policyLimits;
    const policy: Fees | undefined = limits ? { maxFeePerGas: parseGwei(limits.maxFeePerGasGwei.toString()), maxPriorityFeePerGas: parseGwei(limits.maxPriorityFeePerGasGwei.toString()) } : undefined;
    if (!policy || !ceilingWithinPolicy(ceiling, policy)) {
      throw new MintError(MintErrorType.INVALID_CONFIG, 'Replacement ceiling is not inside the signed provider policy limits');
    }
    // And inside what the owner themselves approved for this campaign.
    const cap = configured.ownerCap;
    const owner: Fees | undefined = cap ? { maxFeePerGas: parseGwei(cap.maxFeePerGasGwei.toString()), maxPriorityFeePerGas: parseGwei(cap.maxPriorityFeePerGasGwei.toString()) } : undefined;
    if (!owner || !ceilingWithinPolicy(ceiling, owner)) {
      throw new MintError(MintErrorType.INVALID_CONFIG, 'Replacement ceiling is above the owner fee cap for this campaign');
    }
    return { ceiling, maxBumps, stuckAfterMs: Math.max(configured.stuckAfterMs, 6_000) };
  }

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
      fleet: { maxWallets: this.config.fleet.maxWallets, ...(this.config.fleet.walletIndexes ? { walletIndexes: this.config.fleet.walletIndexes, expectedAddresses: this.config.fleet.expectedAddresses } : {}) },
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
