/**
 * @module @mint-bot/engine
 *
 * Core types and interfaces for the NFT Mint Bot engine.
 * These are the foundational abstractions that all components depend on.
 */

import type { Address, Hex, PublicClient, Hash } from 'viem';

// ─────────────────────────────────────────────────────────────
// Chain & Network
// ─────────────────────────────────────────────────────────────

/** Supported chain identifiers. */
export type SupportedChainId = 1 | 8453 | 4663;

/**
 * Chain verification state. `verified` is a precondition for live execution;
 * `unverified` chains may be inspected but never executed.
 */
export type ChainVerificationStatus = 'unverified' | 'verified' | 'disabled';

/** Recorded characterization evidence for a chain (owner acceptance + provenance). */
export interface ChainCharacterization {
  readonly status: ChainVerificationStatus;
  /** Human/owner who accepted the characterization. */
  readonly acceptedBy?: string;
  /** Acceptance date (ISO). */
  readonly acceptedAt?: string;
  /** Reference to the characterization report/evidence. */
  readonly reportRef?: string;
  /** Reference to the recorded live SeaDrop-v1 public-drop test, if any. */
  readonly liveMintEvidenceRef?: string;
  /** Tx hash of the accepted live public-drop mint, if any. */
  readonly liveMintTxHash?: string;
  /** Free-form notes describing what was verified (no secrets). */
  readonly notes?: string;
}

/** Chain configuration entry. */
export interface ChainConfig {
  readonly chainId: SupportedChainId;
  readonly name: string;
  readonly blockTimeMs: number;
  readonly confirmationDepth: number;
  readonly rpcEndpoints: readonly string[];
  readonly sequencerUrl?: string;
  readonly sequencerFeedUrl?: string;
  readonly explorerUrl?: string;
  readonly flashbotsRelayUrl?: string;
  readonly isL2: boolean;
  readonly verificationStatus: ChainVerificationStatus;
  readonly characterization?: ChainCharacterization;
  readonly finalityPolicy: FinalityPolicy;
  /** False until chain characterization and live-drop validation are accepted. */
  readonly executionEnabled: boolean;
}

/**
 * Chain-specific finality model. Ethereum is single-stage (block confirmation);
 * Optimistic/Arbitrum L2s (Robinhood, Base) have staged finality.
 */
export type FinalityStage =
  | 'confirmed'              // inclusive mainnet block confirmation
  | 'soft'                   // Sequencer accepted + soft-confirmed
  | 'posted'                 // Batch posted to L1 inbox
  | 'ethereum_final';        // L1 reached Ethereum finality

export interface FinalityPolicy {
  /**
   * Ordered list of finality stages for the chain, from earliest observation to
   * strongest. `confirmed` always ends the list for operational accounting.
   */
  readonly stages: readonly FinalityStage[];
  /**
   * For L2s, the minimum stage required to consider spend "settled". Robinhood
   * treats `posted` as settlement for high-value accounting, but confirmation
   * is `confirmed` for ordinary operational status.
   */
  readonly settlementStage: FinalityStage;
  /** Human note on how to interpret staged acknowledgment (no secrets). */
  readonly notes?: string;
}

/** Broadcast strategy — determines how transactions are submitted to the network. */
export type BroadcastMode =
  | 'auto'           // L1 → Flashbots primary, L2 → sequencer + blast
  | 'public'         // Single RPC public mempool
  | 'blast'          // Multi-endpoint parallel blast
  | 'flashbots'      // Flashbots relay bundle (L1 only)
  | 'sequencer';     // Direct-to-sequencer (L2 only)

// ─────────────────────────────────────────────────────────────
// Drop & Mint Strategy
// ─────────────────────────────────────────────────────────────

/** Configuration read from an on-chain drop. */
export interface DropConfig {
  readonly nftContract: Address;
  readonly mintPrice: bigint;
  readonly maxTotalMintableByWallet: number;
  readonly maxTokenSupply: bigint;
  readonly totalMinted: bigint;
  readonly startTime: number;  // Unix seconds
  readonly endTime: number;    // Unix seconds
  readonly feePayer: Address;  // Resolved fee recipient
  readonly strategyName: string;
  readonly chainId: SupportedChainId;
  /** Strategy-specific extra data (e.g., SeaDrop's feeRecipient, allowedPayers). */
  readonly extra?: Record<string, unknown>;
}

/**
 * MintStrategy — the core abstraction for different mint contract types.
 *
 * Each implementation knows how to read a specific drop contract's config
 * and build the appropriate calldata. The engine is strategy-agnostic;
 * it delegates all contract-specific logic through this interface.
 *
 * Phase 1: SeaDropV1PublicStrategy, RawCalldataStrategy
 * Phase 2+: ManifoldStrategy, ThirdwebStrategy, etc.
 */
export interface MintStrategy {
  readonly name: string;

  /** Read drop config from chain. Throws if drop is not active or not found. */
  readDrop(client: PublicClient, nftContract: Address, chainId: SupportedChainId): Promise<DropConfig>;

  /** Build unsigned calldata for one wallet's mint. */
  buildCalldata(drop: DropConfig, minter: Address, quantity: number): Hex;

  /** Estimate gas for this strategy's mint call. */
  estimateGas(
    client: PublicClient,
    drop: DropConfig,
    minter: Address,
    quantity: number,
  ): Promise<bigint>;

  /** Validate that a drop is currently mintable (timing, supply, etc.). */
  validateDrop(drop: DropConfig): DropValidation;
}

/** Result of drop validation. */
export interface DropValidation {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

// ─────────────────────────────────────────────────────────────
// Broadcaster
// ─────────────────────────────────────────────────────────────

/** Result of broadcasting a single transaction. */
export interface BroadcastResult {
  readonly txHash: Hash;
  readonly endpoint: string;
  readonly latencyMs: number;
  readonly success: boolean;
  readonly error?: string;
  readonly providerReference?: string;
}

/**
 * Broadcaster — abstraction for transaction submission.
 *
 * Different implementations handle different submission paths:
 * - PublicMempool: single RPC eth_sendRawTransaction
 * - Blast: multi-endpoint parallel broadcast
 * - Flashbots: MEV-protected bundle submission (L1)
 * - SequencerDirect: direct to L2 sequencer
 */
export interface Broadcaster {
  readonly name: string;

  /** Broadcast one or more signed transactions. */
  broadcast(signedTxs: Hex[], opts?: BroadcastOptions): Promise<BroadcastResult[]>;

  /** Pre-warm connections to endpoints (called well before T-0). */
  warmup?(): Promise<void>;
}

export interface BroadcastOptions {
  /** Target block number (for Flashbots bundles). */
  targetBlock?: bigint;
  /** Maximum replacement bumps to attempt if stuck. */
  maxBumps?: number;
}

/** Immutable unsigned transaction intent. No signer or private key is retained. */
export interface TransactionIntent {
  readonly chainId: SupportedChainId;
  readonly from: Address;
  readonly to: Address;
  readonly value: bigint;
  readonly data: Hex;
  readonly nonce: number;
  readonly gasLimit: bigint;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
  readonly campaignId?: string;
  readonly runId?: string;
  readonly policyRef?: string;
  readonly evidenceRef?: string;
}

export interface SpendReservation {
  readonly reservationId: string;
  readonly walletIndex: number;
  readonly maxValueWei: bigint;
  readonly maxGasCostWei: bigint;
  settle(actualValueWei: bigint, actualGasCostWei: bigint): Promise<void>;
  release(): Promise<void>;
}

export interface SpendReservationProvider {
  reserve(input: {
    readonly idempotencyKey: string;
    readonly chainId: SupportedChainId;
    walletIndex: number;
    address: Address;
    valueWei: bigint;
    maxGasCostWei: bigint;
    readonly campaignId: string;
    readonly runId: string;
    readonly executionId: string;
    readonly transactionIntentId: string;
    readonly mintValueWei: bigint;
    readonly l2ExecutionGasWei: bigint;
    readonly l1DataGasWei: bigint;
    readonly priorityFeeComponentWei: bigint;
    /** Inclusive original-plus-replacement priority component budget. */
    readonly replacementBudgetWei: bigint;
    readonly freeMint: boolean;
    readonly policySnapshot: unknown;
  }): Promise<SpendReservation>;
}

/** Database-aligned component reservation request for a single execution. */
export interface ExecutionReservationRequest {
  readonly id: string;
  readonly walletId: string;
  readonly chainProfileId: string;
  readonly campaignId: string;
  readonly idempotencyKey: string;
  readonly policyId: string;
  readonly mintValueWei: bigint;
  readonly l2ExecutionGasWei: bigint;
  readonly l1DataGasWei: bigint;
  readonly priorityFeeComponentWei: bigint;
  readonly freeMint: boolean;
  readonly policySnapshot?: unknown;
  readonly at?: Date;
}

export type ExecutionReservationStatus = 'reserved' | 'settled' | 'released' | 'expired';

/** Database SpendReservations port. Implemented by the database package. */
export interface SpendReservationsPort {
  reserveExecution(request: ExecutionReservationRequest): ExecutionReservationStatus;
  settleExecution(
    id: string,
    actualMintValueWei: bigint,
    actualL2ExecutionGasWei: bigint,
    actualL1DataGasWei: bigint,
    at?: Date,
  ): void;
}

export interface SimulationEvidence {
  readonly walletIndex: number;
  readonly address: Address;
  readonly sourceBlock: bigint;
  readonly checkedAt: Date;
  readonly gasEstimate?: bigint;
  readonly success: boolean;
  readonly revertType?: string;
  readonly error?: string;
  /** Relay/provider reference, such as a Flashbots bundle hash. */
  readonly providerReference?: string;
}

/** Dedicated relay-auth signer. It must not be a funded minting wallet. */
export interface FlashbotsAuthSigner {
  readonly address: Address;
  signMessage(message: Hex): Promise<Hex>;
}

// ─────────────────────────────────────────────────────────────
// Signer
// ─────────────────────────────────────────────────────────────

/** Wallet info (public-facing, no private key). */
export interface WalletInfo {
  readonly index: number;
  readonly address: Address;
  readonly label?: string;
}

/**
 * Signer — abstraction for transaction signing.
 *
 * Phase 1: Envelope-encrypted local keys (passphrase-derived KEK).
 * Phase 2: KMS/HSM-backed signing.
 *
 * The engine NEVER accesses raw private keys directly.
 */
export interface Signer {
  /** List all available wallets (addresses only). */
  listWallets(): Promise<WalletInfo[]>;

  /** Sign an immutable transaction intent after validating its wallet boundary. */
  signTransaction(walletIndex: number, intent: TransactionIntent): Promise<Hex>;

  /** Securely wipe all key material from memory. */
  zeroize(): void;
}

// ─────────────────────────────────────────────────────────────
// Nonce Manager
// ─────────────────────────────────────────────────────────────

/**
 * NonceManager — per-wallet nonce tracking.
 *
 * Fetches from chain on first call, then locally increments.
 * Handles nonce-too-low by re-fetching.
 */
export interface NonceManager {
  /** Get the next nonce for a wallet. First call fetches from chain. */
  getNonce(address: Address): Promise<number>;

  /** Consume a nonce (increment local counter). */
  consumeNonce(address: Address): void;

  /** Re-fetch nonce from chain (used after nonce-too-low errors). */
  resetNonce(address: Address): Promise<number>;
}

// ─────────────────────────────────────────────────────────────
// Receipt Watcher
// ─────────────────────────────────────────────────────────────

/** Transaction receipt with the fields we care about. */
export interface MintReceipt {
  readonly txHash: Hash;
  readonly status: 'success' | 'reverted';
  readonly blockNumber: bigint;
  readonly gasUsed: bigint;
  readonly effectiveGasPrice: bigint;
  readonly confirmations: number;
}

export interface ReceiptWatcher {
  /** Wait for a transaction receipt with exponential backoff. */
  waitForReceipt(txHash: Hash, confirmationDepth: number): Promise<MintReceipt>;
}

// ─────────────────────────────────────────────────────────────
// Fleet Orchestrator
// ─────────────────────────────────────────────────────────────

/** Per-wallet mint result. */
export interface WalletMintResult {
  readonly walletIndex: number;
  readonly address: Address;
  readonly status: 'success' | 'prepared' | 'failed' | 'timeout' | 'skipped' | 'killed';
  readonly txHash?: Hash;
  readonly gasUsed?: bigint;
  readonly effectiveGasPrice?: bigint;
  readonly totalCostWei?: bigint;
  readonly error?: string;
  readonly durationMs: number;
  readonly simulation?: SimulationEvidence;
}

/** Overall mint job result. */
export interface MintJobResult {
  readonly jobId: string;
  readonly nftContract: Address;
  readonly chainId: SupportedChainId;
  readonly strategy: string;
  readonly startedAt: Date;
  readonly completedAt: Date;
  readonly dryRun: boolean;
  readonly walletResults: readonly WalletMintResult[];
  readonly totalGasSpentWei: bigint;
  readonly totalMintCostWei: bigint;
  readonly successCount: number;
  readonly failCount: number;
}

// ─────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────

/** Full mint job configuration. */
export interface MintJobConfig {
  readonly target: {
    readonly chain: 'ethereum' | 'base' | 'robinhood';
    readonly contract: Address;
    readonly strategy: string;
    readonly quantity: number;
  };
  readonly fleet: {
    readonly walletFile: string;
    readonly maxWallets: number;
  };
  readonly timing: {
    readonly mintStartUnix: number | 'auto';
    readonly armBeforeMs: number;
  };
  readonly fees: {
    readonly maxFeePerGasGwei: number;
    readonly maxPriorityFeePerGasGwei: number;
    readonly gasLimitPadding: number;
  };
  readonly safety: {
    readonly maxSpendEth: number;
    readonly dailySpendCapEth: number;
    readonly maxReplacementBumps: number;
    readonly dryRun: boolean;
    readonly killSwitchFile: string;
    /** Paid quantity default is 15; UI may raise/lower it, contract limit still applies. */
    readonly paidMaxQuantityPerWallet?: number;
    /** Adjustable paid mint-value cap per run; defaults to 0.3 ETH. */
    readonly paidRunMintValueCapEth?: number;
  };
readonly broadcast: {
    readonly mode: BroadcastMode;
    readonly rpcEndpoints: readonly string[];
    readonly blastParallel: boolean;
    readonly flashbotsAuthSigner?: FlashbotsAuthSigner;
    /** Secret store scope; defaults to 'mainnet'. */
    readonly secretScope?: 'mainnet' | 'testnet';
    /** Secret store root; defaults to the project-local 'Rets' folder. */
    readonly secretRoot?: string;
  };
  readonly observability: {
    readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
    readonly logFile: string;
    readonly alertWebhookUrl?: string;
  };
}

// ─────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────

/** Classified error types for retry/abort decisions. */
export enum MintErrorType {
  NONCE_TOO_LOW = 'NONCE_TOO_LOW',
  INSUFFICIENT_FUNDS = 'INSUFFICIENT_FUNDS',
  EXECUTION_REVERTED = 'EXECUTION_REVERTED',
  RPC_ERROR = 'RPC_ERROR',
  TIMEOUT = 'TIMEOUT',
  ALREADY_KNOWN = 'ALREADY_KNOWN',
  KILLED = 'KILLED',
  SPEND_CAP_EXCEEDED = 'SPEND_CAP_EXCEEDED',
  DROP_NOT_ACTIVE = 'DROP_NOT_ACTIVE',
  SIMULATION_FAILED = 'SIMULATION_FAILED',
  INVALID_CONFIG = 'INVALID_CONFIG',
  UNKNOWN = 'UNKNOWN',
}

/** Structured mint error with classification. */
export class MintError extends Error {
  constructor(
    public readonly type: MintErrorType,
    message: string,
    public readonly walletIndex?: number,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = 'MintError';
  }

  /** Whether this error type is retryable. */
  get retryable(): boolean {
    return [
      MintErrorType.NONCE_TOO_LOW,
      MintErrorType.RPC_ERROR,
      MintErrorType.TIMEOUT,
    ].includes(this.type);
  }
}
