import type { Campaign } from '@mint-bot/backend';
import type { FireScheduleRecord } from '@mint-bot/database';

/**
 * T-067 (D-067, accepted 2026-10-24): firing a prepared mint the moment it opens. Two commands share ONE pipeline:
 * `/fire` (the owner's tap is the approval) and `/schedule` (the owner pre-authorised one exact mint; the service fires it).
 *
 * The pipeline does what the owner does by hand: dry-run each wallet, record the test mints of the ones that pass, approve exactly
 * those, and hand a live request to the existing request processor, which claims it once and arms and runs it through every gate
 * (approval digest, simulation freshness, admission, caps, reservations, custody, the Turnkey policy, the kill switch). Nothing here
 * signs or sends, and nothing here lifts a limit or releases the kill switch.
 */
export interface FireDeps {
  now(): Date;
  killSwitchOn(): boolean;
  campaign(campaignId: string): Campaign | undefined;
  /** Why this campaign cannot be fired now (another open schedule or request, or a fire in progress), or undefined. */
  conflict(campaignId: string, ignoreScheduleId?: string): string | undefined;
  /** Dry-runs the wallets and records a passing test mint for each wallet that passed; throws when the mint is not open or none passed. */
  recordSimulations(campaign: Campaign, wallets: readonly string[]): Promise<{ recorded: string[]; skipped: Array<{ wallet: string; why: string }> }>;
  /** Approves exactly the recorded test mints and stores the live request for the request processor. */
  createRequest(campaign: Campaign, wallets: readonly string[], maxFeeGwei: number): Promise<{ requestId: string }>;
  /** Asks the request processor to look now instead of at its next pass. */
  kick(): void;
}

export interface FireInput { campaignId: string; wallets: readonly string[]; maxFeeGwei: number; scheduleId?: string }
export interface FireResult { requestId: string; wallets: string[]; skipped: Array<{ wallet: string; why: string }> }

export async function runFire(deps: FireDeps, input: FireInput): Promise<FireResult> {
  if (!Number.isFinite(input.maxFeeGwei) || input.maxFeeGwei <= 0 || input.maxFeeGwei > 500) throw new Error('MAX_FEE_GWEI_INVALID: use more than 0 and at most 500');
  const campaign = deps.campaign(input.campaignId);
  if (!campaign) throw new Error('CAMPAIGN_NOT_FOUND: check the id (shown by /prepare)');
  if (campaign.dryRun) throw new Error('LIVE_REQUIRES_NON_DRY_CAMPAIGN');
  if (deps.killSwitchOn()) throw new Error('KILL_SWITCH_ON: release it first (/unlock, then /release); it is never released for you');
  const conflict = deps.conflict(input.campaignId, input.scheduleId);
  if (conflict) throw new Error(`FIRE_CONFLICT: ${conflict}`);
  const recorded = await deps.recordSimulations(campaign, input.wallets);
  if (recorded.recorded.length === 0) throw new Error('SIMULATION_NOT_PASSED: no wallet passed the test mint');
  const request = await deps.createRequest(campaign, recorded.recorded, input.maxFeeGwei);
  deps.kick();
  return { requestId: request.requestId, wallets: recorded.recorded, skipped: recorded.skipped };
}

// ── schedule windows ─────────────────────────────────────────────────────────────────────────────────

/** A time the owner types: `2026-10-25T18:00` (UTC), `+90m`, `+2h` or `now`. Returns undefined when it is none of those. */
export function parseWhen(text: string, now: Date): Date | undefined {
  const value = text.trim().toLowerCase();
  if (value === 'now') return new Date(now.getTime());
  const relative = /^\+(\d{1,4})([mh])$/.exec(value);
  if (relative) return new Date(now.getTime() + Number(relative[1]) * (relative[2] === 'h' ? 3_600_000 : 60_000));
  const absolute = /^(\d{4}-\d{2}-\d{2})t(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d{1,3})?z?$/.exec(value);
  if (!absolute) return undefined;
  const parsed = new Date(`${absolute[1]}T${absolute[2]}:${absolute[3]}:${absolute[4] ?? '00'}.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().startsWith(absolute[1]!) ? parsed : undefined;
}

export const MAX_SCHEDULE_WINDOW_MS = 6 * 3_600_000;
export const MAX_SCHEDULE_LEAD_MS = 7 * 24 * 3_600_000;

/** Checks a window the owner typed. Throws a plain error when it is not usable. */
export function assertScheduleWindow(from: Date, until: Date, now: Date): void {
  if (until.getTime() <= now.getTime()) throw new Error('WINDOW_IN_THE_PAST: the window must end in the future');
  if (until.getTime() <= from.getTime()) throw new Error('WINDOW_ORDER_INVALID: the end must be after the start');
  if (until.getTime() - from.getTime() > MAX_SCHEDULE_WINDOW_MS) throw new Error('WINDOW_TOO_LONG: a window is at most 6 hours');
  if (from.getTime() - now.getTime() > MAX_SCHEDULE_LEAD_MS) throw new Error('WINDOW_TOO_FAR: a schedule can start at most 7 days from now');
}

// ── the scheduler ────────────────────────────────────────────────────────────────────────────────────

export type MintState = 'upcoming' | 'open' | 'ended' | 'unknown';
export interface SchedulerDeps {
  schedules(): FireScheduleRecord[];
  claim(scheduleId: string, outcome: 'started' | 'expired'): boolean;
  campaign(campaignId: string): Campaign | undefined;
  campaignDigest(campaign: Campaign): string;
  killSwitchOn(): boolean;
  mintState(campaign: Campaign): Promise<MintState>;
  fire(schedule: FireScheduleRecord): Promise<void>;
  /** A fixed code only, never provider text. */
  record(event: { scheduleId: string; state: 'fired' | 'failed' | 'expired' | 'waiting'; code?: string }): Promise<void>;
  alert(text: string, dedupe: string): Promise<void>;
  now(): Date;
}

const safeCode = (error: unknown): string => {
  const code = (error instanceof Error ? error.message : '').split(':')[0] ?? '';
  return /^[A-Z][A-Z0-9_]{2,80}$/.test(code) ? code : 'SCHEDULED_FIRE_FAILED';
};

export function createFireScheduler(deps: SchedulerDeps): { tick(): Promise<number> } {
  const told = new Set<string>();
  const waitingRecorded = new Set<string>();
  const tellOnce = async (key: string, text: string): Promise<void> => { if (told.has(key)) return; told.add(key); await deps.alert(text, key).catch(() => undefined); };
  return {
    async tick(): Promise<number> {
      let fired = 0;
      const now = deps.now().getTime();
      for (const schedule of deps.schedules()) {
        const label = schedule.id.slice(-6);
        if (now < Date.parse(schedule.windowFrom)) continue;
        const end = async (code: string, text: string): Promise<void> => {
          if (deps.claim(schedule.id, 'expired')) { await deps.record({ scheduleId: schedule.id, state: 'expired', code }); await tellOnce(`fire-schedule:${schedule.id}:end`, text); }
        };
        if (now >= Date.parse(schedule.windowUntil)) { await end('SCHEDULE_WINDOW_ENDED', `Scheduled mint ${label} ended without firing: the mint did not open inside its window (or could not be read). Nothing was sent.`); continue; }
        const campaign = deps.campaign(schedule.campaignId);
        if (!campaign || deps.campaignDigest(campaign) !== schedule.campaignDigest) { await end('CAMPAIGN_CHANGED', `Scheduled mint ${label} was cancelled: its campaign changed or is gone since you scheduled it.`); continue; }
        // The kill switch is the owner's: a schedule only waits while it is on, and the owner is told once.
        if (deps.killSwitchOn()) { await tellOnce(`fire-schedule:${schedule.id}:kill`, `Scheduled mint ${label} is waiting: the kill switch is on. Release it (/unlock, then /release) before the mint opens.`); if (!waitingRecorded.has(schedule.id)) { waitingRecorded.add(schedule.id); await deps.record({ scheduleId: schedule.id, state: 'waiting', code: 'KILL_SWITCH_ON' }).catch(() => undefined); } continue; }
        const state = await deps.mintState(campaign).catch((): MintState => 'unknown');
        if (state === 'ended') { await end('MINT_ENDED', `Scheduled mint ${label} ended without firing: the mint is over.`); continue; }
        if (state !== 'open') continue;
        // Claimed before anything happens, so a restart or a second pass can never fire it twice.
        if (!deps.claim(schedule.id, 'started')) continue;
        try { await deps.fire(schedule); fired += 1; await deps.record({ scheduleId: schedule.id, state: 'fired' }); }
        catch (error) {
          const code = safeCode(error);
          await deps.record({ scheduleId: schedule.id, state: 'failed', code }).catch(() => undefined);
          await tellOnce(`fire-schedule:${schedule.id}:failed`, `Scheduled mint ${label} did not fire: ${code}. Nothing was sent.`);
        }
      }
      return fired;
    },
  };
}

export function startFireScheduler(deps: SchedulerDeps, options: { intervalMs?: number; onError?: (error: unknown) => void } = {}): { stop(): void; tick(): Promise<number> } {
  const scheduler = createFireScheduler(deps);
  let busy = false;
  const tick = async (): Promise<number> => {
    if (busy) return 0;
    busy = true;
    try { return await scheduler.tick(); } catch (error) { options.onError?.(error); return 0; } finally { busy = false; }
  };
  const timer = setInterval(() => { void tick(); }, options.intervalMs ?? 2_000);
  timer.unref?.();
  return { stop: () => clearInterval(timer), tick };
}
