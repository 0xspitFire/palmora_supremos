import { encodeFunctionData, hashTypedData, parseAbi, recoverTypedDataAddress, zeroAddress, type Address, type Hex } from 'viem';
import { SEADROP_V1_ADDRESS } from './chains.js';
import type { MintParams } from './allowlist.js';
import type { SupportedChainId } from './types.js';

/** SeaDrop's official SignedMint schema; quantity is constrained separately, not part of its signature.
 * https://github.com/ProjectOpenSea/seadrop/blob/main/src/SeaDrop.sol#L83-L108
 * https://github.com/ProjectOpenSea/seadrop/blob/main/src/SeaDrop.sol#L279-L417
 */
export const SIGNED_MINT_TYPES = {
  MintParams: [
    { name: 'mintPrice', type: 'uint256' }, { name: 'maxTotalMintableByWallet', type: 'uint256' },
    { name: 'startTime', type: 'uint256' }, { name: 'endTime', type: 'uint256' },
    { name: 'dropStageIndex', type: 'uint256' }, { name: 'maxTokenSupplyForStage', type: 'uint256' },
    { name: 'feeBps', type: 'uint256' }, { name: 'restrictFeeRecipients', type: 'bool' },
  ],
  SignedMint: [
    { name: 'nftContract', type: 'address' }, { name: 'minter', type: 'address' },
    { name: 'feeRecipient', type: 'address' }, { name: 'mintParams', type: 'MintParams' }, { name: 'salt', type: 'uint256' },
  ],
} as const;
export const SIGNED_MINT_ABI = parseAbi(['function mintSigned(address nftContract,address feeRecipient,address minterIfNotPayer,uint256 quantity,(uint256 mintPrice,uint256 maxTotalMintableByWallet,uint256 startTime,uint256 endTime,uint256 dropStageIndex,uint256 maxTokenSupplyForStage,uint256 feeBps,bool restrictFeeRecipients) mintParams,uint256 salt,bytes signature) payable']);
const AUTHORITY_ABI = parseAbi([
  'function getSignedMintValidationParams(address nftContract,address signer) view returns ((uint80 minMintPrice,uint24 maxMaxTotalMintableByWallet,uint40 minStartTime,uint40 maxEndTime,uint40 maxMaxTokenSupplyForStage,uint16 minFeeBps,uint16 maxFeeBps))',
  'function getFeeRecipientIsAllowed(address nftContract,address feeRecipient) view returns (bool)',
  'function getMintStats(address minter) view returns (uint256 minterNumMinted,uint256 currentTotalSupply,uint256 maxSupply)',
]);
export interface SignedMintSource {
  chainId: SupportedChainId; nftContract: Address; wallet: Address;
  stageIndex: string; sourceId: string; contentDigest: string;
}
export interface SignedWalletAuthorization {
  chainId: SupportedChainId; nftContract: Address; wallet: Address; feeRecipient: Address;
  mintParams: MintParams; salt: bigint; signature: Hex; source: SignedMintSource;
}
export interface SignedMintAuthorityClient {
  getBlockNumber(): Promise<bigint>;
  getChainId(): Promise<number>;
  getBlock(input: { blockNumber: bigint }): Promise<{ hash: Hex | null; timestamp: bigint }>;
  readContract(input: { address: Address; abi: typeof AUTHORITY_ABI; functionName: 'getSignedMintValidationParams' | 'getFeeRecipientIsAllowed' | 'getMintStats'; args: readonly Address[]; blockNumber: bigint }): Promise<unknown>;
  call(input: { account: Address; to: Address; data: Hex; value: bigint; blockNumber?: bigint }): Promise<{ data?: Hex }>;
}
export interface VerifiedSignedWalletAuthorization extends SignedWalletAuthorization {
  signer: Address; digest: Hex;
  authority: { seaDrop: Address; blockNumber: bigint; blockHash: Hex; observedAt: string; minterNumMinted: bigint; totalSupply: bigint; maxSupply: bigint; verifiedQuantity: number };
}
const verified = new WeakSet<object>();
const SAFE_CODES = new Set(['SIGNED_MINT_AUTHORIZATION_INVALID', 'SIGNED_MINT_SIGNATURE_INVALID', 'SIGNED_MINT_AUTHORITY_INVALID', 'SIGNED_MINT_INDEPENDENT_AUTHORITY_REQUIRED', 'SIGNED_MINT_AUTHORITY_STALE', 'SIGNED_MINT_SIGNER_BOUNDS_INVALID', 'SIGNED_MINT_QUANTITY_UNAVAILABLE', 'SIGNED_MINT_SIMULATION_INVALID', 'SIGNED_MINT_RPC_DISAGREEMENT']);
const address = /^0x[0-9a-fA-F]{40}$/;
const uint256Max = (1n << 256n) - 1n;
const halfCurveOrder = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

export function signedMintTypedData(input: SignedWalletAuthorization) {
  return {
    domain: { name: 'SeaDrop', version: '1.0', chainId: input.chainId, verifyingContract: SEADROP_V1_ADDRESS },
    types: SIGNED_MINT_TYPES, primaryType: 'SignedMint' as const,
    message: { nftContract: input.nftContract, minter: input.wallet, feeRecipient: input.feeRecipient, mintParams: input.mintParams, salt: input.salt },
  };
}
function calldata(input: SignedWalletAuthorization, quantity: number): Hex {
  return encodeFunctionData({ abi: SIGNED_MINT_ABI, functionName: 'mintSigned', args: [input.nftContract, input.feeRecipient, zeroAddress, BigInt(quantity), input.mintParams, input.salt, input.signature] });
}
function validateInput(input: SignedWalletAuthorization, quantity: number, now: Date): void {
  const p = input.mintParams;
  const unix = BigInt(Math.floor(now.getTime() / 1000));
  const s = input.source;
  const values = [p.mintPrice, p.maxTotalMintableByWallet, p.startTime, p.endTime, p.dropStageIndex, p.maxTokenSupplyForStage, p.feeBps, input.salt];
  if (![1, 8453, 4663].includes(input.chainId) || !address.test(input.nftContract) || !address.test(input.wallet) || !address.test(input.feeRecipient) || input.feeRecipient === zeroAddress || !values.every((value) => typeof value === 'bigint' && value >= 0n && value <= uint256Max) || p.mintPrice !== 0n || p.restrictFeeRecipients !== true || p.feeBps > 10_000n || p.dropStageIndex < 1n || p.startTime < 1n || p.endTime <= p.startTime || unix < p.startTime || unix > p.endTime || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > (input.chainId === 8453 ? 4 : 10) || BigInt(quantity) > p.maxTotalMintableByWallet || p.maxTotalMintableByWallet > BigInt(Number.MAX_SAFE_INTEGER) || p.endTime > 7_258_118_400n || p.maxTokenSupplyForStage < BigInt(quantity) || s.chainId !== input.chainId || s.nftContract.toLowerCase() !== input.nftContract.toLowerCase() || s.wallet.toLowerCase() !== input.wallet.toLowerCase() || s.stageIndex !== p.dropStageIndex.toString() || !/^[A-Za-z0-9_-]{1,80}$/.test(s.sourceId) || !/^sha256:[a-f0-9]{64}$/.test(s.contentDigest) || !/^0x[0-9a-f]{128}(?:1b|1c)$/i.test(input.signature)) throw new Error('SIGNED_MINT_AUTHORIZATION_INVALID');
  // Match OpenZeppelin ECDSA's low-s restriction; do not accept malleable signatures.
  if (BigInt(`0x${input.signature.slice(66, 130)}`) > halfCurveOrder) throw new Error('SIGNED_MINT_SIGNATURE_INVALID');
}
const boundKeys = ['minMintPrice', 'maxMaxTotalMintableByWallet', 'minStartTime', 'maxEndTime', 'maxMaxTokenSupplyForStage', 'minFeeBps', 'maxFeeBps'] as const;
function signerBounds(value: unknown): bigint[] {
  if (!value || typeof value !== 'object') throw new Error('SIGNED_MINT_AUTHORITY_INVALID');
  const values = boundKeys.map((key, i) => Array.isArray(value) ? value[i] : (value as Record<string, unknown>)[key]);
  if (values.some((entry) => (typeof entry !== 'bigint' && !(typeof entry === 'number' && Number.isSafeInteger(entry))) || BigInt(entry as number | bigint) < 0n)) throw new Error('SIGNED_MINT_AUTHORITY_INVALID');
  return values.map((entry) => BigInt(entry as number | bigint));
}

/** First-party own-wallet signature + two fresh common-block chain views. No private storage layout assumptions. */
export async function verifySignedWalletAuthorization(input: SignedWalletAuthorization, clients: readonly SignedMintAuthorityClient[], quantity: number, now: Date | (() => Date) = () => new Date()): Promise<VerifiedSignedWalletAuthorization> {
  const clock = typeof now === 'function' ? now : () => now;
  try {
    input = Object.freeze({ ...input, mintParams: Object.freeze({ ...input.mintParams }), source: Object.freeze({ ...input.source }) });
    validateInput(input, quantity, clock());
    if (clients.length < 2 || clients[0] === clients[1]) throw new Error('SIGNED_MINT_INDEPENDENT_AUTHORITY_REQUIRED');
    const typed = signedMintTypedData(input);
    const signer = await recoverTypedDataAddress({ ...typed, signature: input.signature });
    const digest = hashTypedData(typed);
    const heads = await Promise.all(clients.slice(0, 2).map((client) => client.getBlockNumber()));
    const head = heads[0]! < heads[1]! ? heads[0]! : heads[1]!;
    if (head < 2n) throw new Error('SIGNED_MINT_AUTHORITY_STALE');
    const blockNumber = head - 2n;
    const data = calldata(input, quantity);
    const views = await Promise.all(clients.slice(0, 2).map(async (client) => {
      const [chain, block, boundsValue, feeAllowed, statsValue, simulation] = await Promise.all([
        client.getChainId(), client.getBlock({ blockNumber }),
        client.readContract({ address: SEADROP_V1_ADDRESS, abi: AUTHORITY_ABI, functionName: 'getSignedMintValidationParams', args: [input.nftContract, signer], blockNumber }),
        client.readContract({ address: SEADROP_V1_ADDRESS, abi: AUTHORITY_ABI, functionName: 'getFeeRecipientIsAllowed', args: [input.nftContract, input.feeRecipient], blockNumber }),
        client.readContract({ address: input.nftContract, abi: AUTHORITY_ABI, functionName: 'getMintStats', args: [input.wallet], blockNumber }),
        // _usedDigests is private and has no getter. Exact-wallet eth_call enforces
        // unused digest and every contract-side check without reading guessed slots.
        client.call({ account: input.wallet, to: SEADROP_V1_ADDRESS, data, value: 0n, blockNumber }),
      ]);
      const age = clock().getTime() - Number(block.timestamp) * 1000;
      if (chain !== input.chainId || !block.hash || !/^0x[0-9a-f]{64}$/i.test(block.hash) || !Number.isFinite(age) || age < -30_000 || age > 300_000 || feeAllowed !== true || !Array.isArray(statsValue) || statsValue.length !== 3 || statsValue.some((value) => typeof value !== 'bigint' || value < 0n)) throw new Error('SIGNED_MINT_AUTHORITY_INVALID');
      const bounds = signerBounds(boundsValue);
      const p = input.mintParams;
      if (bounds[1] === 0n || p.mintPrice < bounds[0]! || p.maxTotalMintableByWallet > bounds[1]! || p.startTime < bounds[2]! || p.endTime > bounds[3]! || p.maxTokenSupplyForStage > bounds[4]! || p.feeBps < bounds[5]! || p.feeBps > bounds[6]!) throw new Error('SIGNED_MINT_SIGNER_BOUNDS_INVALID');
      const [minterNumMinted, totalSupply, maxSupply] = statsValue as [bigint, bigint, bigint];
      if (minterNumMinted + BigInt(quantity) > p.maxTotalMintableByWallet || totalSupply + BigInt(quantity) > maxSupply || totalSupply + BigInt(quantity) > p.maxTokenSupplyForStage) throw new Error('SIGNED_MINT_QUANTITY_UNAVAILABLE');
      if (simulation.data !== undefined && simulation.data !== '0x') throw new Error('SIGNED_MINT_SIMULATION_INVALID');
      return { blockHash: block.hash.toLowerCase() as Hex, timestamp: block.timestamp, bounds, minterNumMinted, totalSupply, maxSupply };
    }));
    const json = (value: unknown) => JSON.stringify(value, (_key, entry: unknown) => typeof entry === 'bigint' ? entry.toString() : entry);
    if (json(views[0]) !== json(views[1])) throw new Error('SIGNED_MINT_RPC_DISAGREEMENT');
    // A digest can have been consumed after the common-block snapshot. Require
    // both providers' latest exact-wallet calls too; this is validation only.
    const latest = await Promise.all(clients.slice(0, 2).map((client) => client.call({ account: input.wallet, to: SEADROP_V1_ADDRESS, data, value: 0n })));
    if (latest.some((result) => result.data !== undefined && result.data !== '0x')) throw new Error('SIGNED_MINT_SIMULATION_INVALID');
    validateInput(input, quantity, clock());
    const view = views[0]!;
    const result: VerifiedSignedWalletAuthorization = Object.freeze({ ...input, mintParams: Object.freeze({ ...input.mintParams }), source: Object.freeze({ ...input.source }), signer, digest, authority: Object.freeze({ seaDrop: SEADROP_V1_ADDRESS, blockNumber, blockHash: view.blockHash, observedAt: clock().toISOString(), minterNumMinted: view.minterNumMinted, totalSupply: view.totalSupply, maxSupply: view.maxSupply, verifiedQuantity: quantity }) });
    verified.add(result);
    return result;
  } catch (error) {
    const code = error instanceof Error && SAFE_CODES.has(error.message) ? error.message : 'SIGNED_MINT_AUTHORITY_UNAVAILABLE';
    throw new Error(code);
  }
}

/** Build only a verified, fresh own-wallet call. There is no observed-calldata fallback. */
export function buildSignedMint(proof: VerifiedSignedWalletAuthorization, wallet: Address, quantity: number, now = new Date()): { to: Address; data: Hex; value: bigint } {
  const age = now.getTime() - Date.parse(proof.authority.observedAt);
  if (!verified.has(proof) || wallet.toLowerCase() !== proof.wallet.toLowerCase() || (quantity < 1 || quantity > proof.authority.verifiedQuantity) || !Number.isFinite(age) || age < 0 || age > 60_000) throw new Error('SIGNED_MINT_OWN_WALLET_AUTHORIZATION_REQUIRED');
  validateInput(proof, quantity, now);
  return { to: SEADROP_V1_ADDRESS, data: calldata(proof, quantity), value: 0n };
}
