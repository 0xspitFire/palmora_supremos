/**
 * Spots time the bot was not running (the computer asleep, the service stopped or frozen). The host calls `beat` on a
 * steady short timer and saves the last beat to disk. A long gap between two beats means nothing ran in between. A
 * frozen process cannot announce that it is frozen, so the report always comes after the fact, when the beats resume.
 * Pure: no clock, file or network.
 */
export interface PauseSpan {
  /** The last beat before the gap. */
  from: Date;
  /** The first beat after it. */
  to: Date;
  ms: number;
}

export class PauseWatch {
  private last: Date | undefined;

  /** `minGapMs` must be well above the beat interval, and above a normal restart. */
  public constructor(private readonly minGapMs: number, lastBeat?: Date) {
    if (!Number.isFinite(minGapMs) || minGapMs <= 0) throw new Error('PAUSE_WATCH_THRESHOLD_INVALID');
    this.last = lastBeat && Number.isFinite(lastBeat.getTime()) ? lastBeat : undefined;
  }

  /** Records a beat. Returns the pause that just ended, if the gap since the previous beat was long. */
  public beat(now: Date): PauseSpan | null {
    const previous = this.last;
    // A clock that went backwards is not a pause, and it must not move the last beat into the past.
    if (previous && now.getTime() < previous.getTime()) return null;
    this.last = now;
    if (!previous) return null;
    const ms = now.getTime() - previous.getTime();
    return ms > this.minGapMs ? { from: previous, to: now, ms } : null;
  }

  public lastBeat(): Date | undefined { return this.last; }
}
