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
  SimulationEvidence,
  FlashbotsAuthSigner,
} from './types.js';

export { MintError, MintErrorType } from './types.js';

// Engine
export { MintEngine } from './mint-engine.js';

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
  createBroadcaster,
} from './broadcasters/index.js';

// Signer
export { LocalEncryptedSigner, generateAndEncryptWallets } from './signer.js';

// Nonce manager
export { NonceManagerImpl } from './nonce-manager.js';

// Receipt watcher
export { ReceiptWatcherImpl } from './receipt-watcher.js';

// Safety
export { KillSwitch, SpendTracker } from './safety.js';
export { validateFeeBudget, validateFreeMintSpend, assertPriorityFeeIsNotBudget } from './fee-guard.js';
export { ROBINHOOD_SEADROP_POSITIVE_FIXTURE, ROBINHOOD_EXTERNAL_FAILED_HASHES_ARE_FLEET_EVIDENCE } from './robinhood-evidence.js';

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
