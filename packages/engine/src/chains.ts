/**
 * @module chains
 *
 * Chain registry — static configuration for all supported chains.
 * Includes RPC endpoints, sequencer URLs, and chain-specific parameters.
 *
 * Ported and extended from solotop999/opensea-nft-public-mint chains.ts.
 * Adds Robinhood Chain (4663) and structured config for broadcast routing.
 */

import type { ChainConfig, SupportedChainId } from './types.js';

/**
 * SeaDrop v1 singleton address — same across all EVM chains.
 * Source: OpenSea SeaDrop deployment.
 */
export const SEADROP_V1_ADDRESS = '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5' as const;

/**
 * OpenSea's default fee collector — used as fallback fee recipient
 * when `restrictFeeRecipients` is false or no allowed recipients are set.
 */
export const OPENSEA_FEE_COLLECTOR = '0x0000a26b00c1F0DF003000390027140000fAa719' as const;

/**
 * Chain configurations.
 *
 * NOTE: rpcEndpoints are placeholders — the user MUST configure their own
 * provider URLs (Alchemy, Infura, QuickNode, etc.) in the job config.
 * These are fallback/public endpoints only.
 */
const CHAINS: Record<SupportedChainId, ChainConfig> = {
  // ── Ethereum Mainnet ──────────────────────────────────────
  1: {
    chainId: 1,
    name: 'Ethereum',
    blockTimeMs: 12_000,
    confirmationDepth: 2,
    rpcEndpoints: [
      'https://eth.llamarpc.com',
      'https://rpc.ankr.com/eth',
    ],
    flashbotsRelayUrl: 'https://relay.flashbots.net',
    isL2: false,
  },

  // ── Base (Coinbase L2) ────────────────────────────────────
  8453: {
    chainId: 8453,
    name: 'Base',
    blockTimeMs: 2_000,
    confirmationDepth: 1,
    rpcEndpoints: [
      'https://mainnet.base.org',
      'https://base.llamarpc.com',
    ],
    sequencerUrl: 'https://mainnet-sequencer.base.org',
    isL2: true,
  },

  // ── Robinhood Chain ───────────────────────────────────────
  // WARNING: Under-documented chain. Parameters below are best-effort
  // and MUST be validated during the Week 1 characterization spike.
  // If sequencer behavior, gas model, or block time differ from expectations,
  // defer Robinhood support to Phase 1.1.
  4663: {
    chainId: 4663,
    name: 'Robinhood',
    blockTimeMs: 2_000,  // TODO: Verify during spike
    confirmationDepth: 1,
    rpcEndpoints: [
      // TODO: Add Robinhood Chain RPC endpoints after spike
    ],
    sequencerUrl: undefined,  // TODO: Determine during spike
    isL2: true,
  },
};

/** Get chain config by ID. Throws if chain is not supported. */
export function getChainConfig(chainId: SupportedChainId): ChainConfig {
  const config = CHAINS[chainId];
  if (!config) {
    throw new Error(`Unsupported chain ID: ${chainId}`);
  }
  return config;
}

/** Get chain config by name (case-insensitive). */
export function getChainByName(name: string): ChainConfig {
  const chainMap: Record<string, SupportedChainId> = {
    ethereum: 1,
    eth: 1,
    mainnet: 1,
    base: 8453,
    robinhood: 4663,
  };

  const chainId = chainMap[name.toLowerCase()];
  if (chainId === undefined) {
    throw new Error(`Unknown chain name: "${name}". Supported: ethereum, base, robinhood`);
  }
  return getChainConfig(chainId);
}

/** Get all supported chain configs. */
export function getAllChains(): readonly ChainConfig[] {
  return Object.values(CHAINS);
}

/** Resolve chain ID from the config's chain name string. */
export function resolveChainId(chainName: 'ethereum' | 'base' | 'robinhood'): SupportedChainId {
  const map: Record<string, SupportedChainId> = {
    ethereum: 1,
    base: 8453,
    robinhood: 4663,
  };
  const id = map[chainName];
  if (id === undefined) {
    throw new Error(`Unknown chain: ${chainName}`);
  }
  return id;
}
