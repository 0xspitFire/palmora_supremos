/**
 * @module broadcasters/index
 *
 * Broadcaster factory — creates the right broadcaster(s) based on config.
 *
 * Auto-broadcast mode:
 * - L1 (Ethereum): Flashbots primary, public blast fallback
 * - L2 (Base, Robinhood): Sequencer direct + blast for redundancy
 */

export { PublicMempoolBroadcaster } from './public-mempool.js';
export { BlastBroadcaster } from './blast.js';
export { FlashbotsBroadcaster } from './flashbots.js';
export type { FlashbotsConfig } from './flashbots.js';
export { SequencerDirectBroadcaster } from './sequencer-direct.js';
export { FallbackBroadcaster } from './fallback.js';

import type { Broadcaster, ChainConfig, BroadcastMode } from '../types.js';
import { PublicMempoolBroadcaster } from './public-mempool.js';
import { BlastBroadcaster } from './blast.js';
import { SequencerDirectBroadcaster } from './sequencer-direct.js';
import { FlashbotsBroadcaster, type FlashbotsConfig } from './flashbots.js';
import { FallbackBroadcaster } from './fallback.js';

/**
 * Create the appropriate broadcaster for a chain + broadcast mode.
 *
 * In 'auto' mode:
 * - L1 → returns Flashbots with public blast fallback
 * - L2 → returns SequencerDirectBroadcaster if sequencer URL known, else BlastBroadcaster
 */
export function createBroadcaster(
  chain: ChainConfig,
  mode: BroadcastMode,
  rpcEndpoints: readonly string[],
  options?: { flashbots?: FlashbotsConfig },
): Broadcaster {
  if (!chain.executionEnabled) {
    throw new Error(`Execution is disabled for unverified chain ${chain.name} (${chain.chainId})`);
  }
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
      if (!options?.flashbots) throw new Error('Flashbots mode requires a dedicated auth signer');
      const primary = new FlashbotsBroadcaster(options.flashbots);
      return allEndpoints.length > 0 ? new FallbackBroadcaster(primary, new BlastBroadcaster(allEndpoints)) : primary;

    case 'auto':
    default:
      if (chain.isL2) {
        // L2: sequencer direct if available, else blast
        if (chain.sequencerUrl) {
          return new SequencerDirectBroadcaster(chain.sequencerUrl, allEndpoints);
        }
        return new BlastBroadcaster(allEndpoints);
      }
      if (!options?.flashbots) {
        throw new Error('Ethereum auto mode requires Flashbots authentication; select public mode explicitly for an approved fallback');
      }
      return new FlashbotsBroadcaster(options.flashbots);
  }
}
