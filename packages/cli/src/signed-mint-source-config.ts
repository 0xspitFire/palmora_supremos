import { createPublicClient, http, type Address } from 'viem';
import { registerStrategy, resolveChainConfigFromSecrets, SeaDropV1SignedStrategy, type SignedMintAuthorityClient } from '@mint-bot/engine';
import { createOpenSeaSignedDrops } from './opensea-signed-drops.js';

/** Two paths, credentials or ports on one host do not constitute independent authority. */
export function signedMintAuthorityEndpoints(endpoints: readonly string[]): [string, string] {
  const selected: Array<{ host: string; endpoint: string }> = [];
  for (const endpoint of endpoints) {
    try {
      const url = new URL(endpoint);
      if (url.protocol !== 'https:' || !url.hostname || selected.some(row => row.host === url.hostname.toLowerCase())) continue;
      selected.push({ host: url.hostname.toLowerCase(), endpoint });
      if (selected.length === 2) return [selected[0]!.endpoint, selected[1]!.endpoint];
    } catch { /* Invalid endpoints are never returned or included in errors. */ }
  }
  throw new Error('SIGNED_MINT_INDEPENDENT_AUTHORITY_REQUIRED');
}

/** Composition only. Registration grants neither chain enablement nor custody authority. */
export async function installSignedMintSources(input: {
  secretRoot: string;
  wallets(): Promise<Address[]>;
  credential(name: string): Promise<string | undefined>;
  maxQuantity: number;
}): Promise<void> {
  if (!Number.isSafeInteger(input.maxQuantity) || input.maxQuantity < 1 || input.maxQuantity > 15) throw new Error('SIGNED_MINT_QUANTITY_CONFIG_INVALID');
  const apiKey = await input.credential('OPENSEA_API');
  const drops = apiKey ? createOpenSeaSignedDrops({ apiKey }) : undefined;
  // Always replace previous process-local composition, including with a blocked
  // provider when a new runtime has no credential. Never retain old credentials.
  registerStrategy(new SeaDropV1SignedStrategy(async (chainId, contract) => {
    try {
      if (!drops) throw new Error('SIGNED_MINT_FIRST_PARTY_SOURCE_REQUIRED');
      if (![1, 8453, 4663].includes(chainId) || !/^0x[0-9a-fA-F]{40}$/.test(contract)) throw new Error('SIGNED_MINT_SOURCE_SCOPE_INVALID');
      const endpoints = signedMintAuthorityEndpoints((await resolveChainConfigFromSecrets(chainId, 'mainnet', input.secretRoot)).rpcEndpoints);
      const clients = endpoints.map(endpoint => createPublicClient({ transport: http(endpoint, { timeout: 10_000, retryCount: 0 }) }) as unknown as SignedMintAuthorityClient);
      const wallets = await input.wallets();
      if (!wallets.length || wallets.length > 10 || wallets.some(wallet => !/^0x[0-9a-fA-F]{40}$/.test(wallet)) || new Set(wallets.map(wallet => wallet.toLowerCase())).size !== wallets.length) throw new Error('SIGNED_MINT_SOURCE_SCOPE_INVALID');
      return await drops.ownWalletAuthorizations({ chainId, contract, wallets, clients, maxQuantity: Math.min(input.maxQuantity, chainId === 8453 ? 4 : 10) });
    } catch (error) {
      // RPC SDKs can include credential-bearing transport URLs in exceptions.
      const code = error instanceof Error && /^(?:SIGNED_MINT_|OPENSEA_)[A-Z_]{1,90}$/.test(error.message) ? error.message : 'SIGNED_MINT_SOURCE_UNAVAILABLE';
      throw new Error(code);
    }
  }));
}
