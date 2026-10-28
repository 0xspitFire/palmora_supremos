/**
 * @module strategies/seadrop-v1-public
 *
 * SeaDrop v1 Public Mint Strategy.
 *
 * Implements the MintStrategy interface for SeaDrop v1 public mints.
 * This is the highest-value code in Phase 1 — it knows how to:
 * 1. Read a public drop's config from the SeaDrop v1 singleton
 * 2. Build `mintPublic()` calldata with `minterIfNotPayer = address(0)`
 *    (which makes calldata byte-identical across wallets → replayable)
 * 3. Resolve the fee recipient (allowed list or OpenSea fallback)
 *
 * Ported from solotop999/opensea-nft-public-mint seadrop-public.ts,
 * rewritten for viem (no ethers dependency).
 *
 * Key domain knowledge:
 * - SeaDrop v1 singleton: 0x00005EA00Ac477B1030CE78506496e8C2dE24bf5
 * - mintPublic(nftContract, feeRecipient, minterIfNotPayer, quantity)
 * - When minterIfNotPayer = address(0), the msg.sender is the minter
 * - Fee recipient must be from getAllowedFeeRecipients() or OpenSea's collector
 */

import {
  type Address,
  type Hex,
  type PublicClient,
  encodeFunctionData,
  parseAbi,
  zeroAddress,
  formatEther,
} from 'viem';
import type {
  MintStrategy,
  DropConfig,
  DropValidation,
  SupportedChainId,
} from '../types.js';
import { SEADROP_V1_ADDRESS, OPENSEA_FEE_COLLECTOR } from '../chains.js';

// ─────────────────────────────────────────────────────────────
// SeaDrop v1 ABI fragments (only what we need)
// ─────────────────────────────────────────────────────────────

const SEADROP_ABI = parseAbi([
  // Read the public drop config for an NFT contract
  'function getPublicDrop(address nftContract) view returns ((uint80 mintPrice, uint48 startTime, uint48 endTime, uint16 maxTotalMintableByWallet, uint16 feeBps, bool restrictFeeRecipients))',
  // Get allowed fee recipients for an NFT contract
  'function getAllowedFeeRecipients(address nftContract) view returns (address[])',
  // The mint function
  'function mintPublic(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity) payable',
]);

/** ERC721 totalSupply — used to check remaining supply. */
const ERC721_ABI = parseAbi([
  'function totalSupply() view returns (uint256)',
  'function maxSupply() view returns (uint256)',
]);

/**
 * Resolve the exact recipient which must be embedded in SeaDrop calldata.
 * Callers preparing custody policy can omit the restriction flag; this helper
 * then reads it from the same on-chain public-drop record used by the engine.
 */
export async function resolveSeaDropFeeRecipient(
  client: Pick<PublicClient, 'readContract'>,
  nftContract: Address,
  restrictFeeRecipients?: boolean,
): Promise<Address> {
  let restricted = restrictFeeRecipients;
  if (restricted === undefined) {
    const drop = await client.readContract({
      address: SEADROP_V1_ADDRESS,
      abi: SEADROP_ABI,
      functionName: 'getPublicDrop',
      args: [nftContract],
    }) as unknown as SeaDropPublicDrop;
    restricted = drop.restrictFeeRecipients;
  }
  if (!restricted) return OPENSEA_FEE_COLLECTOR;
  try {
    const allowed = await client.readContract({
      address: SEADROP_V1_ADDRESS,
      abi: SEADROP_ABI,
      functionName: 'getAllowedFeeRecipients',
      args: [nftContract],
    }) as readonly Address[];
    if (allowed[0]) return allowed[0];
  } catch {
    // Preserve the engine's established fallback for providers that cannot
    // serve this optional read; the simulation/pre-sign checks remain final.
  }
  return OPENSEA_FEE_COLLECTOR;
}

export function buildSeaDropPublicMintCalldata(nftContract: Address, feeRecipient: Address, quantity: number): Hex {
  if (!Number.isSafeInteger(quantity) || quantity < 1) throw new Error('INVALID_QUANTITY');
  return encodeFunctionData({ abi: SEADROP_ABI, functionName: 'mintPublic', args: [nftContract, feeRecipient, zeroAddress, BigInt(quantity)] });
}

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

interface SeaDropPublicDrop {
  mintPrice: bigint;
  startTime: number;
  endTime: number;
  maxTotalMintableByWallet: number;
  feeBps: number;
  restrictFeeRecipients: boolean;
}

// ─────────────────────────────────────────────────────────────
// Strategy Implementation
// ─────────────────────────────────────────────────────────────

export class SeaDropV1PublicStrategy implements MintStrategy {
  readonly name = 'seadrop-v1-public';

  async readDrop(
    client: PublicClient,
    nftContract: Address,
    chainId: SupportedChainId,
  ): Promise<DropConfig> {
    // 1. Fetch public drop config from SeaDrop singleton
    const publicDrop = await client.readContract({
      address: SEADROP_V1_ADDRESS,
      abi: SEADROP_ABI,
      functionName: 'getPublicDrop',
      args: [nftContract],
    }) as unknown as SeaDropPublicDrop;

    // Null guard — if mintPrice is 0 and times are 0, drop likely doesn't exist
    if (publicDrop.startTime === 0 && publicDrop.endTime === 0 && publicDrop.mintPrice === 0n) {
      throw new Error(
        `No public drop found for ${nftContract} on SeaDrop v1. ` +
        `The contract may not use SeaDrop, or the drop hasn't been configured yet.`
      );
    }

    // 2–3. These reads are independent after getPublicDrop. Run them together
    // to keep preparation bounded by the slowest RPC instead of the sum of four
    // round trips. Unknown optional supply methods remain an explicit unknown.
    const optionalRead = async (functionName: 'totalSupply' | 'maxSupply'): Promise<{ value: bigint; known: boolean }> => {
      try {
        const value = await client.readContract({ address: nftContract, abi: ERC721_ABI, functionName });
        return { value: value as bigint, known: true };
      } catch {
        return { value: 0n, known: false };
      }
    };
    const [feeRecipient, totalSupply, maxSupply] = await Promise.all([
      resolveSeaDropFeeRecipient(client, nftContract, publicDrop.restrictFeeRecipients),
      optionalRead('totalSupply'),
      optionalRead('maxSupply'),
    ]);
    const totalMinted = totalSupply.value;
    const maxTokenSupply = maxSupply.value;
    const totalSupplyKnown = totalSupply.known;
    const maxSupplyKnown = maxSupply.known;

    return {
      nftContract,
      mintPrice: publicDrop.mintPrice,
      maxTotalMintableByWallet: publicDrop.maxTotalMintableByWallet,
      maxTokenSupply,
      totalMinted,
       startTime: publicDrop.startTime,
       endTime: publicDrop.endTime,
      feePayer: feeRecipient,
      strategyName: this.name,
      chainId,
      extra: {
        feeBps: publicDrop.feeBps,
        restrictFeeRecipients: publicDrop.restrictFeeRecipients,
        seaDropAddress: SEADROP_V1_ADDRESS,
        totalSupplyKnown,
        maxSupplyKnown,
      },
    };
  }

  buildCalldata(drop: DropConfig, _minter: Address, quantity: number): Hex {
    // minterIfNotPayer = address(0) → msg.sender is the minter.
    // This makes calldata byte-identical across wallets (key insight from §3).
    return buildSeaDropPublicMintCalldata(drop.nftContract, drop.feePayer, quantity);
  }

  async estimateGas(
    client: PublicClient,
    drop: DropConfig,
    minter: Address,
    quantity: number,
  ): Promise<bigint> {
    const calldata = this.buildCalldata(drop, minter, quantity);
    const value = drop.mintPrice * BigInt(quantity);

    const gasEstimate = await client.estimateGas({
      account: minter,
      to: SEADROP_V1_ADDRESS,
      data: calldata,
      value,
    });

    return gasEstimate;
  }

  validateDrop(drop: DropConfig, nowUnix = Math.floor(Date.now() / 1000)): DropValidation {
    const errors: string[] = [];
    const warnings: string[] = [];
    const now = nowUnix;

    // Check timing
    if (drop.startTime > 0 && now < drop.startTime) {
      const minutesUntil = Math.ceil((drop.startTime - now) / 60);
      warnings.push(`Drop hasn't started yet. Starts in ~${minutesUntil} minutes.`);
    }

    if (drop.endTime > 0 && now > drop.endTime) {
      errors.push(`Drop has ended (endTime: ${new Date(drop.endTime * 1000).toISOString()}).`);
    }

    // Check supply
    if (drop.maxTokenSupply > 0n && drop.totalMinted >= drop.maxTokenSupply) {
      errors.push(`Drop is sold out (${drop.totalMinted}/${drop.maxTokenSupply} minted).`);
    }

    // Check mint price sanity
    if (drop.mintPrice > 0n) {
      const priceEth = parseFloat(formatEther(drop.mintPrice));
      if (priceEth > 1.0) {
        warnings.push(`High mint price: ${priceEth} ETH per token. Verify this is correct.`);
      }
    }

    // Check wallet cap
    if (drop.maxTotalMintableByWallet === 0) {
      warnings.push('maxTotalMintableByWallet is 0 — this may mean unlimited or misconfigured.');
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

}
