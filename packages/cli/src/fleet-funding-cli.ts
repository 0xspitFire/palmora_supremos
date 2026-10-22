import { randomUUID } from 'node:crypto';
import { formatEth, planRunFunding, type BalanceCeilings, type Campaign, type FundingPlan } from '@mint-bot/backend';

/**
 * D-059 item 5, option 1: MintBot works out what each wallet needs for one run and asks the owner to send it. It never signs or
 * sends a funding transfer. This file only plans, words and records the request; the running service turns the recorded request
 * into the Telegram message, and the arm gate checks that the funds arrived.
 */
/** Network errors can quote the provider address, which is a secret. Any web address in an error is hidden before it is printed. */
export function redactAddresses(message: string): string {
  return message.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<address hidden>');
}

/** The phrase to type to accept a wallet's state. It names the wallet, its transaction count AND its balance, so it cannot be reused for another state. */
export function acceptPhrase(address: string, nonce: number, balanceWei: bigint): string {
  return `ACCEPT-WALLET-STATE ${address.toLowerCase().slice(-6)} nonce-${nonce} wei-${balanceWei}`;
}

export function requiredPerWallet(campaign: Pick<Campaign, 'mintPriceWei' | 'quantity' | 'feePolicy'>): bigint {
  const fee = campaign.feePolicy.totalFeeBudgetWei;
  if (fee === undefined) throw new Error('TOTAL_FEE_BUDGET_REQUIRED');
  return campaign.mintPriceWei * BigInt(campaign.quantity) + fee;
}

export function planCampaignFunding(input: { campaign: Pick<Campaign, 'chainId' | 'mintPriceWei' | 'quantity' | 'feePolicy'>; balances: ReadonlyArray<{ address: string; balanceWei: bigint }>; ceilings: BalanceCeilings }): FundingPlan {
  const required = requiredPerWallet(input.campaign);
  return planRunFunding({
    chainId: input.campaign.chainId,
    ceiling: input.ceilings[input.campaign.chainId],
    wallets: input.balances.map((wallet) => ({ address: wallet.address, balanceWei: wallet.balanceWei, requiredWei: required })),
  });
}

const BLOCKER_WORDS: Readonly<Record<string, string>> = {
  NO_BALANCE_CEILING_FOR_CHAIN: 'no balance limit is set for this chain, so no run can be funded here',
  NO_WALLETS: 'no wallets were given',
  MARGIN_INVALID: 'the rounding margin is invalid',
  RUN_ENVELOPE_ABOVE_FLEET_BOUND: 'together the wallets would hold more than the fleet limit allows for a funded run',
  WALLET_ADDRESS_INVALID: 'a wallet address is not valid',
};

function blockerText(blocker: string): string {
  const [code, wallet] = blocker.split(':');
  if (code === 'RUN_ENVELOPE_ABOVE_CHAIN_BOUND') return `wallet ${wallet} would need more than the largest balance allowed for a run. Reduce the quantity, or decide a higher run limit.`;
  if (code === 'WALLET_ABOVE_RUN_ENVELOPE') return `wallet ${wallet} already holds more than this run needs. Return the extra to your treasury wallet first; extra funds never raise a run's limit.`;
  if (code === 'DUPLICATE_WALLET') return `wallet ${wallet} is listed twice`;
  if (code === 'REQUIREMENT_INVALID') return `wallet ${wallet} has an invalid requirement`;
  return BLOCKER_WORDS[code ?? ''] ?? blocker;
}

/** Plain-language readout of the plan for the terminal. */
export function renderFundingPlan(plan: FundingPlan, treasury: string): string {
  const lines = ['FUNDING PLAN FOR ONE RUN (MintBot never sends funds; you send them from your treasury wallet)'];
  for (const item of plan.items) {
    const top = BigInt(item.topUpWei);
    lines.push(`${item.wallet}: holds ${formatEth(BigInt(item.balanceWei))} ETH, needs ${formatEth(BigInt(item.requiredWei))} ETH${top > 0n ? `, send ${formatEth(top)} ETH` : ', nothing to send'}`);
  }
  if (plan.blockers.length > 0) {
    lines.push('This run cannot be funded as asked:');
    for (const blocker of plan.blockers) lines.push(`- ${blockerText(blocker)}`);
  } else if (plan.ready) lines.push('Every wallet already holds what the run needs. Nothing to send.');
  else lines.push(`Total to send: ${formatEth(BigInt(plan.totalTopUpWei))} ETH, from ${treasury}. The run cannot arm until the balances show it arrived.`);
  return lines.join('\n');
}

/** The durable record the service turns into one Telegram message. Only amounts and public addresses. */
export function fundingRequestEvent(plan: FundingPlan, campaignId: string, now: Date): { type: 'fleet_funding_requested'; at: string; data: Record<string, unknown> } {
  if (plan.blockers.length > 0) throw new Error('FUNDING_PLAN_BLOCKED');
  const items = plan.items.filter((item) => BigInt(item.topUpWei) > 0n).map((item) => ({ wallet: item.wallet, topUpWei: item.topUpWei }));
  if (items.length === 0) throw new Error('FUNDING_NOT_NEEDED');
  return { type: 'fleet_funding_requested', at: now.toISOString(), data: { requestId: `fund_${randomUUID()}`, campaignId, chainId: plan.chainId, items } };
}
