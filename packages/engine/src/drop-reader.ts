/**
 * @module drop-reader
 *
 * Generic drop reader that delegates to the active MintStrategy.
 *
 * Responsibilities:
 * 1. Resolve which strategy to use based on config
 * 2. Delegate drop reading to that strategy
 * 3. Validate the drop is mintable
 * 4. Run pre-send simulation (at setup time, NOT on hot path)
 *
 * The simulation gate happens here — an eth_call against the mint calldata
 * to verify it won't revert. This is a T-minus check, done once during setup.
 */

import type { Address, PublicClient } from 'viem';
import type {
  MintStrategy,
  DropConfig,
  DropValidation,
  SupportedChainId,
  SimulationEvidence,
} from './types.js';
import { SeaDropV1PublicStrategy } from './strategies/seadrop-v1-public.js';

/** Registry of available strategies. */
const STRATEGY_REGISTRY: Record<string, MintStrategy> = {
  'seadrop-v1-public': new SeaDropV1PublicStrategy(),
  'seadrop-v1': new SeaDropV1PublicStrategy(), // alias
};

/**
 * Register a custom strategy at runtime.
 * Used for Phase 2 strategies (Manifold, thirdweb, etc.)
 */
export function registerStrategy(strategy: MintStrategy): void {
  STRATEGY_REGISTRY[strategy.name] = strategy;
}

/** Get a strategy by name. */
export function getStrategy(name: string): MintStrategy {
  const strategy = STRATEGY_REGISTRY[name];
  if (!strategy) {
    const available = Object.keys(STRATEGY_REGISTRY).join(', ');
    throw new Error(`Unknown strategy: "${name}". Available: ${available}`);
  }
  return strategy;
}

/**
 * Read and validate a drop from chain using the specified strategy.
 *
 * This is the setup-time entry point. It:
 * 1. Resolves the strategy
 * 2. Reads the drop config
 * 3. Validates timing, supply, and configuration
 * 4. Returns the drop config + validation result
 */
export async function readAndValidateDrop(
  client: PublicClient,
  nftContract: Address,
  chainId: SupportedChainId,
  strategyName: string,
): Promise<{ drop: DropConfig; validation: DropValidation }> {
  const strategy = getStrategy(strategyName);
  const drop = await strategy.readDrop(client, nftContract, chainId);
  const validation = strategy.validateDrop(drop);
  return { drop, validation };
}

/**
 * Pre-send simulation gate.
 *
 * Runs an eth_call to verify the mint calldata won't revert.
 * Called at setup time (T-minus), NOT on the hot path.
 *
 * Returns the revert reason if it fails, or null if simulation passes.
 */
export async function simulateMint(
  client: PublicClient,
  strategy: MintStrategy,
  drop: DropConfig,
  minter: Address,
  quantity: number,
  value: bigint,
  walletIndex = -1,
): Promise<SimulationEvidence> {
  const calldata = strategy.buildCalldata(drop, minter, quantity);

  // Determine the target address (SeaDrop singleton for SeaDrop strategies)
  const to = drop.extra?.['seaDropAddress'] as Address | undefined ?? drop.nftContract;

  const sourceBlock = await client.getBlockNumber();
  try {
    await client.call({
      account: minter,
      to,
      data: calldata,
      value,
    });
    return { walletIndex, address: minter, sourceBlock, checkedAt: new Date(), success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    let revertType: string | undefined;
    if (/insufficient|fund/i.test(message)) revertType = 'insufficient-funds';
    else if (/sold|supply/i.test(message)) revertType = 'supply';
    else if (/price|value/i.test(message)) revertType = 'price';
    return { walletIndex, address: minter, sourceBlock, checkedAt: new Date(), success: false, revertType, error: `Simulation reverted: ${message}` };
  }
}
