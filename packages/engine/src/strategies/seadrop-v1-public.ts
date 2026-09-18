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

    // 2. Resolve fee recipient
    const feeRecipient = await this.resolveFeeRecipient(
      client,
      nftContract,
      publicDrop.restrictFeeRecipients,
    );

    // 3. Try to read total supply (some contracts don't implement this)
    let totalMinted = 0n;
    let maxTokenSupply = 0n;
    let totalSupplyKnown = false;
    let maxSupplyKnown = false;
    try {
      totalMinted = await client.readContract({
        address: nftContract,
        abi: ERC721_ABI,
        functionName: 'totalSupply',
      });
      totalSupplyKnown = true;
    } catch {
      // totalSupply is optional — retain an explicit unknown supply fact.
    }
    try {
      maxTokenSupply = await client.readContract({
        address: nftContract,
        abi: ERC721_ABI,
        functionName: 'maxSupply',
      });
      maxSupplyKnown = true;
    } catch {
      // maxSupply is not standard — retain an explicit unknown upper bound.
    }

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
    return encodeFunctionData({
      abi: SEADROP_ABI,
      functionName: 'mintPublic',
      args: [
        drop.nftContract,
        drop.feePayer,
        zeroAddress,  // minterIfNotPayer = 0 → replayable across wallets
        BigInt(quantity),
      ],
    });
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

  validateDrop(drop: DropConfig): DropValidation {
    const errors: string[] = [];
    const warnings: string[] = [];
    const now = Math.floor(Date.now() / 1000);

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

  /**
   * Resolve the fee recipient for a SeaDrop mint.
   *
   * Logic:
   * 1. If restrictFeeRecipients is true, use the first from getAllowedFeeRecipients()
   * 2. Otherwise, fall back to OpenSea's fee collector
   * 3. If allowed list is empty despite restriction, fall back to OpenSea's collector
   */
  private async resolveFeeRecipient(
    client: PublicClient,
    nftContract: Address,
    restrictFeeRecipients: boolean,
  ): Promise<Address> {
    if (!restrictFeeRecipients) {
      return OPENSEA_FEE_COLLECTOR;
    }

    try {
      const allowedRecipients = await client.readContract({
        address: SEADROP_V1_ADDRESS,
        abi: SEADROP_ABI,
        functionName: 'getAllowedFeeRecipients',
        args: [nftContract],
      });

      if (allowedRecipients.length > 0 && allowedRecipients[0]) {
        return allowedRecipients[0];
      }
    } catch {
      // Fall through to default
    }

    // Fallback — most drops allow the OpenSea fee collector
    return OPENSEA_FEE_COLLECTOR;
  }
}
