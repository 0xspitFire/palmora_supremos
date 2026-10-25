import { randomBytes } from 'node:crypto';
import type { InlineButton } from './telegram-api.js';

/**
 * T-073/T-074 (D-069): guided flows for the mint steps, driven by buttons, with a typed "Custom" entry wherever there are presets.
 * Orders follow how the commands work today: prepare (kill switch ON, no unlock) → test mints when the mint is open → release (unlock)
 * → fire, or send a request, or schedule (kill switch OFF, unlock). Nothing has to be copied from one message into the next.
 *
 * Every button is the owner's, expires after 15 minutes idle, and carries only a one-time flow id, a step number and a short key:
 * the values (a campaign, a wallet, a fee) live in memory here and are rebuilt by the server at the final tap. The final tap
 * calls the same action as the typed command, with the confirmation phrase built by the server from a fresh plan and compared with
 * the one the owner reviewed. A custom entry is checked before it is used; a wrong one is refused in plain words and the flow stays
 * where it was.
 */
export type ChainKey = 'ethereum' | 'base' | 'robinhood';
/** `phrase` is the confirmation phrase the server built for exactly these figures; the final tap must still produce the same one. */
export interface GuidedPlan { text: string; ok: boolean; ready: string[]; quantity: number; maxQuantity: number; phrase?: string }
export interface GuidedCampaign { id: string; label: string; note: string }
export interface FeeOptions { presets: number[]; limit: number | undefined; unit: string }

/** What a flow needs from the bot's actions. The Telegram actions implement all of it. */
export interface GuidedActions {
  guidedChains(): Promise<Array<{ key: ChainKey; name: string }>>;
  guidedPlan(chain: string, contract: string, quantity: number | undefined, walletCount: number | undefined): Promise<GuidedPlan>;
  /** `expectedPhrase` is the phrase of the plan the owner reviewed; a changed plan is refused. */
  guidedPrepare(chain: string, contract: string, quantity: number, wallets: string[], expectedPhrase?: string): Promise<{ text: string; campaignId: string | undefined }>;
  /** `phrase` names the kill engagement being looked at (its time); the release tap is refused if the switch was engaged again since. */
  releaseStatus(): Promise<{ text: string; canRelease: boolean; phrase?: string }>;
  releaseNow(expectedPhrase?: string): Promise<string>;
  guidedCampaigns(): Promise<GuidedCampaign[]>;
  signingWallets(): Promise<string[]>;
  feeOptions(campaignId: string): Promise<FeeOptions>;
  /** Records the test mints; says which wallets passed and how many wallets the campaign was sized for. */
  simulateCampaign(campaignId: string): Promise<{ text: string; recorded: string[]; sized: number }>;
  requestCandidates(): Promise<GuidedCampaign[]>;
  requestWallets(campaignId: string): Promise<{ wallets: string[]; sized: number; note?: string }>;
  requestPreview(campaignId: string, wallets: string, maxFeeGwei: number): Promise<{ text: string; phrase: string; wallets: string[] }>;
  /** `expectedPhrase` is the phrase of the preview the owner saw; a changed request is refused. */
  requestSend(campaignId: string, wallets: string, maxFeeGwei: number, expectedPhrase: string): Promise<string>;
  cancellables(): Promise<Array<{ id: string; label: string }>>;
  cancel(id: string): Promise<string>;
  funding(campaignId: string | undefined): Promise<string>;
  /** D-070: the chains that can be switched off (Base and Robinhood, when on). */
  revokeChoices(): Promise<Array<{ key: ChainKey; name: string }>>;
  /** `phrase` names the enablement record being looked at; the tap is refused if a different record is current by then. */
  revokeStatus(chain: string): Promise<{ text: string; phrase?: string }>;
  revokeNow(chain: string, expectedPhrase: string): Promise<string>;
  /** D-070: the chains with watched wallets, the wallets, and what the wallet looks like now (`phrase` names that state). */
  watchChains(): Promise<Array<{ key: ChainKey; name: string }>>;
  watchWallets(chain: string): Promise<string[]>;
  watchStatus(chain: string, address: string): Promise<{ text: string; phrase: string }>;
  watchAcceptNow(chain: string, address: string, expectedPhrase: string): Promise<string>;
  recentRuns(): Promise<Array<{ id: string; label: string }>>;
  run(runId: string): Promise<string>;
  firePreview(campaignId: string, wallets: string, maxFeeGwei: number): Promise<{ text: string; wallets: string[]; digest?: string }>;
  fireNow(campaignId: string, wallets: string, maxFeeGwei: number, digest?: string): Promise<string>;
  schedulePreview(campaignId: string, wallets: string, maxFeeGwei: number, from: string, until: string): Promise<{ text: string; phrase: string; wallets: string[]; from: string; until: string; digest?: string }>;
  scheduleCreate(campaignId: string, wallets: string, maxFeeGwei: number, from: string, until: string, phrase: string, digest?: string): Promise<string>;
}

export type FlowKind = 'prepare' | 'simulate' | 'release' | 'request' | 'fire' | 'schedule' | 'cancel' | 'funding' | 'run' | 'revoke' | 'watchaccept';
export interface FlowReply { text: string; buttons?: InlineButton[][] }
/** What the router records after a flow finishes its last action: the command name and `ok` or `refused:CODE`. */
export interface FlowDone { command: FlowKind; outcome: string }
export interface FlowResult { reply: FlowReply; done?: FlowDone }

/** Values a command typed with all its arguments hands to a flow, so it shows the summary and its button instead of a phrase to copy. */
export interface FlowPreset {
  chain?: string; contract?: string; address?: string;
  campaign?: string; wallets?: string[] | 'all'; fee?: number; from?: string; until?: string;
}

type StepName = 'chain' | 'contract' | 'quantity' | 'count' | 'campaign' | 'wallets' | 'wallet' | 'fee' | 'window' | 'pick' | 'review';
const PLAN: Readonly<Record<FlowKind, readonly StepName[]>> = {
  prepare: ['chain', 'contract', 'quantity', 'count', 'review'],
  simulate: ['campaign', 'review'],
  release: ['review'],
  request: ['campaign', 'wallets', 'fee', 'review'],
  fire: ['campaign', 'wallets', 'fee', 'review'],
  schedule: ['campaign', 'wallets', 'fee', 'window', 'review'],
  cancel: ['pick'],
  funding: ['pick'],
  run: ['pick'],
  revoke: ['chain', 'review'],
  watchaccept: ['chain', 'wallet', 'review'],
};
const NAMES: Readonly<Record<FlowKind, string>> = { prepare: 'Prepare A Live Campaign', simulate: 'Record Test Mints', release: 'Release The Kill Switch', request: 'Send A Live Request', fire: 'Fire A Campaign', schedule: 'Schedule A Mint', cancel: 'Cancel A Request Or Schedule', funding: 'Funding For A Campaign', run: 'Look At A Run', revoke: 'Switch A Chain Off', watchaccept: 'Accept A Wallet Change' };

interface Awaiting { field: 'contract' | 'quantity' | 'count' | 'wallets' | 'address' | 'fee' | 'window' }
interface Flow {
  id: string;
  kind: FlowKind;
  step: number;
  touchedAt: number;
  wrong: number;
  options: Map<string, unknown>;
  /** Set when a step offers a Custom… button; a stray Custom tap at any other step is refused. */
  customOk?: boolean;
  /** When the final confirmation was shown. */
  confirmAt?: number;
  awaiting?: Awaiting;
  data: Record<string, unknown>;
}

export const FLOW_LIFETIME_MS = 15 * 60_000;
/** The last tap (Release, Prepare, Record, Send Request, Fire Now, Store Schedule) is good for 2 minutes from the moment its summary is shown, like the kill and fire buttons. */
export const CONFIRM_LIFETIME_MS = 2 * 60_000;
const MAX_WRONG = 3;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const short = (address: string): string => `${address.slice(0, 6)}…${address.slice(-4)}`;
/** Whether a tap needs the unlocked session: release, fire and schedule at every tap; a request only at its last tap (it is a read until then). */
/** (A revoke needs none, like `/kill` and the typed `/revoke`: turning something off is never held back by the session.) */
export const flowNeedsSession = (kind: FlowKind, key?: string): boolean => (kind === 'release' || kind === 'fire' || kind === 'schedule' || kind === 'watchaccept') || (kind === 'request' && key === 'go');

export interface GuidedDeps {
  actions: GuidedActions;
  now(): Date;
  /** Turns an error into the plain text shown to the owner (secrets and long hex removed). */
  explain(error: unknown): string;
  newId?(): string;
}

type Choice = { label: string; value: unknown };
const NO_LONGER_VALID = 'That button is no longer valid. Use the buttons on the latest message, or send the command again.';

export class GuidedFlows {
  private flow: Flow | undefined;
  // Taps and typed answers are handled one at a time, so two quick taps on the same button cannot both act.
  private chain: Promise<unknown> = Promise.resolve();
  public constructor(private readonly deps: GuidedDeps) {}
  private serial<T>(work: () => Promise<T>): Promise<T> { const run = this.chain.then(work, work); this.chain = run.catch(() => undefined); return run; }

  /** True while a flow is open and has not expired. */
  public active(): FlowKind | undefined { return this.live()?.kind; }
  public kind(flowId: string): FlowKind | undefined { const flow = this.live(); return flow?.id === flowId ? flow.kind : undefined; }

  private live(): Flow | undefined {
    if (this.flow && this.deps.now().getTime() - this.flow.touchedAt > FLOW_LIFETIME_MS) this.flow = undefined;
    return this.flow;
  }

  /** Another command was sent: a flow no longer waits for typed text (its buttons still work). */
  public interrupt(): void { const flow = this.live(); if (flow) delete flow.awaiting; }

  private make(kind: FlowKind, step = 0, data: Record<string, unknown> = {}): Flow {
    const flow: Flow = { id: (this.deps.newId ?? (() => randomBytes(4).toString('hex')))(), kind, step, touchedAt: this.deps.now().getTime(), wrong: 0, options: new Map(), data };
    this.flow = flow;
    return flow;
  }

  private name(flow: Flow): StepName { return PLAN[flow.kind][flow.step]!; }

  public start(kind: FlowKind, preset?: FlowPreset): Promise<FlowResult> { return this.serial(() => this.begin(kind, preset)); }

  private async begin(kind: FlowKind, preset?: FlowPreset): Promise<FlowResult> {
    const flow = this.make(kind);
    const d = flow.data as Record<string, any>;
    try {
      if (preset && kind === 'prepare' && preset.chain && preset.contract) {
        d.chain = preset.chain;
        flow.step = 1;
        return await this.typed(flow, 'contract', preset.contract);
      }
      if (preset && kind === 'revoke' && preset.chain) {
        d.chain = preset.chain;
        flow.step = 1;
        return await this.render(flow);
      }
      if (preset && kind === 'watchaccept' && preset.chain && preset.address) {
        if (!ADDRESS.test(preset.address)) throw new Error('ADDRESS_INVALID: that is not a wallet address');
        d.chain = preset.chain; d.address = preset.address.toLowerCase();
        flow.step = 2;
        return await this.render(flow);
      }
      if (preset && kind === 'simulate' && preset.campaign) {
        d.campaign = preset.campaign; d.campaignLabel = `campaign ${preset.campaign}`;
        flow.step = 1;
        return await this.render(flow);
      }
      if (preset && (kind === 'request' || kind === 'fire') && preset.campaign && preset.wallets && preset.fee !== undefined) {
        d.campaign = preset.campaign; d.wallets = preset.wallets;
        flow.step = 2;
        await this.checkFee(preset.campaign, preset.fee);
        return await this.takeFee(flow, preset.fee);
      }
      if (preset && kind === 'schedule' && preset.campaign && preset.wallets && preset.fee !== undefined && preset.from && preset.until) {
        await this.checkFee(preset.campaign, preset.fee);
        d.campaign = preset.campaign; d.wallets = preset.wallets; d.fee = preset.fee;
        flow.step = 3;
        return await this.takeWindow(flow, preset.from, preset.until);
      }
      return await this.render(flow);
    } catch (error) { return this.failed(flow, error); }
  }

  /** The same fee rule as a typed Custom entry: a plain number above 0, at most the Turnkey policy limit where there is one. */
  private async checkFee(campaignId: string, fee: number): Promise<void> {
    const fees = await this.deps.actions.feeOptions(campaignId);
    const limit = fees.limit ?? 500;
    if (!(fee > 0)) throw new Error(`MAX_FEE_GWEI_REQUIRED: the fee ceiling must be above 0 ${fees.unit}`);
    if (fee > limit) throw new Error(`MAX_FEE_GWEI_ABOVE_LIMIT: ${fee} ${fees.unit} is above the limit of ${limit} ${fees.unit}${fees.limit !== undefined ? ' set by your Turnkey policy' : ''}`);
  }

  /** `/simulate <campaign>` typed in full: record the test mints now, then go straight on to choosing the wallets for the request. */
  public runSimulate(campaignId: string): Promise<FlowResult> {
    return this.serial(async () => {
      const flow = this.make('simulate', 1, { campaign: campaignId });
      try { return await this.recordTestMints(campaignId); } catch (error) { return this.failed(flow, error); }
    });
  }

  public cancel(): FlowResult { this.flow = undefined; return { reply: { text: 'Cancelled. Nothing was changed.' } }; }

  public onButton(flowId: string, code: string): Promise<FlowResult> { return this.serial(() => this.handleButton(flowId, code)); }

  private async handleButton(flowId: string, code: string): Promise<FlowResult> {
    const flow = this.live();
    if (!flow || flow.id !== flowId) return { reply: { text: 'That button has expired. Send the command again to start over.' } };
    const step = Number(code[0]);
    const key = code.slice(1);
    // Cancel works from any step.
    if (code === 'x' || key === 'x') return this.cancel();
    if (!Number.isInteger(step) || step !== flow.step) return { reply: { text: 'That button is from an earlier step. Use the buttons on the latest message, or send the command again to start over.' } };
    flow.touchedAt = this.deps.now().getTime();
    try { return await this.press(flow, key); } catch (error) { return this.failed(flow, error); }
  }

  /** Typed text while a flow waits for it. Returns undefined when nothing is waiting (the message is not an answer). */
  public onText(text: string): Promise<FlowResult | undefined> { return this.serial(() => this.handleText(text)); }

  private async handleText(text: string): Promise<FlowResult | undefined> {
    const flow = this.live();
    if (!flow?.awaiting) return undefined;
    flow.touchedAt = this.deps.now().getTime();
    try { return await this.typed(flow, flow.awaiting.field, text.trim()); } catch (error) { return this.failed(flow, error); }
  }

  // ── rendering ─────────────────────────────────────────────────────────────────────────────────────

  private failed(flow: Flow, error: unknown): FlowResult {
    // An action refused: say why in plain words. The flow keeps its place so the owner can fix the cause and tap again, or cancel.
    return { reply: { text: `Not done: ${this.deps.explain(error)}`, buttons: [[{ text: 'Cancel', callback_data: this.cb(flow, 'x') }]] } };
  }

  private cb(flow: Flow, key: string): string { return `/f_${flow.id}_${flow.step}${key}`; }
  private cancelRow(flow: Flow): InlineButton[] { return [{ text: 'Cancel', callback_data: `/f_${flow.id}_${flow.step}x` }]; }
  /** The step heading, and the campaign id right under it once a campaign is chosen, so it is always in view (and one tap to copy). */
  private title(flow: Flow): string {
    const steps = PLAN[flow.kind].length;
    const heading = steps === 1 ? NAMES[flow.kind] : `${NAMES[flow.kind]} · Step ${flow.step + 1} Of ${steps}`;
    const data = flow.data as Record<string, unknown>;
    const campaign = data.campaign;
    // `idShown` means the text above this step already shows the campaign id: skip it for this one step only, then show it on every later step.
    const skip = data.idShown === true;
    delete data.idShown;
    return typeof campaign === 'string' && !skip ? `${heading}\nCampaign: ${campaign}` : heading;
  }

  /** Buttons for a list of choices (two per row), plus Custom when allowed, plus Cancel. Values stay here; the buttons carry only keys. */
  private choices(flow: Flow, choices: Choice[], custom: boolean): InlineButton[][] {
    flow.options.clear();
    flow.customOk = custom;
    const buttons: InlineButton[] = choices.map((choice, index) => { flow.options.set(`o${index + 1}`, choice.value); return { text: choice.label, callback_data: this.cb(flow, `o${index + 1}`) }; });
    const rows: InlineButton[][] = [];
    for (let index = 0; index < buttons.length; index += 2) rows.push(buttons.slice(index, index + 2));
    if (custom) rows.push([{ text: 'Custom…', callback_data: this.cb(flow, 'cu') }]);
    rows.push(this.cancelRow(flow));
    return rows;
  }

  private ask(flow: Flow, field: Awaiting['field'], text: string): FlowResult {
    flow.awaiting = { field };
    return { reply: { text, buttons: [[{ text: 'Back To Choices', callback_data: this.cb(flow, 'bk') }, ...this.cancelRow(flow)]] } };
  }

  private campaignChoices(flow: Flow, head: string, campaigns: GuidedCampaign[], none: string): FlowResult {
    if (campaigns.length === 0) { this.flow = undefined; return { reply: { text: none } }; }
    (flow.data as Record<string, unknown>).labels = Object.fromEntries(campaigns.map((campaign) => [campaign.id, campaign.label]));
    const list = campaigns.map((campaign) => `• ${campaign.label} — ${campaign.note}`).join('\n');
    return { reply: { text: `${head}\n\nChoose the campaign.\n\n${list}`, buttons: this.choices(flow, campaigns.map((campaign) => ({ label: campaign.label, value: campaign.id })), false) } };
  }

  private async render(flow: Flow): Promise<FlowResult> {
    delete flow.awaiting;
    flow.customOk = false;
    delete flow.confirmAt;
    const head = this.title(flow);
    const d = flow.data as Record<string, any>;
    const a = this.deps.actions;
    switch (this.name(flow)) {
      case 'chain': {
        const chains = flow.kind === 'revoke' ? await a.revokeChoices() : flow.kind === 'watchaccept' ? await a.watchChains() : await a.guidedChains();
        if (chains.length === 0) { this.flow = undefined; return { reply: { text: flow.kind === 'revoke' ? 'Nothing to switch off: only Base and Robinhood can be switched off, and neither is on.' : 'No chain has watched wallets.' } }; }
        return { reply: { text: `${head}\n\nChoose the chain. ${flow.kind === 'prepare' ? 'Only chains that are switched on are listed.' : ''}`.trim(), buttons: this.choices(flow, chains.map((chain) => ({ label: chain.name, value: chain.key })), false) } };
      }
      case 'contract': return this.ask(flow, 'contract', `${head}\n\nSend the contract address as a message (0x followed by 40 letters or digits).`);
      case 'quantity': {
        const plan = d.plan as GuidedPlan;
        const max = Math.max(1, plan.maxQuantity);
        const presets = Array.from({ length: Math.min(3, max) }, (_unused, index) => index + 1);
        return { reply: { text: `${head}\n\n${plan.text}\n\nHow many NFTs per wallet? The drop allows up to ${max}.`, buttons: this.choices(flow, presets.map((value) => ({ label: String(value), value })), true) } };
      }
      case 'count': {
        const ready = (d.plan as GuidedPlan).ready.length;
        const presets: Choice[] = [...[1, 2].filter((value) => value < ready).map((value) => ({ label: `${value} wallet${value === 1 ? '' : 's'}`, value })), { label: `All ready (${ready})`, value: ready }];
        return { reply: { text: `${head}\n\n${ready} wallet(s) are ready. How many should this campaign be sized for? (The campaign can never use more wallets than this.)`, buttons: this.choices(flow, presets, ready > 1) } };
      }
      case 'wallet': {
        const wallets = await a.watchWallets(String(d.chain));
        return { reply: { text: `${head}\n\nWhich wallet changed? Choose it, or type its address with Custom.`, buttons: this.choices(flow, wallets.slice(0, 8).map((wallet) => ({ label: short(wallet), value: wallet })), true) } };
      }
      case 'campaign': {
        if (flow.kind === 'request') return this.campaignChoices(flow, head, await a.requestCandidates(), 'No campaign has fresh test mints. Record them when the mint is open: send /simulate.');
        return this.campaignChoices(flow, head, await a.guidedCampaigns(), 'No live campaign is prepared yet. Use /prepare first, then come back.');
      }
      case 'wallets': {
        if (flow.kind === 'request') {
          const { wallets, sized, note } = await a.requestWallets(String(d.campaign));
          d.tested = wallets; d.sized = sized;
          if (wallets.length === 0) { this.flow = undefined; return { reply: { text: `${head}\n\nNo wallet with a fresh test mint holds what a run needs, so there is nothing to send yet.${note ? `\n\n${note}` : ''}\n\nFund the wallet, then send /request again (the test mints stay good for 30 minutes).` } }; }
          const usable = Math.min(wallets.length, sized);
          const choices: Choice[] = [{ label: `All Tested (${usable})`, value: 'all' }, ...wallets.slice(0, 6).map((wallet) => ({ label: short(wallet), value: wallet }))];
          const sizedNote = wallets.length > sized ? ` This campaign was sized for ${sized} wallet(s), so a request uses at most ${sized}.` : '';
          const extra = note;
          return { reply: { text: `${head}\n\nWhich wallets? ${wallets.length} wallet(s) have fresh test mints and enough ETH for a run.${sizedNote}${extra ? `\n\n${extra}` : ''}`, buttons: this.choices(flow, choices, true) } };
        }
        const wallets = await a.signingWallets();
        const choices: Choice[] = [{ label: `All Signing Wallets (${wallets.length})`, value: 'all' }, ...wallets.slice(0, 6).map((wallet) => ({ label: short(wallet), value: wallet }))];
        return { reply: { text: `${head}\n\nWhich wallets? A wallet that fails its test mint is left out and named.`, buttons: this.choices(flow, choices, true) } };
      }
      case 'fee': {
        const fees = await a.feeOptions(String(d.campaign));
        const limitNote = fees.limit !== undefined ? ` Your Turnkey policy allows at most ${fees.limit} ${fees.unit}.` : '';
        return { reply: { text: `${head}\n\nChoose the fee ceiling (${fees.unit}). The service never signs above it.${limitNote}`, buttons: this.choices(flow, fees.presets.map((value) => ({ label: `${value} ${fees.unit}`, value })), true) } };
      }
      case 'window': {
        const windows: Choice[] = [['now', '+1h', 'Now To +1 H'], ['now', '+2h', 'Now To +2 H'], ['now', '+3h', 'Now To +3 H'], ['now', '+6h', 'Now To +6 H']].map(([from, until, label]) => ({ label: label!, value: { from, until } }));
        return { reply: { text: `${head}\n\nChoose the window in which the service may fire when the mint opens (at most 6 hours).`, buttons: this.choices(flow, windows, true) } };
      }
      case 'pick': {
        if (flow.kind === 'cancel') {
          const items = await a.cancellables();
          if (items.length === 0) { this.flow = undefined; return { reply: { text: 'Nothing is waiting: no request the service has not started, and no open scheduled mint.' } }; }
          return { reply: { text: `${head}\n\nChoose what to cancel. The service has not started any of these.`, buttons: this.choices(flow, items.map((item) => ({ label: item.label, value: item.id })), false) } };
        }
        if (flow.kind === 'run') {
          const runs = await a.recentRuns();
          if (runs.length === 0) { this.flow = undefined; return { reply: { text: 'No runs yet.' } }; }
          return { reply: { text: `${head}\n\nChoose a run (newest first).`, buttons: this.choices(flow, runs.map((item) => ({ label: item.label, value: item.id })), false) } };
        }
        return this.campaignChoices(flow, head, await a.guidedCampaigns(), 'No live campaign is recorded. Prepare one with /prepare.');
      }
      case 'review': break;
    }
    // The last step of each flow: a summary and one button. The tap is good for 2 minutes from now.
    flow.options.clear();
    flow.confirmAt = this.deps.now().getTime();
    if (flow.kind === 'release') {
      const status = await a.releaseStatus();
      d.releasePhrase = status.phrase;
      return { reply: { text: `${head}\n\n${status.text}`, buttons: status.canRelease ? [[{ text: 'Release The Kill Switch', callback_data: this.cb(flow, 'go') }], this.cancelRow(flow)] : [this.cancelRow(flow)] } };
    }
    if (flow.kind === 'revoke') {
      const status = await a.revokeStatus(String(d.chain));
      d.phrase = status.phrase;
      return { reply: { text: `${head}\n\n${status.text}`, buttons: status.phrase ? [[{ text: 'Switch It Off', callback_data: this.cb(flow, 'go') }], this.cancelRow(flow)] : [this.cancelRow(flow)] } };
    }
    if (flow.kind === 'watchaccept') {
      const status = await a.watchStatus(String(d.chain), String(d.address));
      d.phrase = status.phrase;
      return { reply: { text: `${head}\n\n${status.text}`, buttons: [[{ text: 'Accept This Change', callback_data: this.cb(flow, 'go') }], this.cancelRow(flow)] } };
    }
    if (flow.kind === 'simulate') {
      const label = String(((d.labels as Record<string, string> | undefined)?.[String(d.campaign)]) ?? (d.campaignLabel as string | undefined) ?? 'the campaign');
      return { reply: { text: `${head}\n\nRecord a test mint for each wallet on ${label}. Test mints only pass once the mint is open, and each record is good for 30 minutes. Nothing is sent or spent.`, buttons: [[{ text: 'Record Test Mints', callback_data: this.cb(flow, 'go') }], this.cancelRow(flow)] } };
    }
    if (flow.kind === 'prepare') return { reply: { text: `${head}\n\nReview. This only records a campaign; it spends nothing.\n\n${(d.plan as GuidedPlan).text}`, buttons: [[{ text: 'Prepare (Spends Nothing)', callback_data: this.cb(flow, 'go') }], this.cancelRow(flow)] } };
    const label = flow.kind === 'fire' ? 'Fire Now' : flow.kind === 'request' ? 'Send Request' : 'Store Schedule';
    return { reply: { text: `${head}\n\n${String(d.summary)}`, buttons: [[{ text: label, callback_data: this.cb(flow, 'go') }], this.cancelRow(flow)] } };
  }

  private async advance(flow: Flow): Promise<FlowResult> { flow.step += 1; flow.wrong = 0; return this.render(flow); }

  // ── buttons ───────────────────────────────────────────────────────────────────────────────────────

  private async press(flow: Flow, key: string): Promise<FlowResult> {
    const d = flow.data as Record<string, any>;
    if (key === 'bk') return this.render(flow);
    if (key === 'cu') return flow.customOk ? this.custom(flow) : { reply: { text: NO_LONGER_VALID } };
    if (key === 'go') return this.finish(flow);
    if (!flow.options.has(key)) return { reply: { text: NO_LONGER_VALID } };
    const value = flow.options.get(key);
    switch (this.name(flow)) {
      case 'chain': d.chain = value; return this.advance(flow);
      case 'quantity': return this.takeQuantity(flow, Number(value));
      case 'count': return this.takeCount(flow, Number(value));
      case 'campaign': d.campaign = value; return this.advance(flow);
      case 'wallets': d.wallets = value === 'all' ? 'all' : [String(value)]; return this.advance(flow);
      case 'wallet': d.address = String(value); return this.advance(flow);
      case 'fee': return this.takeFee(flow, Number(value));
      case 'window': { const window = value as { from: string; until: string }; return this.takeWindow(flow, window.from, window.until); }
      case 'pick': return this.pick(flow, String(value));
      default: return { reply: { text: NO_LONGER_VALID } };
    }
  }

  private custom(flow: Flow): FlowResult {
    const d = flow.data as Record<string, any>;
    switch (this.name(flow)) {
      case 'quantity': return this.ask(flow, 'quantity', `Type the number of NFTs per wallet (a whole number from 1 to ${Math.max(1, (d.plan as GuidedPlan).maxQuantity)}).`);
      case 'count': return this.ask(flow, 'count', `Type how many wallets to size the campaign for (a whole number from 1 to ${(d.plan as GuidedPlan).ready.length}).`);
      case 'wallets': return this.ask(flow, 'wallets', flow.kind === 'request' ? 'Type the wallet addresses, separated by commas. Each must be one of the wallets that have fresh test mints.' : 'Type the wallet addresses, separated by commas. Each must be one of your signing wallets.');
      case 'wallet': return this.ask(flow, 'address', 'Type the wallet address (0x followed by 40 letters or digits).');
      case 'fee': return this.ask(flow, 'fee', 'Type the fee ceiling as a plain number, for example 0.15.');
      default: return this.ask(flow, 'window', 'Type the window as two times separated by a space, in UTC: for example "now +90m" or "2026-10-25T18:00 2026-10-25T20:00". At most 6 hours, starting within 7 days.');
    }
  }

  // ── typed entries ─────────────────────────────────────────────────────────────────────────────────

  /** A wrong typed entry: say why. Three in a row send the owner back to the choices, so nobody is stuck. */
  private async reject(flow: Flow, why: string, field: Awaiting['field']): Promise<FlowResult> {
    flow.wrong += 1;
    if (flow.wrong >= MAX_WRONG) {
      flow.wrong = 0;
      return this.noted(flow, `Not accepted: ${why}\n\nThat was the third wrong entry in a row, so here are the choices again.`);
    }
    flow.awaiting = { field };
    return { reply: { text: `Not accepted: ${why}\n\nTry again, tap "Back To Choices", or cancel.`, buttons: [[{ text: 'Back To Choices', callback_data: this.cb(flow, 'bk') }, ...this.cancelRow(flow)]] } };
  }

  /** The current step again, with a note above it. */
  private async noted(flow: Flow, note: string): Promise<FlowResult> {
    const again = await this.render(flow);
    return { reply: { text: `${note}\n\n${again.reply.text}`, ...(again.reply.buttons ? { buttons: again.reply.buttons } : {}) } };
  }

  private async typed(flow: Flow, field: Awaiting['field'], text: string): Promise<FlowResult> {
    const d = flow.data as Record<string, any>;
    const bad = (why: string): Promise<FlowResult> => this.reject(flow, why, field);
    switch (field) {
      case 'contract': {
        if (!ADDRESS.test(text)) return bad(`"${text.slice(0, 60)}" is not a contract address. Send 0x followed by 40 letters or digits.`);
        d.contract = text.toLowerCase();
        d.plan = await this.deps.actions.guidedPlan(String(d.chain), String(d.contract), undefined, undefined);
        const plan = d.plan as GuidedPlan;
        if (!plan.ok) { flow.step = 1; flow.awaiting = { field: 'contract' }; flow.wrong = 0; return { reply: { text: `${plan.text}\n\nFix the points above, then send another contract address, or cancel.`, buttons: [this.cancelRow(flow)] } }; }
        flow.step = 1;
        return this.advance(flow);
      }
      case 'quantity': {
        const max = Math.max(1, (d.plan as GuidedPlan).maxQuantity);
        if (!/^\d{1,3}$/.test(text) || Number(text) < 1 || Number(text) > max) return bad(`use a whole number from 1 to ${max} (the drop allows ${max} per wallet); you sent "${text.slice(0, 40)}".`);
        return this.takeQuantity(flow, Number(text));
      }
      case 'count': {
        const ready = (d.plan as GuidedPlan).ready.length;
        if (!/^\d{1,3}$/.test(text) || Number(text) < 1 || Number(text) > ready) return bad(`use a whole number from 1 to ${ready} (the wallets that are ready); you sent "${text.slice(0, 40)}".`);
        return this.takeCount(flow, Number(text));
      }
      case 'wallets': {
        const parts = text.split(/[\s,]+/).filter(Boolean);
        if (parts.length === 0) return bad('send at least one wallet address.');
        const request = flow.kind === 'request';
        const allowed = new Set((request ? (d.tested as string[]) : await this.deps.actions.signingWallets()).map((wallet) => wallet.toLowerCase()));
        const seen = new Set<string>();
        for (const part of parts) {
          if (!ADDRESS.test(part)) return bad(`"${part.slice(0, 50)}" is not a wallet address (0x followed by 40 letters or digits).`);
          const lower = part.toLowerCase();
          if (!allowed.has(lower)) return bad(request ? `${short(part)} has no fresh test mint on this campaign, so it cannot be in the request.` : `${short(part)} is not one of your signing wallets, so it cannot mint. /wallets shows the signing wallets.`);
          if (seen.has(lower)) return bad(`${short(part)} is listed twice.`);
          seen.add(lower);
        }
        if (request && seen.size > Number(d.sized)) return bad(`this campaign was sized for ${String(d.sized)} wallet(s); you chose ${seen.size}.`);
        d.wallets = [...seen];
        return this.advance(flow);
      }
      case 'address': {
        if (!ADDRESS.test(text)) return bad(`"${text.slice(0, 60)}" is not a wallet address. Send 0x followed by 40 letters or digits.`);
        d.address = text.toLowerCase();
        return this.advance(flow);
      }
      case 'fee': {
        const fees = await this.deps.actions.feeOptions(String(d.campaign));
        const limit = fees.limit ?? 500;
        if (!/^\d{1,6}(\.\d{1,6})?$/.test(text) || !(Number(text) > 0)) return bad(`send the fee ceiling as a plain number above 0, such as 0.15 (you sent "${text.slice(0, 40)}").`);
        if (Number(text) > limit) return bad(`${text} ${fees.unit} is above the limit of ${limit} ${fees.unit}${fees.limit !== undefined ? ' set by your Turnkey policy' : ''}.`);
        return this.takeFee(flow, Number(text));
      }
      case 'window': {
        const parts = text.split(/\s+/).filter(Boolean);
        if (parts.length !== 2) return bad('send two times separated by a space, for example "now +90m" or "2026-10-25T18:00 2026-10-25T20:00".');
        try { return await this.takeWindow(flow, parts[0]!, parts[1]!); } catch (error) { return bad(this.deps.explain(error)); }
      }
    }
  }

  // ── values taken (from a button or a typed entry) ────────────────────────────────────────────────

  private async takeQuantity(flow: Flow, quantity: number): Promise<FlowResult> {
    const d = flow.data as Record<string, any>;
    const plan = await this.deps.actions.guidedPlan(String(d.chain), String(d.contract), quantity, undefined);
    if (!plan.ok) return this.noted(flow, `${plan.text}\n\nThat quantity does not work. Choose another, or cancel.`);
    d.quantity = quantity;
    d.plan = plan;
    return this.advance(flow);
  }

  private async takeCount(flow: Flow, count: number): Promise<FlowResult> {
    const d = flow.data as Record<string, any>;
    const plan = await this.deps.actions.guidedPlan(String(d.chain), String(d.contract), Number(d.quantity), count);
    const selected = plan.ready.slice(0, count);
    if (!plan.ok || selected.length !== count) return { reply: { text: `${plan.text}\n\nThe wallets changed since the last step. Send the command again to start over.`, buttons: [this.cancelRow(flow)] } };
    d.plan = plan;
    d.selected = selected;
    return this.advance(flow);
  }

  /** The wallets as the actions take them: `all` or a comma list. A request's `all` is the tested wallets, at most as many as the campaign was sized for. */
  private walletsText(flow: Flow): string {
    const d = flow.data as Record<string, any>;
    if (d.wallets === 'all') return flow.kind === 'request' ? (d.tested as string[]).slice(0, Number(d.sized)).join(',') : 'all';
    return (d.wallets as string[]).join(',');
  }

  private async takeFee(flow: Flow, fee: number): Promise<FlowResult> {
    const d = flow.data as Record<string, any>;
    d.fee = fee;
    if (flow.kind === 'fire') {
      const preview = await this.deps.actions.firePreview(String(d.campaign), this.walletsText(flow), fee);
      d.walletsText = preview.wallets.join(',');
      d.digest = preview.digest;
      d.summary = preview.text;
      flow.step = 3;
      flow.wrong = 0;
      return this.render(flow);
    }
    if (flow.kind === 'request') {
      if (d.wallets === 'all' && d.tested === undefined) { const found = await this.deps.actions.requestWallets(String(d.campaign)); d.tested = found.wallets; d.sized = found.sized; }
      const preview = await this.deps.actions.requestPreview(String(d.campaign), this.walletsText(flow), fee);
      d.walletsText = preview.wallets.join(',');
      d.phrase = preview.phrase;
      d.summary = preview.text;
      flow.step = 3;
      flow.wrong = 0;
      return this.render(flow);
    }
    // schedule: the window comes next
    return this.advance(flow);
  }

  private async takeWindow(flow: Flow, from: string, until: string): Promise<FlowResult> {
    const d = flow.data as Record<string, any>;
    const preview = await this.deps.actions.schedulePreview(String(d.campaign), this.walletsText(flow), Number(d.fee), from, until);
    d.walletsText = preview.wallets.join(',');
    d.phrase = preview.phrase;
    d.digest = preview.digest;
    d.from = preview.from;
    d.until = preview.until;
    d.summary = preview.text;
    flow.step = 4;
    flow.wrong = 0;
    return this.render(flow);
  }

  /** A one-step flow's pick: cancel the chosen request or schedule, or show a campaign's funding. Neither needs a second confirmation. */
  private async pick(flow: Flow, id: string): Promise<FlowResult> {
    this.flow = undefined;
    const code = (error: unknown): string => { const first = (error instanceof Error ? error.message : '').split(':')[0] ?? ''; return /^[A-Z][A-Z0-9_]{2,80}$/.test(first) ? first : 'FAILED'; };
    try {
      const text = flow.kind === 'cancel' ? await this.deps.actions.cancel(id) : flow.kind === 'run' ? await this.deps.actions.run(id) : await this.deps.actions.funding(id);
      return { reply: { text }, done: { command: flow.kind, outcome: flow.kind === 'cancel' && /^Not cancelled/.test(text) ? 'refused:NOT_CANCELLED' : 'ok' } };
    } catch (error) {
      return { reply: { text: `Not done: ${this.deps.explain(error)}` }, done: { command: flow.kind, outcome: `refused:${code(error)}` } };
    }
  }

  /** Records the test mints, then goes straight on to choosing the wallets for the request (nothing to copy). */
  private async recordTestMints(campaignId: string): Promise<FlowResult> {
    const result = await this.deps.actions.simulateCampaign(campaignId);
    // The test-mint result above already starts with the campaign id, so this first step does not repeat it.
    const next = this.make('request', 1, { campaign: campaignId, idShown: true });
    let step: FlowResult;
    try { step = await this.render(next); } catch (error) {
      // The test mints are recorded; only the wallet choices could not be shown. Say so, and keep the outcome true.
      this.flow = undefined;
      return { reply: { text: `${result.text}\n\nThe wallet choices could not be shown (${this.deps.explain(error)}). The test mints are recorded; send /request to continue.` }, done: { command: 'simulate', outcome: 'ok' } };
    }
    return { reply: { text: `${result.text}\n\n${step.reply.text}`, ...(step.reply.buttons ? { buttons: step.reply.buttons } : {}) }, done: { command: 'simulate', outcome: 'ok' } };
  }

  // ── the final tap ─────────────────────────────────────────────────────────────────────────────────

  private async finish(flow: Flow): Promise<FlowResult> {
    const d = flow.data as Record<string, any>;
    if (this.name(flow) !== 'review') return { reply: { text: 'That button is no longer valid. Send the command again.' } };
    // The flow ends with this tap, so the same button can never act twice; a confirmation older than 2 minutes is not acted on.
    this.flow = undefined;
    if (flow.confirmAt === undefined || this.deps.now().getTime() - flow.confirmAt > CONFIRM_LIFETIME_MS) return { reply: { text: 'That confirmation expired (it is good for 2 minutes). Nothing was changed. Send the command again.' } };
    const code = (error: unknown): string => { const first = (error instanceof Error ? error.message : '').split(':')[0] ?? ''; return /^[A-Z][A-Z0-9_]{2,80}$/.test(first) ? first : 'FAILED'; };
    const a = this.deps.actions;
    try {
      if (flow.kind === 'simulate') {
        return await this.recordTestMints(String(d.campaign));
      }
      if (flow.kind === 'prepare') {
        const prepared = await a.guidedPrepare(String(d.chain), String(d.contract), Number(d.quantity), d.selected as string[], (d.plan as GuidedPlan).phrase);
        if (!prepared.campaignId) return { reply: { text: prepared.text }, done: { command: 'prepare', outcome: 'ok' } };
        // Straight on to the next step: the test mints (they can only pass once the mint is open).
        // The prepared text above already shows the campaign id at its top, so the next step does not repeat it.
        const next = this.make('simulate', 1, { campaign: prepared.campaignId, campaignLabel: 'this campaign', idShown: true });
        const step = await this.render(next);
        return { reply: { text: `${prepared.text}\n\n${step.reply.text}`, ...(step.reply.buttons ? { buttons: step.reply.buttons } : {}) }, done: { command: 'prepare', outcome: 'ok' } };
      }
      let text: string;
      if (flow.kind === 'release') text = await a.releaseNow(d.releasePhrase as string | undefined);
      else if (flow.kind === 'revoke') text = await a.revokeNow(String(d.chain), String(d.phrase ?? ''));
      else if (flow.kind === 'watchaccept') text = await a.watchAcceptNow(String(d.chain), String(d.address), String(d.phrase));
      else if (flow.kind === 'fire') text = await a.fireNow(String(d.campaign), String(d.walletsText), Number(d.fee), d.digest as string | undefined);
      else if (flow.kind === 'request') text = await a.requestSend(String(d.campaign), String(d.walletsText), Number(d.fee), String(d.phrase));
      else text = await a.scheduleCreate(String(d.campaign), String(d.walletsText), Number(d.fee), String(d.from), String(d.until), String(d.phrase), d.digest as string | undefined);
      return { reply: { text }, done: { command: flow.kind, outcome: 'ok' } };
    } catch (error) {
      const hint = flow.kind === 'simulate' ? ' Send /simulate when the mint is open.' : '';
      return { reply: { text: `Not done: ${this.deps.explain(error)}${hint}` }, done: { command: flow.kind, outcome: `refused:${code(error)}` } };
    }
  }
}
