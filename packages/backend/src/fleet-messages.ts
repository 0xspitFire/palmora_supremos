import { buildSystemCard, type SystemCard } from './system-card.js';
import { chainDisplay } from './alert-card.js';
import { formatEth } from './intelligence/scoring.js';
import { roundUpToDisplay } from './fleet-funding.js';

/**
 * Owner messages for D-059: the funding request for one run, the left-over balance reminder, and the independent watcher's
 * findings. Each says what happened, what it means and what to do, in plain words. They carry public addresses and amounts only:
 * no secret, no endpoint and no free text from outside the program.
 */
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const checked = (address: string): string => {
  if (!ADDRESS.test(address)) throw new Error('FLEET_MESSAGE_ADDRESS_INVALID');
  return address.toLowerCase();
};
const eth = (wei: string | bigint): string => `${formatEth(BigInt(wei))} ETH`;
/** Amounts the owner must send are rounded up to the digits shown, so the amount sent is never short. */
const ethUp = (wei: string | bigint): string => eth(roundUpToDisplay(BigInt(wei)));

export function fundingRequestCard(input: { chainId: number; treasury: string; items: ReadonlyArray<{ wallet: string; topUpWei: string }>; runId?: string; at: Date | string }): SystemCard {
  const chain = chainDisplay(input.chainId).name;
  const items = input.items.map((item) => ({ wallet: checked(item.wallet), topUpWei: BigInt(item.topUpWei) })).filter((item) => item.topUpWei > 0n);
  const total = items.reduce((sum, item) => sum + item.topUpWei, 0n);
  const shown = items.slice(0, 4);
  return buildSystemCard({
    title: 'FUNDING NEEDED FOR A RUN',
    severity: 'attention',
    lines: [
      { label: 'What happened', value: `a run on ${chain} needs more funds in ${items.length} ${items.length === 1 ? 'wallet' : 'wallets'} than the small balance they hold now.`, strong: true },
      { label: 'Total to send', value: ethUp(total), strong: true },
      { label: 'What it means', value: 'the run cannot start until the funds arrive. The bot never sends funds itself.' },
    ],
    steps: [
      ...shown.map((item) => `Send ${ethUp(item.topUpWei)} to ${item.wallet}.`),
      ...(items.length > shown.length ? [`Send the remaining ${items.length - shown.length} amounts shown in the terminal with: fleet-funding-plan.`] : []),
      `Send them from your treasury wallet ${checked(input.treasury)}. The bot checks the balances itself before it lets the run start.`,
    ].slice(0, 6),
    code: { label: 'Treasury', value: checked(input.treasury) },
    ...(input.runId ? {} : {}),
    eventAt: input.at,
    eventLabel: 'the request',
    summary: `Funding needed: ${ethUp(total)} for ${items.length} wallets.`,
  });
}

export function excessBalanceCard(input: { chainId: number; treasury: string; reminders: ReadonlyArray<{ wallet: string; excessWei: string; idleMs: number }>; at: Date | string }): SystemCard {
  const chain = chainDisplay(input.chainId).name;
  const shown = input.reminders.slice(0, 4);
  const total = input.reminders.reduce((sum, item) => sum + BigInt(item.excessWei), 0n);
  return buildSystemCard({
    title: 'LEFT-OVER BALANCE REMINDER',
    severity: 'attention',
    lines: [
      { label: 'What happened', value: `${input.reminders.length} ${input.reminders.length === 1 ? 'wallet' : 'wallets'} on ${chain} ${input.reminders.length === 1 ? 'has' : 'have'} held more than the small balance limit for over a day with no activity.`, strong: true },
      { label: 'Extra held', value: eth(total), strong: true },
      { label: 'What it means', value: 'nothing is wrong. A smaller balance means less is at stake if a wallet is ever compromised.' },
    ],
    steps: [
      ...shown.map((item) => `Return about ${eth(item.excessWei)} from ${checked(item.wallet)} to your treasury wallet ${checked(input.treasury)}.`),
      'You can also leave it for the next run. This reminder repeats every 24 hours until it is returned or a run starts.',
    ],
    eventAt: input.at,
    eventLabel: 'the check',
    summary: `Left-over balance: ${eth(total)} above the limit.`,
  });
}

export type FleetWatchFinding = 'unknown_activity' | 'unexplained_fall' | 'rise_above_limit' | 'rpc_inconsistent' | 'watcher_blind' | 'baseline_accepted' | 'accept_rejected';

const WATCH_WORDS: Readonly<Record<FleetWatchFinding, { title: string; severity: 'critical' | 'attention'; what: string; means: string; steps: string[] }>> = {
  unknown_activity: {
    title: 'UNKNOWN ACTIVITY ON A WALLET',
    severity: 'critical',
    what: 'a wallet sent a transaction that MintBot did not make.',
    means: 'the kill switch is engaged and nothing more will be signed. The wallet keys may be compromised.',
    steps: ['Do not release the kill switch.', 'Revoke the Turnkey API key and policy for this fleet.', 'Move any funds out of the affected wallets to your treasury wallet and retire the wallets.', 'Tell the assistant, which will check the records with you.'],
  },
  unexplained_fall: {
    title: 'WALLET BALANCE FELL WITHOUT A RECORD',
    severity: 'critical',
    what: 'a wallet lost more than any recorded mint can explain.',
    means: 'the kill switch is engaged and nothing more will be signed. Funds may have left without MintBot.',
    steps: ['Do not release the kill switch.', 'Look up the wallet on a block explorer to see where the funds went.', 'Revoke the Turnkey API key and policy for this fleet, and retire the wallets.', 'Tell the assistant, which will check the records with you.'],
  },
  rise_above_limit: {
    title: 'WALLET HOLDS MORE THAN ITS LIMIT',
    severity: 'attention',
    what: 'a wallet received funds that put it above its small balance limit.',
    means: 'nothing is blocked. If you did not send the funds, someone else did.',
    steps: ['If you sent them for a run, no action is needed.', 'Otherwise return the extra to your treasury wallet.'],
  },
  rpc_inconsistent: {
    title: 'WALLET CHECK GAVE AN ODD ANSWER',
    severity: 'attention',
    what: 'the network provider reported a lower transaction count for a wallet than before.',
    means: 'this is most often a stale provider answer. The watcher keeps its last good record and tries again.',
    steps: ['Nothing is needed unless this repeats; then check the provider status.'],
  },
  watcher_blind: {
    title: 'WALLET WATCHER CANNOT SEE THE CHAIN',
    severity: 'attention',
    what: 'the wallet watcher could not read a wallet\'s network state correctly for several checks in a row.',
    means: 'unexpected wallet activity would not be noticed until it can read again. The watcher is not covering this wallet right now.',
    steps: ['Check the network provider status and the host connection.', 'Do not start a run until this message clears.'],
  },
  baseline_accepted: {
    title: 'WALLET STATE ACCEPTED',
    severity: 'attention',
    what: 'a wallet\'s current on-chain state was accepted as its new baseline.',
    means: 'the watcher now compares future activity against this state. The kill switch was not changed.',
    steps: ['If you did not accept this state yourself, treat it as a security problem and keep the kill switch engaged.'],
  },
  accept_rejected: {
    title: 'WALLET STATE ACCEPT REJECTED',
    severity: 'attention',
    what: 'a request to accept a wallet\'s state was ignored because it did not match the chain (dated in the future, or ahead of the wallet\'s real transaction count).',
    means: 'the watcher kept its previous baseline. This should not happen with the normal command.',
    steps: ['If you did not run the accept command, treat it as a security problem and keep the kill switch engaged.', 'Otherwise run the accept command again.'],
  },
};

export function fleetWatchCard(input: { finding: FleetWatchFinding; chainId: number; wallet?: string; detail?: string; killFailed?: boolean; at: Date | string }): SystemCard {
  const base = WATCH_WORDS[input.finding];
  // When the automatic kill could not be engaged, never say that signing has stopped: say the opposite and put the manual step first.
  const words = input.killFailed && (input.finding === 'unknown_activity' || input.finding === 'unexplained_fall')
    ? { ...base, means: 'the bot could NOT engage the kill switch by itself, so signing may still be possible. The wallet keys may be compromised.', steps: ['Engage the kill switch yourself now from the terminal, before anything else.', ...base.steps.filter((step) => step !== 'Do not release the kill switch.')] }
    : base;
  return buildSystemCard({
    title: words.title,
    severity: words.severity,
    lines: [
      { label: 'What happened', value: words.what, strong: true },
      { label: 'Chain', value: chainDisplay(input.chainId).name },
      ...(input.wallet ? [{ label: 'Wallet', value: checked(input.wallet) }] : []),
      ...(input.detail ? [{ label: 'Detail', value: input.detail }] : []),
      { label: 'What it means', value: words.means },
    ],
    steps: words.steps,
    eventAt: input.at,
    eventLabel: 'the check',
    summary: input.killFailed ? `${words.title.toLowerCase()}; the kill switch could not be engaged.` : `${words.title.toLowerCase()}.`,
  });
}
