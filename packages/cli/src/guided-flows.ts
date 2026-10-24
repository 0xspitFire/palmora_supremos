import { randomBytes } from 'node:crypto';
import type { InlineButton } from './telegram-api.js';

/**
 * T-073 (D-069): guided flows for the mint steps, driven by buttons, with a typed "Custom" entry wherever there are presets.
 * Orders follow how the commands work today: prepare (kill switch ON, no unlock) → release (unlock) → fire or schedule (kill switch OFF, unlock).
 *
 * Every button is the owner's, expires after 15 minutes, and carries only a one-time flow id, a step number and a short key:
 * the values (a campaign, a wallet, a fee) live in memory here and are rebuilt by the server at the final tap. The final tap
 * calls the same action as the typed command, with the confirmation phrase built by the server from a fresh plan. A custom
 * entry is checked before it is used; a wrong one is refused in plain words and the flow stays where it was.
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
  guidedPrepare(chain: string, contract: string, quantity: number, wallets: string[], expectedPhrase?: string): Promise<string>;
  /** `phrase` names the kill engagement being looked at (its time); the release tap is refused if the switch was engaged again since. */
  releaseStatus(): Promise<{ text: string; canRelease: boolean; phrase?: string }>;
  releaseNow(expectedPhrase?: string): Promise<string>;
  guidedCampaigns(): Promise<GuidedCampaign[]>;
  signingWallets(): Promise<string[]>;
  feeOptions(campaignId: string): Promise<FeeOptions>;
  firePreview(campaignId: string, wallets: string, maxFeeGwei: number): Promise<{ text: string; wallets: string[]; digest?: string }>;
  fireNow(campaignId: string, wallets: string, maxFeeGwei: number, digest?: string): Promise<string>;
  schedulePreview(campaignId: string, wallets: string, maxFeeGwei: number, from: string, until: string): Promise<{ text: string; phrase: string; wallets: string[]; from: string; until: string; digest?: string }>;
  scheduleCreate(campaignId: string, wallets: string, maxFeeGwei: number, from: string, until: string, phrase: string, digest?: string): Promise<string>;
}

export type FlowKind = 'prepare' | 'release' | 'fire' | 'schedule';
export interface FlowReply { text: string; buttons?: InlineButton[][] }
/** What the router records after a flow finishes its last action: the command name and `ok` or `refused:CODE`. */
export interface FlowDone { command: FlowKind; outcome: string }
export interface FlowResult { reply: FlowReply; done?: FlowDone }

interface Awaiting { field: 'contract' | 'quantity' | 'count' | 'wallets' | 'fee' | 'window' }
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
/** The last tap (Release, Prepare, Fire Now, Store Schedule) is good for 2 minutes from the moment its summary is shown, like the kill and fire buttons. */
export const CONFIRM_LIFETIME_MS = 2 * 60_000;
const MAX_WRONG = 3;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const short = (address: string): string => `${address.slice(0, 6)}…${address.slice(-4)}`;
const STEPS: Readonly<Record<FlowKind, number>> = { prepare: 5, release: 1, fire: 4, schedule: 5 };
export const flowNeedsSession = (kind: FlowKind): boolean => kind !== 'prepare';

export interface GuidedDeps {
  actions: GuidedActions;
  now(): Date;
  /** Turns an error into the plain text shown to the owner (secrets and long hex removed). */
  explain(error: unknown): string;
  newId?(): string;
}

type Choice = { label: string; value: unknown };

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

  public async start(kind: FlowKind): Promise<FlowResult> {
    const flow: Flow = { id: (this.deps.newId ?? (() => randomBytes(4).toString('hex')))(), kind, step: 0, touchedAt: this.deps.now().getTime(), wrong: 0, options: new Map(), data: {} };
    this.flow = flow;
    return this.render(flow);
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
  private title(flow: Flow): string {
    const names: Record<FlowKind, string> = { prepare: 'Prepare A Live Campaign', release: 'Release The Kill Switch', fire: 'Fire A Campaign', schedule: 'Schedule A Mint' };
    return flow.kind === 'release' ? names.release : `${names[flow.kind]} · Step ${flow.step + 1} Of ${STEPS[flow.kind]}`;
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

  private async render(flow: Flow): Promise<FlowResult> {
    delete flow.awaiting;
    flow.customOk = false;
    delete flow.confirmAt;
    const head = this.title(flow);
    const d = flow.data as Record<string, any>;
    if (flow.kind === 'release') {
      const status = await this.deps.actions.releaseStatus();
      d.releasePhrase = status.phrase;
      flow.options.clear();
      flow.confirmAt = this.deps.now().getTime();
      const rows: InlineButton[][] = status.canRelease ? [[{ text: 'Release The Kill Switch', callback_data: this.cb(flow, 'go') }], this.cancelRow(flow)] : [this.cancelRow(flow)];
      return { reply: { text: `${head}\n\n${status.text}`, buttons: rows } };
    }
    if (flow.kind === 'prepare') {
      if (flow.step === 0) {
        const chains = await this.deps.actions.guidedChains();
        return { reply: { text: `${head}\n\nChoose the chain. Only chains that are switched on are listed.`, buttons: this.choices(flow, chains.map((chain) => ({ label: chain.name, value: chain.key })), false) } };
      }
      if (flow.step === 1) return this.ask(flow, 'contract', `${head}\n\nSend the contract address as a message (0x followed by 40 letters or digits).`);
      if (flow.step === 2) {
        const plan = d.plan as GuidedPlan;
        const max = Math.max(1, plan.maxQuantity);
        const presets = Array.from({ length: Math.min(3, max) }, (_unused, index) => index + 1);
        return { reply: { text: `${head}\n\n${plan.text}\n\nHow many NFTs per wallet? The drop allows up to ${max}.`, buttons: this.choices(flow, presets.map((value) => ({ label: String(value), value })), true) } };
      }
      if (flow.step === 3) {
        const plan = d.plan as GuidedPlan;
        const ready = plan.ready.length;
        const presets: Choice[] = [...[1, 2].filter((value) => value < ready).map((value) => ({ label: `${value} wallet${value === 1 ? '' : 's'}`, value })), { label: `All ready (${ready})`, value: ready }];
        return { reply: { text: `${head}\n\n${ready} wallet(s) are ready. How many should this campaign be sized for? (The campaign can never fire more wallets than this.)`, buttons: this.choices(flow, presets, ready > 1) } };
      }
      const plan = d.plan as GuidedPlan;
      flow.options.clear();
      flow.confirmAt = this.deps.now().getTime();
      return { reply: { text: `${head}\n\nReview. This only records a campaign; it spends nothing.\n\n${plan.text}`, buttons: [[{ text: 'Prepare (Spends Nothing)', callback_data: this.cb(flow, 'go') }], this.cancelRow(flow)] } };
    }
    // fire and schedule
    if (flow.step === 0) {
      const campaigns = await this.deps.actions.guidedCampaigns();
      if (campaigns.length === 0) { this.flow = undefined; return { reply: { text: 'No live campaign is prepared yet. Use /prepare first, then come back.' } }; }
      const list = campaigns.map((campaign) => `• ${campaign.label} — ${campaign.note}`).join('\n');
      return { reply: { text: `${head}\n\nChoose the campaign.\n\n${list}`, buttons: this.choices(flow, campaigns.map((campaign) => ({ label: campaign.label, value: campaign.id })), false) } };
    }
    if (flow.step === 1) {
      const wallets = await this.deps.actions.signingWallets();
      const choices: Choice[] = [{ label: `All Signing Wallets (${wallets.length})`, value: 'all' }, ...wallets.slice(0, 6).map((wallet) => ({ label: short(wallet), value: wallet }))];
      return { reply: { text: `${head}\n\nWhich wallets? A wallet that fails its test mint is left out and named.`, buttons: this.choices(flow, choices, true) } };
    }
    if (flow.step === 2) {
      const fees = await this.deps.actions.feeOptions(String(d.campaign));
      const limitNote = fees.limit !== undefined ? ` Your Turnkey policy allows at most ${fees.limit} ${fees.unit}.` : '';
      return { reply: { text: `${head}\n\nChoose the fee ceiling (${fees.unit}). The service never signs above it.${limitNote}`, buttons: this.choices(flow, fees.presets.map((value) => ({ label: `${value} ${fees.unit}`, value })), true) } };
    }
    if (flow.kind === 'schedule' && flow.step === 3) {
      const windows: Choice[] = [['now', '+1h', 'Now To +1 H'], ['now', '+2h', 'Now To +2 H'], ['now', '+3h', 'Now To +3 H'], ['now', '+6h', 'Now To +6 H']].map(([from, until, label]) => ({ label: label!, value: { from, until } }));
      return { reply: { text: `${head}\n\nChoose the window in which the service may fire when the mint opens (at most 6 hours).`, buttons: this.choices(flow, windows, true) } };
    }
    // final summary step
    flow.options.clear();
    flow.confirmAt = this.deps.now().getTime();
    const label = flow.kind === 'fire' ? 'Fire Now' : 'Store Schedule';
    return { reply: { text: `${head}\n\n${String(d.summary)}`, buttons: [[{ text: label, callback_data: this.cb(flow, 'go') }], this.cancelRow(flow)] } };
  }

  private async advance(flow: Flow): Promise<FlowResult> { flow.step += 1; flow.wrong = 0; return this.render(flow); }

  // ── buttons ───────────────────────────────────────────────────────────────────────────────────────

  private async press(flow: Flow, key: string): Promise<FlowResult> {
    const d = flow.data as Record<string, any>;
    if (key === 'bk') return this.render(flow);
    if (key === 'cu') return flow.customOk ? this.custom(flow) : { reply: { text: 'That button is no longer valid. Use the buttons on the latest message, or send the command again.' } };
    if (key === 'go') return this.finish(flow);
    if (!flow.options.has(key)) return { reply: { text: 'That button is no longer valid. Use the buttons on the latest message, or send the command again.' } };
    const value = flow.options.get(key);
    if (flow.kind === 'prepare') {
      if (flow.step === 0) { d.chain = value; return this.advance(flow); }
      if (flow.step === 2) return this.takeQuantity(flow, Number(value));
      if (flow.step === 3) return this.takeCount(flow, Number(value));
    } else if (flow.kind === 'fire' || flow.kind === 'schedule') {
      if (flow.step === 0) { d.campaign = value; return this.advance(flow); }
      if (flow.step === 1) { d.wallets = value === 'all' ? 'all' : [String(value)]; return this.advance(flow); }
      if (flow.step === 2) return this.takeFee(flow, Number(value));
      if (flow.kind === 'schedule' && flow.step === 3) { const window = value as { from: string; until: string }; return this.takeWindow(flow, window.from, window.until); }
    }
    return { reply: { text: 'That button is no longer valid. Send the command again.' } };
  }

  private custom(flow: Flow): FlowResult {
    const d = flow.data as Record<string, any>;
    if (flow.kind === 'prepare' && flow.step === 2) return this.ask(flow, 'quantity', `Type the number of NFTs per wallet (a whole number from 1 to ${Math.max(1, (d.plan as GuidedPlan).maxQuantity)}).`);
    if (flow.kind === 'prepare' && flow.step === 3) return this.ask(flow, 'count', `Type how many wallets to size the campaign for (a whole number from 1 to ${(d.plan as GuidedPlan).ready.length}).`);
    if (flow.step === 1) return this.ask(flow, 'wallets', 'Type the wallet addresses, separated by commas. Each must be one of your signing wallets.');
    if (flow.step === 2) return this.ask(flow, 'fee', 'Type the fee ceiling as a plain number, for example 0.15.');
    return this.ask(flow, 'window', 'Type the window as two times separated by a space, in UTC: for example "now +90m" or "2026-10-25T18:00 2026-10-25T20:00". At most 6 hours, starting within 7 days.');
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
        if (!plan.ok) { flow.awaiting = { field: 'contract' }; flow.wrong = 0; return { reply: { text: `${plan.text}\n\nFix the points above, then send another contract address, or cancel.`, buttons: [this.cancelRow(flow)] } }; }
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
        const signing = new Set((await this.deps.actions.signingWallets()).map((wallet) => wallet.toLowerCase()));
        const seen = new Set<string>();
        for (const part of parts) {
          if (!ADDRESS.test(part)) return bad(`"${part.slice(0, 50)}" is not a wallet address (0x followed by 40 letters or digits).`);
          const lower = part.toLowerCase();
          if (!signing.has(lower)) return bad(`${short(part)} is not one of your signing wallets, so it cannot mint. /wallets shows the signing wallets.`);
          if (seen.has(lower)) return bad(`${short(part)} is listed twice.`);
          seen.add(lower);
        }
        d.wallets = [...seen];
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

  private async takeFee(flow: Flow, fee: number): Promise<FlowResult> {
    const d = flow.data as Record<string, any>;
    d.fee = fee;
    const walletsText = d.wallets === 'all' ? 'all' : (d.wallets as string[]).join(',');
    if (flow.kind === 'fire') {
      const preview = await this.deps.actions.firePreview(String(d.campaign), walletsText, fee);
      d.walletsText = preview.wallets.join(',');
      d.digest = preview.digest;
      d.summary = preview.text;
      return this.advance(flow);
    }
    // schedule: the window comes next
    return this.advance(flow);
  }

  private async takeWindow(flow: Flow, from: string, until: string): Promise<FlowResult> {
    const d = flow.data as Record<string, any>;
    const walletsText = d.wallets === 'all' ? 'all' : (d.wallets as string[]).join(',');
    const preview = await this.deps.actions.schedulePreview(String(d.campaign), walletsText, Number(d.fee), from, until);
    d.walletsText = preview.wallets.join(',');
    d.phrase = preview.phrase;
    d.digest = preview.digest;
    d.from = preview.from;
    d.until = preview.until;
    d.summary = preview.text;
    return this.advance(flow);
  }

  // ── the final tap ─────────────────────────────────────────────────────────────────────────────────

  private async finish(flow: Flow): Promise<FlowResult> {
    const d = flow.data as Record<string, any>;
    const isFinal = (flow.kind === 'release' && flow.step === 0) || (flow.kind === 'prepare' && flow.step === 4) || (flow.kind === 'fire' && flow.step === 3) || (flow.kind === 'schedule' && flow.step === 4);
    if (!isFinal) return { reply: { text: 'That button is no longer valid. Send the command again.' } };
    // The flow ends with this tap, so the same button can never act twice; a confirmation older than 2 minutes is not acted on.
    this.flow = undefined;
    if (flow.confirmAt === undefined || this.deps.now().getTime() - flow.confirmAt > CONFIRM_LIFETIME_MS) return { reply: { text: 'That confirmation expired (it is good for 2 minutes). Nothing was changed. Send the command again.' } };
    const code = (error: unknown): string => { const first = (error instanceof Error ? error.message : '').split(':')[0] ?? ''; return /^[A-Z][A-Z0-9_]{2,80}$/.test(first) ? first : 'FAILED'; };
    try {
      let text: string;
      if (flow.kind === 'release') text = await this.deps.actions.releaseNow(d.releasePhrase as string | undefined);
      else if (flow.kind === 'prepare') text = await this.deps.actions.guidedPrepare(String(d.chain), String(d.contract), Number(d.quantity), d.selected as string[], (d.plan as GuidedPlan).phrase);
      else if (flow.kind === 'fire') text = await this.deps.actions.fireNow(String(d.campaign), String(d.walletsText), Number(d.fee), d.digest as string | undefined);
      else text = await this.deps.actions.scheduleCreate(String(d.campaign), String(d.walletsText), Number(d.fee), String(d.from), String(d.until), String(d.phrase), d.digest as string | undefined);
      return { reply: { text }, done: { command: flow.kind, outcome: 'ok' } };
    } catch (error) {
      return { reply: { text: `Not done: ${this.deps.explain(error)}` }, done: { command: flow.kind, outcome: `refused:${code(error)}` } };
    }
  }
}
