import { describe, expect, it } from 'vitest';
import { PauseWatch } from './pause-watch.js';
import { pauseCard } from './system-messages.js';

const at = (iso: string): Date => new Date(`2026-10-11T${iso}Z`);

describe('PauseWatch', () => {
  it('stays quiet for normal beats and reports a long gap once, after the fact', () => {
    const watch = new PauseWatch(5 * 60_000);
    expect(watch.beat(at('10:00:00'))).toBeNull();
    expect(watch.beat(at('10:00:30'))).toBeNull();
    expect(watch.beat(at('10:01:00'))).toBeNull();
    const span = watch.beat(at('17:30:00'));
    expect(span).toMatchObject({ ms: (7 * 60 + 29) * 60_000 });
    expect(span?.from.toISOString()).toBe('2026-10-11T10:01:00.000Z');
    expect(watch.beat(at('17:30:30'))).toBeNull();
  });

  it('uses the saved beat from before a restart, and treats a short restart as no pause', () => {
    expect(new PauseWatch(5 * 60_000, at('10:00:00')).beat(at('10:40:00'))?.ms).toBe(40 * 60_000);
    expect(new PauseWatch(5 * 60_000, at('10:00:00')).beat(at('10:00:50'))).toBeNull();
  });

  it('does not treat a clock that went backwards as a pause, and keeps the later beat', () => {
    const watch = new PauseWatch(5 * 60_000);
    watch.beat(at('10:00:00'));
    expect(watch.beat(at('09:00:00'))).toBeNull();
    expect(watch.lastBeat()?.toISOString()).toBe('2026-10-11T10:00:00.000Z');
  });

  it('fails closed on a bad threshold or an invalid saved beat', () => {
    expect(() => new PauseWatch(0)).toThrow('PAUSE_WATCH_THRESHOLD_INVALID');
    expect(() => new PauseWatch(Number.NaN)).toThrow('PAUSE_WATCH_THRESHOLD_INVALID');
    expect(new PauseWatch(1000, new Date('nope')).beat(at('10:00:00'))).toBeNull();
  });
});

describe('pauseCard', () => {
  it('says what happened, how long, and what it means, without a path, key or address', () => {
    const card = pauseCard({ from: at('07:12:00'), to: at('07:49:00'), resumedBlock: '26117555' });
    const text = JSON.stringify(card);
    expect(card.title).toBe('BOT WAS PAUSED');
    expect(card.severity).toBe('attention');
    expect(text).toContain('2026-10-11 07:12 UTC to 2026-10-11 07:49 UTC (37 min)');
    expect(text).toContain('26,117,555');
    expect(text).not.toMatch(/\/home|0x|https?:/);
  });
});
