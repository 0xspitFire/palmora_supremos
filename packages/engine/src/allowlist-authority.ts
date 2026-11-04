import { createHash } from 'node:crypto';
import { encodeFunctionData, parseAbi, zeroAddress, type Address, type Hex } from 'viem';
import { allowlistLeaf, buildTree, parsePublishedList, verifyProof, type MintParams } from './allowlist.js';
import { SEADROP_V1_ADDRESS } from './chains.js';
import type { SupportedChainId } from './types.js';

export const ALLOWLIST_MINT_ABI = parseAbi(['function mintAllowList(address nftContract,address feeRecipient,address minterIfNotPayer,uint256 quantity,(uint256 mintPrice,uint256 maxTotalMintableByWallet,uint256 startTime,uint256 endTime,uint256 dropStageIndex,uint256 maxTokenSupplyForStage,uint256 feeBps,bool restrictFeeRecipients) mintParams,bytes32[] proof) payable']);
export interface AllowlistAuthoritySnapshot {
  chainId: SupportedChainId;
  nftContract: Address;
  seaDrop: Address;
  root: Hex;
  blockNumber: bigint;
  blockHash: Hex;
  observedAt: string;
  feeRecipient: Address;
}
export interface AllowlistSourceBinding {
  chainId: SupportedChainId;
  nftContract: Address;
  stageIndex: string;
  sourceId: string;
  contentDigest: string;
}
export interface VerifiedWalletProof {
  wallet: Address;
  authority: AllowlistAuthoritySnapshot;
  source: AllowlistSourceBinding;
  mintParams: MintParams;
  proof: readonly Hex[];
}

const address = /^0x[0-9a-fA-F]{40}$/;
const hash = /^0x[0-9a-fA-F]{64}$/;
/** First-party data describes eligibility; the independently read chain root authenticates it. */
export function qualifyWalletProofs(input: {
  text: string;
  source: AllowlistSourceBinding;
  authority: AllowlistAuthoritySnapshot;
  wallets: readonly Address[];
  now: Date;
}): VerifiedWalletProof[] {
  const { authority: a, source: s } = input;
  if (`sha256:${createHash('sha256').update(input.text).digest('hex')}` !== s.contentDigest) throw new Error('ALLOWLIST_CONTENT_DIGEST_MISMATCH');
  const age = input.now.getTime() - Date.parse(a.observedAt);
  if (![1, 8453, 4663].includes(a.chainId) || s.chainId !== a.chainId || !address.test(a.nftContract) || s.nftContract.toLowerCase() !== a.nftContract.toLowerCase() || a.seaDrop.toLowerCase() !== SEADROP_V1_ADDRESS.toLowerCase() || !address.test(a.feeRecipient) || !hash.test(a.root) || /^0x0{64}$/i.test(a.root) || !hash.test(a.blockHash) || a.blockNumber < 0n || !Number.isFinite(age) || age < 0 || age > 60_000 || !/^[1-9]\d*$/.test(s.stageIndex) || !/^sha256:[a-f0-9]{64}$/.test(s.contentDigest) || !/^[A-Za-z0-9_-]{1,80}$/.test(s.sourceId)) throw new Error('ALLOWLIST_AUTHORITY_INVALID');
  const list = parsePublishedList(input.text);
  const tree = list.kind === 'full-list' ? buildTree(list.entries.map((e) => allowlistLeaf(e.address, e.mintParams))) : undefined;
  const owned = new Set(input.wallets.map((wallet) => wallet.toLowerCase()));
  const result = new Map<string, VerifiedWalletProof>();
  for (const e of list.entries) {
    if (!owned.has(e.address.toLowerCase()) || e.mintParams.dropStageIndex.toString() !== s.stageIndex) continue;
    const p = e.mintParams;
    const now = BigInt(Math.floor(input.now.getTime() / 1000));
    if (p.startTime <= 0n || p.endTime <= p.startTime || now > p.endTime || p.maxTotalMintableByWallet < 1n || p.maxTotalMintableByWallet > BigInt(Number.MAX_SAFE_INTEGER) || p.maxTokenSupplyForStage < 1n || p.feeBps > 10_000n || p.endTime > 7_258_118_400n) continue;
    const leaf = allowlistLeaf(e.address, p);
    const proof = e.proof ?? tree?.proofFor(leaf);
    if (!proof || !verifyProof(proof, a.root, leaf)) continue;
    if (result.has(e.address.toLowerCase())) throw new Error('ALLOWLIST_WALLET_STAGE_AMBIGUOUS');
    result.set(e.address.toLowerCase(), { wallet: e.address as Address, authority: a, source: s, mintParams: p, proof });
  }
  return [...result.values()];
}

/** A proof is wallet-bound even though minterIfNotPayer stays zero. Never copy observed allowlist calldata. */
export function buildAllowlistMint(proof: VerifiedWalletProof, wallet: Address, quantity: number, now = new Date()): { to: Address; data: Hex; value: bigint } {
  const age = now.getTime() - Date.parse(proof.authority.observedAt);
  const p = proof.mintParams;
  const unix = BigInt(Math.floor(now.getTime() / 1000));
  if (wallet.toLowerCase() !== proof.wallet.toLowerCase() || !Number.isSafeInteger(quantity) || quantity < 1 || BigInt(quantity) > p.maxTotalMintableByWallet || unix < p.startTime || unix > p.endTime || !Number.isFinite(age) || age < 0 || age > 60_000 || !verifyProof(proof.proof, proof.authority.root, allowlistLeaf(wallet, p))) throw new Error('ALLOWLIST_WALLET_PROOF_INVALID');
  return { to: proof.authority.seaDrop, value: p.mintPrice * BigInt(quantity), data: encodeFunctionData({ abi: ALLOWLIST_MINT_ABI, functionName: 'mintAllowList', args: [proof.authority.nftContract, proof.authority.feeRecipient, zeroAddress, BigInt(quantity), p, [...proof.proof]] }) };
}
