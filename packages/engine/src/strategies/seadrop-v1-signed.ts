import type { Address, Hex, PublicClient } from 'viem';
import { buildSignedMint, type VerifiedSignedWalletAuthorization } from '../signed-mint-authority.js';
import type { DropConfig, DropValidation, MintStrategy, SupportedChainId } from '../types.js';
import { SeaDropV1PublicStrategy } from './seadrop-v1-public.js';

export type SignedWalletAuthorizationProvider = (chainId: SupportedChainId, contract: Address) => Promise<readonly VerifiedSignedWalletAuthorization[]>;

/** Disabled unless composed with a first-party own-wallet provider and separately approved custody family. */
export class SeaDropV1SignedStrategy implements MintStrategy {
  public readonly name = 'seadrop-v1-signed';
  public constructor(private readonly authorizations: SignedWalletAuthorizationProvider, private readonly now: () => Date = () => new Date()) {}

  public async readDrop(_client: PublicClient, nftContract: Address, chainId: SupportedChainId): Promise<DropConfig> {
    const authorizations = await this.authorizations(chainId, nftContract);
    const first = authorizations[0];
    if (!first) throw new Error('SIGNED_MINT_OWN_WALLET_AUTHORIZATION_REQUIRED');
    const identity = (proof: VerifiedSignedWalletAuthorization): string => JSON.stringify({ chain: proof.chainId, contract: proof.nftContract.toLowerCase(), stage: proof.mintParams.dropStageIndex, price: proof.mintParams.mintPrice, feeRecipient: proof.feeRecipient.toLowerCase(), feeBps: proof.mintParams.feeBps }, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value);
    for (const proof of authorizations) {
      if (proof.chainId !== chainId || proof.nftContract.toLowerCase() !== nftContract.toLowerCase() || identity(proof) !== identity(first)) throw new Error('SIGNED_MINT_FLEET_STAGE_MISMATCH');
      buildSignedMint(proof, proof.wallet, proof.authority.verifiedQuantity, this.now());
    }
    if (new Set(authorizations.map((proof) => proof.wallet.toLowerCase())).size !== authorizations.length) throw new Error('SIGNED_MINT_FLEET_STAGE_MISMATCH');
    const minimum = (values: readonly bigint[]) => values.reduce((a, b) => a < b ? a : b);
    const maximum = (values: readonly bigint[]) => values.reduce((a, b) => a > b ? a : b);
    const p = first.mintParams;
    return { chainId, nftContract, mintPrice: 0n, maxTotalMintableByWallet: Number(minimum(authorizations.map((proof) => BigInt(proof.authority.verifiedQuantity)))), maxTokenSupply: minimum([...authorizations.map((proof) => proof.mintParams.maxTokenSupplyForStage), ...authorizations.map((proof) => proof.authority.maxSupply)]), totalMinted: maximum(authorizations.map((proof) => proof.authority.totalSupply)), startTime: Number(maximum(authorizations.map((proof) => proof.mintParams.startTime))), endTime: Number(minimum(authorizations.map((proof) => proof.mintParams.endTime))), feePayer: first.feeRecipient, strategyName: this.name, extra: { seaDropAddress: first.authority.seaDrop, feeBps: p.feeBps, restrictFeeRecipients: true, stageIndex: p.dropStageIndex, signedWalletAuthorizations: authorizations, totalSupplyKnown: true, maxSupplyKnown: true } };
  }
  public buildCalldata(drop: DropConfig, minter: Address, quantity: number): Hex {
    const authorizations = drop.extra?.['signedWalletAuthorizations'] as readonly VerifiedSignedWalletAuthorization[] | undefined;
    const proof = authorizations?.find((entry) => entry.wallet.toLowerCase() === minter.toLowerCase());
    if (!proof || proof.chainId !== drop.chainId || proof.nftContract.toLowerCase() !== drop.nftContract.toLowerCase() || proof.mintParams.dropStageIndex !== drop.extra?.['stageIndex'] || drop.mintPrice !== 0n) throw new Error('SIGNED_MINT_OWN_WALLET_AUTHORIZATION_REQUIRED');
    return buildSignedMint(proof, minter, quantity, this.now()).data;
  }
  public async estimateGas(client: PublicClient, drop: DropConfig, minter: Address, quantity: number): Promise<bigint> {
    return client.estimateGas({ account: minter, to: drop.extra?.['seaDropAddress'] as Address, data: this.buildCalldata(drop, minter, quantity), value: 0n });
  }
  public validateDrop(drop: DropConfig, nowUnix = Math.floor(this.now().getTime() / 1000)): DropValidation {
    const result = new SeaDropV1PublicStrategy().validateDrop(drop, nowUnix);
    if (nowUnix < drop.startTime) return { ...result, valid: false, errors: [...result.errors, 'SIGNED_MINT_STAGE_NOT_OPEN'] };
    return result;
  }
}
