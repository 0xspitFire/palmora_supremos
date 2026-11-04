import { createPublicClient, http, parseAbi, type Address, type Hex } from 'viem';
import { OPENSEA_FEE_COLLECTOR, resolveChainConfigFromSecrets, SEADROP_V1_ADDRESS } from './chains.js';
import type { SecretScope } from './secrets.js';
import type { TransactionIntent } from './types.js';

const ABI = parseAbi(['function getAllowListMerkleRoot(address nftContract) view returns (bytes32)', 'function getAllowedFeeRecipients(address nftContract) view returns (address[])']);
export interface AllowlistAuthorityClient {
  getBlockNumber(): Promise<bigint>;
  getChainId(): Promise<number>;
  getBlock(input: { blockNumber: bigint }): Promise<{ hash: Hex | null; timestamp: bigint }>;
  readContract(input: { address: Address; abi: typeof ABI; functionName: 'getAllowListMerkleRoot' | 'getAllowedFeeRecipients'; args: [Address]; blockNumber: bigint }): Promise<unknown>;
}

/** At the provider-signing boundary, compare two recent common-block views of the current root and fees. */
async function readAuthority(intent: TransactionIntent, clients: readonly AllowlistAuthorityClient[], now: Date): Promise<void> {
  const proof = intent.familyContext?.allowlistProof;
  if (!proof || clients.length < 2) throw new Error('TURNKEY_ALLOWLIST_AUTHORITY_REQUIRED');
  const heads = await Promise.all(clients.slice(0, 2).map((client) => client.getBlockNumber()));
  const head = heads[0]! < heads[1]! ? heads[0]! : heads[1]!;
  if (head < 2n) throw new Error('TURNKEY_ALLOWLIST_AUTHORITY_STALE');
  const blockNumber = head - 2n;
  const views = await Promise.all(clients.slice(0, 2).map(async (client) => {
    const [chain, block, root, fees] = await Promise.all([
      client.getChainId(), client.getBlock({ blockNumber }),
      client.readContract({ address: SEADROP_V1_ADDRESS, abi: ABI, functionName: 'getAllowListMerkleRoot', args: [proof.authority.nftContract], blockNumber }),
      client.readContract({ address: SEADROP_V1_ADDRESS, abi: ABI, functionName: 'getAllowedFeeRecipients', args: [proof.authority.nftContract], blockNumber }),
    ]);
    const age = now.getTime() - Number(block.timestamp) * 1000;
    if (chain !== intent.chainId || !block.hash || !Number.isFinite(age) || age < -30_000 || age > 300_000 || typeof root !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(root) || !Array.isArray(fees) || fees.some((fee) => typeof fee !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(fee))) throw new Error('TURNKEY_ALLOWLIST_AUTHORITY_STALE');
    return { blockHash: block.hash.toLowerCase(), root: root.toLowerCase(), fees: (fees as string[]).map((fee) => fee.toLowerCase()).sort() };
  }));
  if (JSON.stringify(views[0]) !== JSON.stringify(views[1])) throw new Error('TURNKEY_ALLOWLIST_RPC_DISAGREEMENT');
  if (views[0]!.root !== proof.authority.root.toLowerCase() || proof.authority.chainId !== intent.chainId) throw new Error('TURNKEY_ALLOWLIST_ROOT_CHANGED');
  const recipient = proof.authority.feeRecipient.toLowerCase();
  if (!views[0]!.fees.includes(recipient) && (proof.mintParams.restrictFeeRecipients || recipient !== OPENSEA_FEE_COLLECTOR.toLowerCase())) throw new Error('TURNKEY_ALLOWLIST_FEE_RECIPIENT_INVALID');
}

const SAFE_CODES = new Set(['TURNKEY_ALLOWLIST_AUTHORITY_REQUIRED', 'TURNKEY_ALLOWLIST_AUTHORITY_STALE', 'TURNKEY_ALLOWLIST_RPC_DISAGREEMENT', 'TURNKEY_ALLOWLIST_ROOT_CHANGED', 'TURNKEY_ALLOWLIST_FEE_RECIPIENT_INVALID']);
function safeAuthorityError(error: unknown): Error {
  const code = error instanceof Error && SAFE_CODES.has(error.message) ? error.message : 'TURNKEY_ALLOWLIST_AUTHORITY_UNAVAILABLE';
  return new Error(code);
}
export async function assertIndependentAllowlistAuthority(intent: TransactionIntent, clients: readonly AllowlistAuthorityClient[], now = new Date()): Promise<void> {
  try { await readAuthority(intent, clients, now); } catch (error) { throw safeAuthorityError(error); }
}

/** Different paths or credentials on one RPC host are not independent sources. */
export function independentRpcEndpoints(endpoints: readonly string[]): [string, string] {
  const distinct = [...new Set(endpoints)];
  if (distinct.length < 2) throw new Error('TURNKEY_ALLOWLIST_AUTHORITY_REQUIRED');
  let first: URL;
  try { first = new URL(distinct[0]!); } catch { throw new Error('TURNKEY_ALLOWLIST_AUTHORITY_REQUIRED'); }
  for (const endpoint of distinct.slice(1)) {
    try { if (new URL(endpoint).hostname.toLowerCase() !== first.hostname.toLowerCase()) return [distinct[0]!, endpoint]; } catch { /* malformed endpoints cannot be selected */ }
  }
  throw new Error('TURNKEY_ALLOWLIST_AUTHORITY_REQUIRED');
}

export async function verifyTurnkeyAllowlistAuthority(intent: TransactionIntent, scope: SecretScope, root: string): Promise<void> {
  try {
    const endpoints = independentRpcEndpoints((await resolveChainConfigFromSecrets(intent.chainId, scope, root)).rpcEndpoints);
    const clients = endpoints.map((endpoint) => createPublicClient({ transport: http(endpoint, { timeout: 10_000, retryCount: 0 }) }) as unknown as AllowlistAuthorityClient);
    await assertIndependentAllowlistAuthority(intent, clients);
  } catch (error) { throw safeAuthorityError(error); }
}
