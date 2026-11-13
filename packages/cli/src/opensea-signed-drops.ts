import { createHash } from 'node:crypto';
import { decodeFunctionData, encodeFunctionData, zeroAddress, type Address, type Hex } from 'viem';
import { SIGNED_MINT_ABI, SEADROP_V1_ADDRESS, verifySignedWalletAuthorization, type SignedMintAuthorityClient, type SignedWalletAuthorization, type SupportedChainId, type VerifiedSignedWalletAuthorization } from '@mint-bot/engine';
import { OPENSEA_CHAIN_SLUG } from './opensea-client.js';
import { createOpenSeaDropRequester, type OpenSeaDropOptions } from './opensea-drops.js';

/** Official per-wallet mint builder. Never imports a source wallet's signature. */
export function createOpenSeaSignedDrops(options: OpenSeaDropOptions) {
  const request = createOpenSeaDropRequester(options);
  const now = options.now ?? (() => new Date());
  return {
    async ownWalletAuthorizations(input: { chainId: SupportedChainId; contract: Address; wallets: readonly Address[]; maxQuantity: number; clients: readonly SignedMintAuthorityClient[] }): Promise<VerifiedSignedWalletAuthorization[]> {
      const chain = OPENSEA_CHAIN_SLUG[input.chainId];
      const wallets = [...new Set(input.wallets.map(wallet => wallet.toLowerCase()))] as Address[];
      const cap = input.chainId === 8453 ? 4 : 10;
      if (!chain || !/^0x[0-9a-fA-F]{40}$/.test(input.contract) || !wallets.length || wallets.length > 10 || wallets.some(wallet => !/^0x[0-9a-fA-F]{40}$/.test(wallet)) || !Number.isSafeInteger(input.maxQuantity) || input.maxQuantity < 1 || input.maxQuantity > cap || input.clients.length < 2) throw new Error('SIGNED_MINT_SOURCE_SCOPE_INVALID');
      const metadata = await request(`/api/v2/chain/${chain}/contract/${input.contract.toLowerCase()}`);
      const slug = metadata['collection'];
      if (typeof slug !== 'string' || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(slug)) throw new Error('OPENSEA_DROP_NOT_FOUND');
      const result: Array<VerifiedSignedWalletAuthorization | undefined> = new Array(wallets.length);
      let fundingRejected = false;
      const authorize = async (wallet: Address, index: number): Promise<void> => {
        let tx: Record<string, unknown>;
        // Data only: local funding, simulation and admission remain mandatory.
        try { tx = await request(`/api/v2/drops/${slug}/mint`, { minter: wallet, quantity: 1, skip_balance_check: true }); }
        catch (error) {
          if (error instanceof Error && error.message === 'OPENSEA_WALLET_NOT_ELIGIBLE') return;
          if (error instanceof Error && error.message === 'OPENSEA_MINT_FUNDING_REQUIRED') { fundingRejected = true; return; }
          throw error;
        }
        if (tx['chain'] !== chain || typeof tx['to'] !== 'string' || tx['to'].toLowerCase() !== SEADROP_V1_ADDRESS.toLowerCase() || tx['value'] !== '0' || typeof tx['data'] !== 'string' || !/^0x(?:[a-fA-F0-9]{2})+$/.test(tx['data']) || tx['data'].length > 20_000) throw new Error('SIGNED_MINT_PLATFORM_BINDING_INVALID');
        let authorization: SignedWalletAuthorization;
        try {
          const decoded = decodeFunctionData({ abi: SIGNED_MINT_ABI, data: tx['data'] as Hex });
          const [nft, feeRecipient, recipient, quantity, mintParams, salt, signature] = decoded.args;
          if (nft.toLowerCase() !== input.contract.toLowerCase() || ![zeroAddress, wallet].includes(recipient.toLowerCase() as Address) || quantity !== 1n || mintParams.mintPrice !== 0n || mintParams.restrictFeeRecipients !== true || encodeFunctionData({ abi: SIGNED_MINT_ABI, functionName: 'mintSigned', args: decoded.args }).toLowerCase() !== tx['data'].toLowerCase()) throw new Error('SIGNED_MINT_PLATFORM_BINDING_INVALID');
          authorization = { chainId: input.chainId, nftContract: input.contract, wallet, feeRecipient, mintParams, salt, signature, source: { chainId: input.chainId, nftContract: input.contract, wallet, stageIndex: mintParams.dropStageIndex.toString(), sourceId: 'opensea-drops-v1', contentDigest: `sha256:${createHash('sha256').update(tx['data']).digest('hex')}` } };
        } catch { throw new Error('SIGNED_MINT_PLATFORM_BINDING_INVALID'); }
        const quantity = Number(authorization.mintParams.maxTotalMintableByWallet < BigInt(input.maxQuantity) ? authorization.mintParams.maxTotalMintableByWallet : BigInt(input.maxQuantity));
        try { result[index] = await verifySignedWalletAuthorization(authorization, input.clients, quantity, now()); }
        catch (error) {
          if (error instanceof Error && error.message === 'SIGNED_MINT_QUANTITY_UNAVAILABLE' && quantity > 1) result[index] = await verifySignedWalletAuthorization(authorization, input.clients, 1, now());
          else throw error;
        }
      };
      // The shared requester still spaces official API calls. Two workers overlap
      // independent RPC validation without a ten-wallet sequential freshness gap.
      let next = 0;
      const worker = async (): Promise<void> => {
        for (;;) { const index = next++; if (index >= wallets.length) return; await authorize(wallets[index]!, index); }
      };
      await Promise.all(Array.from({ length: Math.min(2, wallets.length) }, worker));
      const authorizations = result.filter((entry): entry is VerifiedSignedWalletAuthorization => entry !== undefined);
      if (!authorizations.length) throw new Error(fundingRejected ? 'OPENSEA_MINT_FUNDING_REQUIRED' : 'SIGNED_MINT_OWN_SIGNATURE_REQUIRED');
      return authorizations;
    },
  };
}
