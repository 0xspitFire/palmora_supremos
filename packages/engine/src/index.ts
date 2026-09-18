/**
 * @module @mint-bot/engine
 *
 * Public API for the NFT Mint Bot engine.
 */

// Core types
export type {
  SupportedChainId,
  BroadcastMode,
  ChainConfig,
  ChainVerificationStatus,
  ChainCharacterization,
  DropConfig,
  DropValidation,
  MintStrategy,
  Broadcaster,
  BroadcastResult,
  BroadcastResponseClass,
  BroadcastOptions,
  Signer,
  WalletInfo,
  NonceManager,
  MintReceipt,
  ReceiptWatcher,
  WalletMintResult,
  MintJobResult,
  MintJobConfig,
  TransactionIntent,
  SpendReservation,
  SpendReservationProvider,
  ReservationSettlementComponents,
  ExecutionIdentity,
  LifecycleRunRecord,
  LifecycleIntentRecord,
  LifecycleAttemptRecord,
  LifecycleReceiptRecord,
  LifecycleReconciliationRecord,
  EngineLifecycleStore,
  SignerFactory,
  ExecutionReservationRequest,
  ExecutionReservationStatus,
  SpendReservationsPort,
  SimulationEvidence,
  FlashbotsAuthSigner,
} from './types.js';

export { MintError, MintErrorType } from './types.js';

// Engine
export { MintEngine } from './mint-engine.js';
export type { MintEngineOptions } from './mint-engine.js';

// Chain config
export { getChainConfig, getChainByName, getAllChains, resolveChainId, resolveChainByNameFromSecrets, resolveChainConfigFromSecrets, SEADROP_V1_ADDRESS, OPENSEA_FEE_COLLECTOR } from './chains.js';

// Strategies
export { SeaDropV1PublicStrategy } from './strategies/seadrop-v1-public.js';

// Drop reader
export { readAndValidateDrop, simulateMint, getStrategy, registerStrategy } from './drop-reader.js';

// Broadcasters
export {
  PublicMempoolBroadcaster,
  BlastBroadcaster,
  FlashbotsBroadcaster,
  SequencerDirectBroadcaster,
  FallbackBroadcaster,
  createBroadcaster,
} from './broadcasters/index.js';

// Signer
export { LocalEncryptedSigner, generateAndEncryptWallets, importAndEncryptWallets, zeroizePrivateKeyArray } from './signer.js';
export type { WalletImportRecord } from './signer.js';
export { TurnkeySigner, createTurnkeyClient, readTurnkeySecretConfig, readTurnkeyWalletMap } from './turnkey-signer.js';
export type { TurnkeyClient, TurnkeyHealthReport, TurnkeyPolicyBinding, TurnkeySecretConfig, TurnkeySignerClient, TurnkeySignerOptions, TurnkeyWalletMap, TurnkeyWalletReference } from './turnkey-signer.js';
export { importPrivateKeyToTurnkey } from './turnkey-import.js';
export type { TurnkeyImportClient, TurnkeyPrivateKeyImport } from './turnkey-import.js';

// Nonce manager
export { NonceManagerImpl } from './nonce-manager.js';

// Receipt watcher
export { ReceiptWatcherImpl } from './receipt-watcher.js';
export { ReceiptReorgedError, ReceiptTimeoutError } from './receipt-watcher.js';
export { EthereumFinalityObserver, RobinhoodFinalityObserver } from './finality-observer.js';
export type { FinalityObserver, FinalityObservation, FinalitySources, RobinhoodFinalitySources } from './finality-observer.js';

// Safety
export { KillSwitch, SpendTracker } from './safety.js';
export { validateFeeBudget, validateFreeMintSpend, validateFreeMintReserve, paidMintExecutionBlock, validatePaidQuantity, validatePaidGasExposure, replacementPriorityBudget, assertPriorityFeeIsNotBudget, FREE_MINT_PER_WALLET_RESERVE_CAP_WEI, FREE_MINT_ACTIVE_PERIOD_RESERVE_CAP_WEI } from './fee-guard.js';
export { ROBINHOOD_SEADROP_POSITIVE_FIXTURE, ROBINHOOD_EXTERNAL_FAILED_HASHES_ARE_FLEET_EVIDENCE } from './robinhood-evidence.js';
export { evaluateRobinhoodVerification, applyRobinhoodVerification } from './robinhood-gate.js';
export { correlateSequencerObservation } from './sequencer-correlation.js';
export { reconcileTransaction } from './reconciliation.js';
export { mapChainStatus } from './reconciliation.js';
export {
  LifecycleGateError,
  assertDirectChainExecutionPolicy,
  assertDurableReservationProvider,
  assertSimulationFresh,
  assertTimingWindow,
  broadcastAttemptId,
  selectBroadcastAttempt,
  classifyBroadcastResult,
  canonicalExecutionIdentity,
  reservationCampaignId,
  reconcileByHashAndNonce,
  lifecycleStateForFinality,
  shouldSettleReceipt,
  actualSettlementComponents,
} from './lifecycle.js';
export type { ExecutionGate, SubmissionDisposition } from './lifecycle.js';
export type { RobinhoodGateEvidence, RobinhoodGateResult } from './robinhood-gate.js';
export type { SequencerObservation, RpcObservation, SequencerCorrelation } from './sequencer-correlation.js';
export type { ReconciliationInput, ReconciliationAction, ExactChainStatus } from './reconciliation.js';

// Logger
export { createLogger, childLogger } from './logger.js';

// Secret references
export { readSecret, readSecretList, resolveChainEndpoints, hasSecret, SECRET_ROOT } from './secrets.js';

// Flashbots relay authentication (path-reference resolver; never exposes keys)
export { buildFlashbotsAuthSigner, isFlashbotsAuthConfigured, resolveFlashbotsAuthAddress } from './flashbots-auth.js';

// Gas / Flashbots retry-ladder policy
export {
  nextRetryAction,
  applyTipBump,
  PRIVATE_ATTEMPTS,
  ESCALATION_ATTEMPTS,
  MAX_LADDER_ATTEMPTS,
  TIP_BUMP_FRACTION,
  type RetryAction,
  type RetryDecisionInput,
} from './gas-strategy.js';
