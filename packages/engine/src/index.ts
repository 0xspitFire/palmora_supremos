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
} from './types.js';

export { MintError, MintErrorType } from './types.js';

// Engine
export { MintEngine } from './mint-engine.js';

// Chain config
export { getChainConfig, getChainByName, getAllChains, resolveChainId, SEADROP_V1_ADDRESS, OPENSEA_FEE_COLLECTOR } from './chains.js';

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

// Logger
export { createLogger, childLogger } from './logger.js';
