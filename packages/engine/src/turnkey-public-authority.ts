import { createPublicClient, decodeFunctionData, encodeFunctionData, http, parseAbi, zeroAddress, type Address, type Hex } from 'viem';
import { OPENSEA_FEE_COLLECTOR, resolveChainConfigFromSecrets, SEADROP_V1_ADDRESS } from './chains.js';
import type { SecretScope } from './secrets.js';
import type { TransactionIntent } from './types.js';

// All read methods are already used by the reviewed SeaDrop public strategy.
const ABI = parseAbi([
  'function getPublicDrop(address nftContract) view returns ((uint80 mintPrice, uint48 startTime, uint48 endTime, uint16 maxTotalMintableByWallet, uint16 feeBps, bool restrictFeeRecipients))',
  'function getAllowedFeeRecipients(address nftContract) view returns (address[])',
  'function totalSupply() view returns (uint256)',
  'function maxSupply() view returns (uint256)',
  'function mintPublic(address nftContract,address feeRecipient,address minterIfNotPayer,uint256 quantity) payable',
]);

export interface PublicAuthorityClient {
  getBlockNumber(): Promise<bigint>;
  getChainId(): Promise<number>;
  getBlock(input: { blockNumber: bigint }): Promise<{ hash: Hex | null; timestamp: bigint }>;
  readContract(input: { address: Address; abi: typeof ABI; functionName: 'getPublicDrop' | 'getAllowedFeeRecipients' | 'totalSupply' | 'maxSupply'; args: readonly Address[]; blockNumber: bigint }): Promise<unknown>;
}

interface PublicDrop {
  mintPrice: bigint;
  startTime: number;
  endTime: number;
  maxTotalMintableByWallet: number;
  feeBps: number;
  restrictFeeRecipients: boolean;
}

const address = (value: unknown): value is Address => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
const integer = (value: unknown, max: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
const SAFE_CODES = new Set([
  'TURNKEY_PUBLIC_INTENT_INVALID', 'TURNKEY_PUBLIC_AUTHORITY_REQUIRED', 'TURNKEY_PUBLIC_AUTHORITY_STALE',
  'TURNKEY_PUBLIC_RPC_DISAGREEMENT', 'TURNKEY_PUBLIC_DROP_NOT_FREE', 'TURNKEY_PUBLIC_STAGE_NOT_OPEN',
  'TURNKEY_PUBLIC_QUANTITY_EXCEEDED', 'TURNKEY_PUBLIC_SUPPLY_EXCEEDED', 'TURNKEY_PUBLIC_FEE_RECIPIENT_INVALID',
]);
function safeAuthorityError(error: unknown): Error {
  return new Error(error instanceof Error && SAFE_CODES.has(error.message) ? error.message : 'TURNKEY_PUBLIC_AUTHORITY_UNAVAILABLE');
}

function canonicalMint(intent: TransactionIntent): { nft: Address; recipient: Address; quantity: bigint } {
  const context = intent.familyContext;
  if (![1, 8453, 4663].includes(intent.chainId) || intent.value !== 0n || !address(intent.to) || intent.to.toLowerCase() !== SEADROP_V1_ADDRESS.toLowerCase()
    || !address(intent.from) || intent.from.toLowerCase() === zeroAddress || !intent.campaignId || !intent.runId
    || !context || !address(context.nftContract) || context.nftContract.toLowerCase() === zeroAddress || !address(context.feeRecipient)) throw new Error('TURNKEY_PUBLIC_INTENT_INVALID');
  try {
    const decoded = decodeFunctionData({ abi: ABI, data: intent.data });
    if (decoded.functionName !== 'mintPublic') throw new Error('TURNKEY_PUBLIC_INTENT_INVALID');
    const [nft, recipient, minter, quantity] = decoded.args;
    if (nft.toLowerCase() !== context.nftContract.toLowerCase() || recipient.toLowerCase() !== context.feeRecipient.toLowerCase() || minter.toLowerCase() !== zeroAddress
      || quantity < 1n || quantity > BigInt(intent.chainId === 8453 ? 4 : 15)
      || encodeFunctionData({ abi: ABI, functionName: 'mintPublic', args: decoded.args }).toLowerCase() !== intent.data.toLowerCase()) throw new Error('TURNKEY_PUBLIC_INTENT_INVALID');
    return { nft, recipient, quantity };
  } catch { throw new Error('TURNKEY_PUBLIC_INTENT_INVALID'); }
}

function publicDrop(value: unknown): PublicDrop {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('TURNKEY_PUBLIC_AUTHORITY_STALE');
  const drop = value as PublicDrop;
  if (typeof drop.mintPrice !== 'bigint' || drop.mintPrice < 0n || drop.mintPrice >= 2n ** 80n
    || !integer(drop.startTime, 2 ** 48 - 1) || !integer(drop.endTime, 2 ** 48 - 1)
    || !integer(drop.maxTotalMintableByWallet, 65535) || !integer(drop.feeBps, 10000) || typeof drop.restrictFeeRecipients !== 'boolean') throw new Error('TURNKEY_PUBLIC_AUTHORITY_STALE');
  return { mintPrice: drop.mintPrice, startTime: drop.startTime, endTime: drop.endTime, maxTotalMintableByWallet: drop.maxTotalMintableByWallet, feeBps: drop.feeBps, restrictFeeRecipients: drop.restrictFeeRecipients };
}

async function readAuthority(intent: TransactionIntent, clients: readonly PublicAuthorityClient[], clock: () => Date): Promise<void> {
  const mint = canonicalMint(intent);
  if (clients.length < 2) throw new Error('TURNKEY_PUBLIC_AUTHORITY_REQUIRED');
  const heads = await Promise.all(clients.slice(0, 2).map(client => client.getBlockNumber()));
  if (heads.some(head => typeof head !== 'bigint' || head < 2n)) throw new Error('TURNKEY_PUBLIC_AUTHORITY_STALE');
  const blockNumber = (heads[0]! < heads[1]! ? heads[0]! : heads[1]!) - 2n;
  const views = await Promise.all(clients.slice(0, 2).map(async client => {
    const optionalSupply = async (functionName: 'totalSupply' | 'maxSupply') => {
      let result: unknown;
      try { result = await client.readContract({ address: mint.nft, abi: ABI, functionName, args: [], blockNumber }); }
      catch { return { known: false as const }; }
      if (typeof result !== 'bigint' || result < 0n || result >= 2n ** 256n) throw new Error('TURNKEY_PUBLIC_AUTHORITY_STALE');
      return { known: true as const, value: result.toString() };
    };
    const [chain, block, dropValue, feesValue, supply, maximum] = await Promise.all([
      client.getChainId(), client.getBlock({ blockNumber }),
      client.readContract({ address: SEADROP_V1_ADDRESS, abi: ABI, functionName: 'getPublicDrop', args: [mint.nft], blockNumber }),
      client.readContract({ address: SEADROP_V1_ADDRESS, abi: ABI, functionName: 'getAllowedFeeRecipients', args: [mint.nft], blockNumber }),
      optionalSupply('totalSupply'), optionalSupply('maxSupply'),
    ]);
    if (chain !== intent.chainId || !block || typeof block.timestamp !== 'bigint' || typeof block.hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(block.hash)) throw new Error('TURNKEY_PUBLIC_AUTHORITY_STALE');
    if (!Array.isArray(feesValue) || feesValue.some(fee => !address(fee))) throw new Error('TURNKEY_PUBLIC_AUTHORITY_STALE');
    const drop = publicDrop(dropValue);
    return { blockHash: block.hash.toLowerCase(), timestamp: block.timestamp.toString(), drop: { ...drop, mintPrice: drop.mintPrice.toString() }, fees: (feesValue as Address[]).map(fee => fee.toLowerCase()).sort(), supply, maximum };
  }));
  if (JSON.stringify(views[0]) !== JSON.stringify(views[1])) throw new Error('TURNKEY_PUBLIC_RPC_DISAGREEMENT');
  const view = views[0]!;
  // RPC waits can cross a freshness or stage boundary. Sample time only after
  // all authority reads have completed, immediately before the final checks.
  const nowMs = clock().getTime();
  const age = nowMs - Number(view.timestamp) * 1000;
  if (!Number.isFinite(nowMs) || !Number.isFinite(age) || age < -30_000 || age > 300_000) throw new Error('TURNKEY_PUBLIC_AUTHORITY_STALE');
  const drop = view.drop;
  if (drop.mintPrice !== '0') throw new Error('TURNKEY_PUBLIC_DROP_NOT_FREE');
  const blockTime = Number(view.timestamp);
  const wallTime = Math.floor(nowMs / 1000);
  if (drop.startTime === 0 && drop.endTime === 0 || drop.endTime < drop.startTime
    || blockTime < drop.startTime || blockTime > drop.endTime || wallTime < drop.startTime || wallTime > drop.endTime) throw new Error('TURNKEY_PUBLIC_STAGE_NOT_OPEN');
  if (mint.quantity > BigInt(drop.maxTotalMintableByWallet)) throw new Error('TURNKEY_PUBLIC_QUANTITY_EXCEEDED');
  // Optional supply reads use the existing strategy's known/unknown semantics.
  // Unknown on one RPC and known on the other is disagreement, never fallback.
  if (view.supply.known && view.maximum.known && BigInt(view.supply.value!) + mint.quantity > BigInt(view.maximum.value!)) throw new Error('TURNKEY_PUBLIC_SUPPLY_EXCEEDED');
  const recipient = mint.recipient.toLowerCase();
  if (!view.fees.includes(recipient) && (drop.restrictFeeRecipients || recipient !== OPENSEA_FEE_COLLECTOR.toLowerCase())) throw new Error('TURNKEY_PUBLIC_FEE_RECIPIENT_INVALID');
}

/** Injectable read-only check for the signing boundary; does not sign or reserve. */
export async function assertIndependentPublicAuthority(intent: TransactionIntent, clients: readonly PublicAuthorityClient[], now: (() => Date) | Date = () => new Date()): Promise<void> {
  try { await readAuthority(intent, clients, typeof now === 'function' ? now : () => now); } catch (error) { throw safeAuthorityError(error); }
}

/** Two different RPC hostnames are required; credentials/paths on one host do not count twice. */
export function independentPublicRpcEndpoints(endpoints: readonly string[]): [string, string] {
  const distinct = [...new Set(endpoints)];
  let first: URL;
  try { first = new URL(distinct[0]!); } catch { throw new Error('TURNKEY_PUBLIC_AUTHORITY_REQUIRED'); }
  if (!['http:', 'https:'].includes(first.protocol)) throw new Error('TURNKEY_PUBLIC_AUTHORITY_REQUIRED');
  for (const endpoint of distinct.slice(1)) {
    try {
      const candidate = new URL(endpoint);
      if (['http:', 'https:'].includes(candidate.protocol) && candidate.hostname.toLowerCase() !== first.hostname.toLowerCase()) return [distinct[0]!, endpoint];
    } catch { /* malformed entries cannot be authority sources */ }
  }
  throw new Error('TURNKEY_PUBLIC_AUTHORITY_REQUIRED');
}

export async function verifyTurnkeyPublicAuthority(intent: TransactionIntent, scope: SecretScope, root: string): Promise<void> {
  try {
    canonicalMint(intent);
    const endpoints = independentPublicRpcEndpoints((await resolveChainConfigFromSecrets(intent.chainId, scope, root)).rpcEndpoints);
    const clients = endpoints.map(endpoint => createPublicClient({ transport: http(endpoint, { timeout: 10_000, retryCount: 0 }) }) as unknown as PublicAuthorityClient);
    await assertIndependentPublicAuthority(intent, clients);
  } catch (error) { throw safeAuthorityError(error); }
}
