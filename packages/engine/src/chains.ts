/**
 * @module chains
 *
 * Chain registry — static configuration for all supported chains.
 * Includes RPC endpoints, sequencer URLs, and chain-specific parameters.
 *
 * Ported and extended from solotop999/opensea-nft-public-mint chains.ts.
 * Adds Robinhood Chain (4663) and structured config for broadcast routing.
 */

/** Shared single-stage finality: block confirmation is settlement. */
const ETHEREUM_FINALITY: FinalityPolicy = {
  stages: ['confirmed'],
  settlementStage: 'confirmed',
  notes: 'Mainnet: inclusive block confirmation is settlement; no staged acknowledgment.',
};

/** Robinhood/Base L2 staged finality: sequencer soft-confirm → posted → L1 finality. */
const L2_STAGED_FINALITY: FinalityPolicy = {
  stages: ['soft', 'posted', 'ethereum_final'],
  settlementStage: 'ethereum_final',
  notes: 'Operational status retains soft and posted; product success requires Ethereum finality.',
};

import type { ChainConfig, FinalityPolicy, SupportedChainId } from './types.js';
import { resolveChainEndpoints, readSecret, type SecretName } from './secrets.js';

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
    rpcEndpoints: [],
    flashbotsRelayUrl: 'https://relay.flashbots.net',
    isL2: false,
    verificationStatus: 'verified',
    finalityPolicy: ETHEREUM_FINALITY,
    executionEnabled: true,
  },

  // ── Base (Coinbase L2) ────────────────────────────────────
  8453: {
    chainId: 8453,
    name: 'Base',
    blockTimeMs: 2_000,
    confirmationDepth: 1,
    rpcEndpoints: [],
    isL2: true,
    verificationStatus: 'unverified',
    finalityPolicy: L2_STAGED_FINALITY,
    // Phase 1 policy currently permits Ethereum only. Base remains inspectable
    // until its sequencer configuration and confirmation policy are approved.
    executionEnabled: false,
  },

// ── Robinhood Chain ───────────────────────────────────────
  // Characterization evidence (2026-08-26). Chain identity, endpoint identity,
  // FCFS ordering, EIP-1559 semantics, three-stage finality, absence of private
  // orderflow, and a live SeaDrop-v1 public-drop mint are recorded below. LIVE
  // EXECUTION is still DISABLED pending the fork + negative-case SeaDrop suite.
4663: {
    chainId: 4663,
    name: 'Robinhood',
    blockTimeMs: 2_000,
    confirmationDepth: 1,
    rpcEndpoints: [],
    sequencerUrl: 'https://sequencer.mainnet.chain.robinhood.com',
    sequencerFeedUrl: 'wss://feed.mainnet.chain.robinhood.com',
    explorerUrl: 'https://robinhoodchain.blockscout.com',
    isL2: true,
    verificationStatus: 'unverified',
    finalityPolicy: L2_STAGED_FINALITY,
    characterization: {
      status: 'unverified',
      acceptedBy: 'Junayd (Product Owner)',
      acceptedAt: '2026-08-26T00:00:00.000Z',
      reportRef: './Robinhood Technical Report',
      liveMintEvidenceRef: 'tx 0xf24e0c85f6f4fa71d012b6ffbfbc871b901fb1e949635799d1821716013d891e',
      liveMintTxHash: '0xf24e0c85f6f4fa71d012b6ffbfbc871b901fb1e949635799d1821716013d891e',
      notes: 'Verified live: chainId 0x1237 (4663); SeaDrop singleton 0x00005EA00Ac477B1030CE78506496e8C2dE24bf5 deployed; NFT 0x45ce024f314a2f74c63a8a51743677df97a8d99e; mintPublic qty 1, amount 0.00009 ETH, fee bps 1000, token 3477 ownerOf=test wallet; EIP-1559 gasUsed 121501, block 0x2c92c19; receipt status 0x1. External failed-hash evidence for other wallets is documentation-only and is not used as fleet fixtures. Execution still blocked pending fork + negative-case suite.',
    },
executionEnabled: false,
  },
};

/** Approved secret-reference names for each chain's RPC endpoint set. */
const CHAIN_ENV_REFS: Record<SupportedChainId, readonly SecretName[]> = {
  1: [
    'ETHEREUM_RPC_URL',
    'ETHEREUM_RPC_FBACK',
    'ETHEREUM_RPC_FBACK_II',
  ],
  8453: [
    'BASE_RPC_URL',
    'BASE_RPC_FBACK',
    'BASE_RPC_FBACK_II',
  ],
  4663: [
    'ROBINHOOD_RPC_URL',
    'ROBINHOOD_RPC_FBACK',
  ],
};

/**
 * Resolve a chain config with endpoints and sequencer populated from the
 * project-local secret store by approved reference name. Values are resolved
 * at runtime and never logged. Execution stays blocked for chains with
 * `executionEnabled: false`, regardless of endpoint availability.
 */
export async function resolveChainConfigFromSecrets(
  chainId: SupportedChainId,
  scope: 'mainnet' | 'testnet' = 'mainnet',
  root: string = 'Rets',
): Promise<ChainConfig> {
  const base = getChainConfig(chainId);
  const refs = CHAIN_ENV_REFS[chainId];
  const endpoints = await resolveChainEndpoints(refs, scope, root);

  let sequencerUrl: string | undefined = base.sequencerUrl;
  if (chainId === 8453) {
    try {
      const configured = await readSecret('BASE_SEQUENCER_URL', scope, root);
      sequencerUrl = configured || undefined;
    } catch {
      sequencerUrl = undefined;
    }
  }

  return { ...base, rpcEndpoints: endpoints, sequencerUrl };
}

/** Resolve a chain config by name, with secret-backed endpoints. */
export async function resolveChainByNameFromSecrets(
  name: string,
  scope: 'mainnet' | 'testnet' = 'mainnet',
  root: string = 'Rets',
): Promise<ChainConfig> {
  const base = getChainByName(name);
  return resolveChainConfigFromSecrets(base.chainId, scope, root);
}

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
