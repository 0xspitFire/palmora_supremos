import { recordWalletSimulations, type BackendStore, type Campaign } from '@mint-bot/backend';
import { getStrategy, readTurnkeyApprovedPolicyRecords, turnkeyPolicySelection } from '@mint-bot/engine';
import type { Address, PublicClient } from 'viem';

export async function simulateAllowlistCampaign(input: { campaign: Campaign; wallets: readonly string[]; client: PublicClient; store: BackendStore; secretRoot: string }): Promise<{ recorded: string[]; skipped: Array<{ wallet: string; why: string }> }> {
  const c = input.campaign;
  if (c.strategy !== 'seadrop-v1-allowlist' || ![1, 8453, 4663].includes(c.chainId)) throw new Error('ALLOWLIST_CAMPAIGN_REQUIRED');
  const strategy = getStrategy(c.strategy);
  if (!c.custodyPolicy) throw new Error('ALLOWLIST_SIGNED_POLICY_REQUIRED');
  const policies = (await readTurnkeyApprovedPolicyRecords('mainnet', input.secretRoot)).filter((record) => {
    const selection = turnkeyPolicySelection(record);
    return selection.policyReference === c.custodyPolicy!.policyReference && selection.recordDigest === c.custodyPolicy!.recordDigest;
  });
  if (policies.length !== 1) throw new Error('ALLOWLIST_SIGNED_POLICY_REQUIRED');
  const drop = await strategy.readDrop(input.client, c.contract as Address, c.chainId as 1 | 8453 | 4663);
  if (!strategy.validateDrop(drop).valid || drop.mintPrice !== c.mintPriceWei || drop.maxTotalMintableByWallet < c.quantity) throw new Error('ALLOWLIST_STAGE_CHANGED_OR_CLOSED');
  const block = await input.client.getBlock();
  const recorded: string[] = [];
  const skipped: Array<{ wallet: string; why: string }> = [];
  for (const wallet of input.wallets) {
    try {
      const data = strategy.buildCalldata(drop, wallet as Address, c.quantity);
      if (data !== policies[0]!.enforcementPolicy.transaction.data) throw new Error('ALLOWLIST_SIGNED_WALLET_CALL_REQUIRED');
      await input.client.call({ account: wallet as Address, to: drop.extra?.['seaDropAddress'] as Address, data, value: c.mintPriceWei * BigInt(c.quantity), blockNumber: block.number });
      recorded.push(wallet.toLowerCase());
    } catch { skipped.push({ wallet, why: 'Own-wallet proof or simulation did not pass.' }); }
  }
  await recordWalletSimulations(input.store, c, recorded.map((wallet) => ({ wallet, success: true })), { blockNumber: block.number, blockHash: block.hash });
  return { recorded, skipped };
}
