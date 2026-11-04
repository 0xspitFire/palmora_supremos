import type { Address, Hex, PublicClient } from 'viem';
import { buildAllowlistMint, type VerifiedWalletProof } from '../allowlist-authority.js';
import type { DropConfig, DropValidation, MintStrategy, SupportedChainId } from '../types.js';
import { SeaDropV1PublicStrategy } from './seadrop-v1-public.js';

export type WalletProofProvider = (chainId: SupportedChainId, contract: Address) => Promise<readonly VerifiedWalletProof[]>;

/** Own-wallet proofs only. Install with an approved first-party source provider; there is no raw-call fallback. */
export class SeaDropV1AllowlistStrategy implements MintStrategy {
  public readonly name = 'seadrop-v1-allowlist';
  public constructor(private readonly proofs: WalletProofProvider, private readonly now: () => Date = () => new Date()) {}

  public async readDrop(client: PublicClient, nftContract: Address, chainId: SupportedChainId): Promise<DropConfig> {
    const proofs = await this.proofs(chainId, nftContract);
    const first = proofs[0];
    if (!first) throw new Error('ALLOWLIST_OWN_WALLET_PROOF_REQUIRED');
    const p = first.mintParams;
    const identity = (proof: VerifiedWalletProof): string => JSON.stringify({ price: proof.mintParams.mintPrice, stage: proof.mintParams.dropStageIndex, feeBps: proof.mintParams.feeBps, restrictFeeRecipients: proof.mintParams.restrictFeeRecipients, authority: proof.authority, source: proof.source }, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value);
    if (proofs.some((proof) => identity(proof) !== identity(first) || proof.authority.chainId !== chainId || proof.authority.nftContract.toLowerCase() !== nftContract.toLowerCase())) throw new Error('ALLOWLIST_FLEET_STAGE_MISMATCH');
    const totalMinted = await client.readContract({ address: nftContract, abi: [{ type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }], functionName: 'totalSupply' });
    const minimum = (values: readonly bigint[]) => values.reduce((a, b) => a < b ? a : b);
    const maximum = (values: readonly bigint[]) => values.reduce((a, b) => a > b ? a : b);
    return { chainId, nftContract, mintPrice: p.mintPrice, maxTotalMintableByWallet: Number(minimum(proofs.map((proof) => proof.mintParams.maxTotalMintableByWallet))), maxTokenSupply: minimum(proofs.map((proof) => proof.mintParams.maxTokenSupplyForStage)), totalMinted, startTime: Number(maximum(proofs.map((proof) => proof.mintParams.startTime))), endTime: Number(minimum(proofs.map((proof) => proof.mintParams.endTime))), feePayer: first.authority.feeRecipient, strategyName: this.name, extra: { seaDropAddress: first.authority.seaDrop, feeBps: p.feeBps, restrictFeeRecipients: p.restrictFeeRecipients, allowlistRoot: first.authority.root, stageIndex: p.dropStageIndex, proofSourceDigest: first.source.contentDigest, walletProofs: proofs } };
  }

  public buildCalldata(drop: DropConfig, minter: Address, quantity: number): Hex {
    const proofs = drop.extra?.['walletProofs'] as readonly VerifiedWalletProof[] | undefined;
    const proof = proofs?.find((entry) => entry.wallet.toLowerCase() === minter.toLowerCase());
    if (!proof || proof.authority.nftContract.toLowerCase() !== drop.nftContract.toLowerCase() || proof.authority.chainId !== drop.chainId || proof.mintParams.mintPrice !== drop.mintPrice || proof.authority.root !== drop.extra?.['allowlistRoot']) throw new Error('ALLOWLIST_OWN_WALLET_PROOF_REQUIRED');
    return buildAllowlistMint(proof, minter, quantity, this.now()).data;
  }

  public async estimateGas(client: PublicClient, drop: DropConfig, minter: Address, quantity: number): Promise<bigint> {
    return client.estimateGas({ account: minter, to: drop.extra?.['seaDropAddress'] as Address, data: this.buildCalldata(drop, minter, quantity), value: drop.mintPrice * BigInt(quantity) });
  }

  public validateDrop(drop: DropConfig, nowUnix = Math.floor(this.now().getTime() / 1000)): DropValidation {
    const result = new SeaDropV1PublicStrategy().validateDrop(drop, nowUnix);
    if (nowUnix < drop.startTime) return { ...result, valid: false, errors: [...result.errors, 'ALLOWLIST_STAGE_NOT_OPEN'] };
    return result;
  }
}
