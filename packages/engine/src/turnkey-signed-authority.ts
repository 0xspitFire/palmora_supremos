import { createPublicClient, decodeFunctionData, http } from 'viem';
import { resolveChainConfigFromSecrets } from './chains.js';
import { independentPublicRpcEndpoints } from './turnkey-public-authority.js';
import { buildSignedMint, SIGNED_MINT_ABI, verifySignedWalletAuthorization, type SignedMintAuthorityClient } from './signed-mint-authority.js';
import type { SecretScope } from './secrets.js';
import type { TransactionIntent } from './types.js';

const SAFE_CODES = new Set(['TURNKEY_SIGNED_INTENT_INVALID', 'SIGNED_MINT_AUTHORIZATION_INVALID', 'SIGNED_MINT_SIGNATURE_INVALID', 'SIGNED_MINT_AUTHORITY_INVALID', 'SIGNED_MINT_INDEPENDENT_AUTHORITY_REQUIRED', 'SIGNED_MINT_AUTHORITY_STALE', 'SIGNED_MINT_SIGNER_BOUNDS_INVALID', 'SIGNED_MINT_QUANTITY_UNAVAILABLE', 'SIGNED_MINT_SIMULATION_INVALID', 'SIGNED_MINT_RPC_DISAGREEMENT', 'SIGNED_MINT_AUTHORITY_UNAVAILABLE', 'SIGNED_MINT_OWN_WALLET_AUTHORIZATION_REQUIRED']);

/** Reverify the exact own-wallet authorization at the final custody boundary. */
export async function assertIndependentSignedAuthority(intent: TransactionIntent, clients: readonly SignedMintAuthorityClient[], now: Date | (() => Date) = () => new Date()): Promise<void> {
  try {
    const proof = intent.familyContext?.signedAuthorization;
    const context = intent.familyContext;
    const clock = typeof now === 'function' ? now : () => now;
    if (!intent.campaignId || !intent.runId || !proof || !context || proof.chainId !== intent.chainId || proof.wallet.toLowerCase() !== intent.from.toLowerCase() || proof.nftContract.toLowerCase() !== context.nftContract.toLowerCase() || proof.feeRecipient.toLowerCase() !== context.feeRecipient.toLowerCase() || intent.value !== 0n || intent.to.toLowerCase() !== proof.authority.seaDrop.toLowerCase()) throw new Error('TURNKEY_SIGNED_INTENT_INVALID');
    const quantity = Number(decodeFunctionData({ abi: SIGNED_MINT_ABI, data: intent.data }).args[3]);
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > proof.authority.verifiedQuantity) throw new Error('TURNKEY_SIGNED_INTENT_INVALID');
    const fresh = await verifySignedWalletAuthorization(proof, clients, quantity, clock);
    const call = buildSignedMint(fresh, intent.from, quantity, clock());
    if (call.data.toLowerCase() !== intent.data.toLowerCase() || call.to.toLowerCase() !== intent.to.toLowerCase()) throw new Error('TURNKEY_SIGNED_INTENT_INVALID');
  } catch (error) {
    throw new Error(error instanceof Error && SAFE_CODES.has(error.message) ? error.message : 'TURNKEY_SIGNED_AUTHORITY_UNAVAILABLE');
  }
}

export async function verifyTurnkeySignedAuthority(intent: TransactionIntent, scope: SecretScope, root: string): Promise<void> {
  try {
    const endpoints = independentPublicRpcEndpoints((await resolveChainConfigFromSecrets(intent.chainId, scope, root)).rpcEndpoints);
    const clients = endpoints.map((endpoint) => createPublicClient({ transport: http(endpoint, { timeout: 10_000, retryCount: 0 }) }) as unknown as SignedMintAuthorityClient);
    await assertIndependentSignedAuthority(intent, clients);
  } catch (error) {
    throw new Error(error instanceof Error && SAFE_CODES.has(error.message) ? error.message : 'TURNKEY_SIGNED_AUTHORITY_UNAVAILABLE');
  }
}
