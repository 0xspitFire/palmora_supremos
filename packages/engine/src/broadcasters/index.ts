/**
 * @module broadcasters/index
 *
 * Broadcaster factory — creates the right broadcaster(s) based on config.
 *
 * Auto-broadcast mode:
 * - L1 (Ethereum): Flashbots primary, public mempool fallback
 * - L2 (Base, Robinhood): Sequencer direct + blast for redundancy
 */

export { PublicMempoolBroadcaster } from './public-mempool.js';
export { BlastBroadcaster } from './blast.js';
export { FlashbotsBroadcaster } from './flashbots.js';
export type { FlashbotsConfig } from './flashbots.js';
export { SequencerDirectBroadcaster } from './sequencer-direct.js';

import type { Broadcaster, ChainConfig, BroadcastMode } from '../types.js';
import { PublicMempoolBroadcaster } from './public-mempool.js';
import { BlastBroadcaster } from './blast.js';
import { SequencerDirectBroadcaster } from './sequencer-direct.js';

/**
 * Create the appropriate broadcaster for a chain + broadcast mode.
 *
 * In 'auto' mode:
 * - L1 → returns BlastBroadcaster (Flashbots handled separately via FlashbotsBroadcaster)
 * - L2 → returns SequencerDirectBroadcaster if sequencer URL known, else BlastBroadcaster
 */
export function createBroadcaster(
  chain: ChainConfig,
  mode: BroadcastMode,
  rpcEndpoints: readonly string[],
): Broadcaster {
  const allEndpoints = [...new Set([...chain.rpcEndpoints, ...rpcEndpoints])];

  switch (mode) {
    case 'public':
      if (allEndpoints.length === 0) {
        throw new Error(`No RPC endpoints configured for ${chain.name}`);
      }
      return new PublicMempoolBroadcaster(allEndpoints[0]!);

    case 'blast':
      if (allEndpoints.length === 0) {
        throw new Error(`No RPC endpoints configured for ${chain.name}`);
      }
      return new BlastBroadcaster(allEndpoints);

    case 'sequencer':
      if (!chain.sequencerUrl) {
        throw new Error(`No sequencer URL configured for ${chain.name}`);
      }
      return new SequencerDirectBroadcaster(chain.sequencerUrl, allEndpoints);

    case 'flashbots':
      // Flashbots requires auth config — must be created directly via FlashbotsBroadcaster
      throw new Error(
        'Use FlashbotsBroadcaster directly with auth config. ' +
        'The factory does not handle Flashbots — use mode: "auto" for L1.'
      );

    case 'auto':
    default:
      if (chain.isL2) {
        // L2: sequencer direct if available, else blast
        if (chain.sequencerUrl) {
          return new SequencerDirectBroadcaster(chain.sequencerUrl, allEndpoints);
        }
        return new BlastBroadcaster(allEndpoints);
      }
      // L1: blast (Flashbots is handled as a separate bundle submission)
      return new BlastBroadcaster(allEndpoints);
  }
}
