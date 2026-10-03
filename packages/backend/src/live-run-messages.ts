import { chainDisplay } from './alert-card.js';
import { buildSystemCard, type SystemCard, type SystemLine } from './system-card.js';
import { durationText, reasonCode, reasonText } from './system-messages.js';

/**
 * Message templates for live runs (T-030, D-045), written now for Phase 3.
 *
 * NOT WIRED: nothing in the coordinator, the engine or the live-run command calls these builders, and no message
 * from them is sent today. Wiring them is Phase 3 work and a separate, reviewed change. They only turn facts that a
 * caller passes in into a card; they never read the store, a key or a node, and they decide nothing.
 *
 * A transaction hash is shown shortened in the text (the redaction filter treats a full 64-digit hash as a secret)
 * and the full hash is reachable only through the explorer button, which is built from the validated hash.
 */

const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function shortHash(hash: string): string { return HASH.test(hash) ? `${hash.slice(0, 6)}…${hash.slice(-4)}` : 'unknown'; }
const shortAddress = (address: string): string => (ADDRESS.test(address) ? `${address.slice(0, 6)}…${address.slice(-4)}` : 'unknown');

interface RunFacts {
  runId: string;
  chainId: number;
  collection: string;
  wallet?: string;
  quantity?: number;
  at: Date | string;
}

const runLines = (facts: RunFacts): SystemLine[] => [
  { label: 'Collection', value: `${facts.collection} · ${chainDisplay(facts.chainId).name}` },
  ...(facts.wallet ? [{ label: 'Wallet', value: shortAddress(facts.wallet) } as SystemLine] : []),
  ...(facts.quantity !== undefined ? [{ label: 'Quantity', value: String(facts.quantity) } as SystemLine] : []),
];

const common = (facts: RunFacts, label: string) => ({ code: { label: 'Run', value: facts.runId }, dashboard: true as const, eventAt: facts.at, eventLabel: label });

export function runStartedCard(facts: RunFacts & { walletCount: number }): SystemCard {
  return buildSystemCard({
    title: 'LIVE RUN STARTED',
    severity: 'attention',
    lines: [
      { label: 'What happened', value: `a live run started for ${facts.walletCount} ${facts.walletCount === 1 ? 'wallet' : 'wallets'}.`, strong: true },
      ...runLines(facts),
      { label: 'What it means', value: 'real money can be spent now, only within your limits.' },
    ],
    steps: ['To stop it at any time, engage the kill switch from the terminal.'],
    ...common(facts, 'the run started'),
    summary: 'Live run started.',
  });
}

export function mintSubmittedCard(facts: RunFacts & { hash: string; priceWei?: string }): SystemCard {
  return buildSystemCard({
    title: 'MINT SUBMITTED',
    severity: 'info',
    lines: [
      { label: 'What happened', value: 'a mint transaction was sent to the network.', strong: true },
      ...runLines(facts),
      { label: 'Transaction', value: shortHash(facts.hash) },
      { label: 'What it means', value: 'it is not final yet. You will get a message when it is confirmed or fails.' },
    ],
    steps: [],
    txLinks: [{ text: 'Transaction', chainId: facts.chainId, hash: facts.hash }],
    ...common(facts, 'it was sent'),
    summary: 'Mint submitted.',
  });
}

export function mintConfirmedCard(facts: RunFacts & { hash: string; feePaid?: string }): SystemCard {
  return buildSystemCard({
    title: 'MINT CONFIRMED',
    severity: 'info',
    lines: [
      { label: 'What happened', value: 'the mint was confirmed on the chain.', strong: true },
      ...runLines(facts),
      { label: 'Transaction', value: shortHash(facts.hash) },
      ...(facts.feePaid ? [{ label: 'Network fee paid', value: facts.feePaid, strong: true } as SystemLine] : []),
      { label: 'What it means', value: facts.wallet ? 'the NFT is in the wallet above.' : 'the NFT is in your wallet.' },
    ],
    steps: [],
    txLinks: [{ text: 'Transaction', chainId: facts.chainId, hash: facts.hash }],
    ...common(facts, 'it was confirmed'),
    summary: 'Mint confirmed.',
  });
}

export function mintFailedCard(facts: RunFacts & { hash?: string; reason?: string }): SystemCard {
  return buildSystemCard({
    title: 'MINT FAILED',
    severity: 'critical',
    lines: [
      { label: 'What happened', value: 'the mint did not go through.', strong: true },
      ...runLines(facts),
      { label: 'Why', value: reasonText(reasonCode(facts.reason), 'the network or the contract refused it') },
      ...(facts.hash ? [{ label: 'Transaction', value: shortHash(facts.hash) } as SystemLine] : []),
      { label: 'What it means', value: 'you did not get an NFT from this attempt. A failed transaction can still cost a network fee.' },
    ],
    steps: ['Open the run on the dashboard and read its result before trying again.'],
    ...(facts.hash && HASH.test(facts.hash) ? { txLinks: [{ text: 'Transaction', chainId: facts.chainId, hash: facts.hash }] } : {}),
    ...common(facts, 'it failed'),
    summary: 'Mint failed.',
  });
}

export function mintBlockedCard(facts: RunFacts & { reason?: string }): SystemCard {
  return buildSystemCard({
    title: 'MINT BLOCKED',
    severity: 'attention',
    lines: [
      { label: 'What happened', value: 'a mint was stopped before anything was sent.', strong: true },
      ...runLines(facts),
      { label: 'Why', value: reasonText(reasonCode(facts.reason), 'a safety check stopped it') },
      { label: 'What it means', value: 'nothing was bought or spent.' },
    ],
    steps: [],
    ...common(facts, 'it was blocked'),
    summary: 'Mint blocked.',
  });
}

/** The outcome could not be settled (for example a sent transaction that cannot be found). Nothing may be assumed either way. */
export function ambiguousSubmissionCard(facts: RunFacts & { hash?: string }): SystemCard {
  return buildSystemCard({
    title: 'MINT RESULT UNKNOWN',
    severity: 'critical',
    lines: [
      { label: 'What happened', value: 'a mint was sent but the bot cannot yet tell whether it went through.', strong: true },
      ...runLines(facts),
      ...(facts.hash ? [{ label: 'Transaction', value: shortHash(facts.hash) } as SystemLine] : []),
      { label: 'What it means', value: 'do not send it again by hand. The bot keeps checking, and new mints stay blocked until this is settled.', strong: true },
    ],
    steps: ['Look at the transaction on the explorer button below.', 'Wait for the next message; it says how this ended.'],
    ...(facts.hash && HASH.test(facts.hash) ? { txLinks: [{ text: 'Transaction', chainId: facts.chainId, hash: facts.hash }] } : {}),
    ...common(facts, 'it was sent'),
    summary: 'Mint result unknown.',
  });
}

export interface RunSummaryFacts {
  runId: string;
  chainId: number;
  collection: string;
  confirmed: number;
  failed: number;
  blocked: number;
  unknown: number;
  /** Total network fees paid, as text with its unit. */
  feesPaid?: string;
  /** Total mint price paid, as text with its unit. */
  spent?: string;
  durationSeconds: number;
  at: Date | string;
}

export function runSummaryCard(facts: RunSummaryFacts): SystemCard {
  const clean = facts.failed === 0 && facts.unknown === 0;
  return buildSystemCard({
    title: 'LIVE RUN FINISHED',
    severity: facts.unknown > 0 ? 'critical' : clean ? 'info' : 'attention',
    lines: [
      { label: 'Collection', value: `${facts.collection} · ${chainDisplay(facts.chainId).name}` },
      { label: 'Result', value: `${facts.confirmed} confirmed · ${facts.failed} failed · ${facts.blocked} blocked · ${facts.unknown} unknown`, strong: true },
      ...(facts.spent ? [{ label: 'Spent on mints', value: facts.spent, strong: true } as SystemLine] : []),
      ...(facts.feesPaid ? [{ label: 'Network fees paid', value: facts.feesPaid } as SystemLine] : []),
      { label: 'Took', value: durationText(facts.durationSeconds) },
    ],
    steps: facts.unknown > 0 ? ['At least one mint is unsettled. Read the separate "result unknown" message.'] : facts.failed > 0 ? ['Open the run on the dashboard to see which mints failed and why.'] : [],
    code: { label: 'Run', value: facts.runId },
    dashboard: true,
    eventAt: facts.at,
    eventLabel: 'the run finished',
    summary: 'Live run finished.',
  });
}
