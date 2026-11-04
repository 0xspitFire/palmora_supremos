import { describe, expect, it } from 'vitest';
import { planFireLanes } from './fire-lanes.js';
import type { BroadcastMode } from './types.js';

describe('D-081 bounded fire lanes', () => {
  it('keeps simultaneous selection by default and plans exact ordered groups', () => {
    expect(planFireLanes([7, 2], undefined, 'public')).toEqual([{ walletIndex: 7, laneIndex: 0, startOffsetMs: 0 }, { walletIndex: 2, laneIndex: 0, startOffsetMs: 0 }]);
    expect(planFireLanes([7, 2, 9], [{ walletIndexes: [2, 7], startOffsetMs: 0, mode: 'public' }, { walletIndexes: [9], startOffsetMs: 300, mode: 'public' }], 'public')).toEqual([{ walletIndex: 2, laneIndex: 0, startOffsetMs: 0 }, { walletIndex: 7, laneIndex: 0, startOffsetMs: 0 }, { walletIndex: 9, laneIndex: 1, startOffsetMs: 300 }]);
  });
  it('refuses extra, omitted or duplicate wallet positions', () => {
    for (const indexes of [[0, 2], [0], [0, 0, 1]]) expect(() => planFireLanes([0, 1], [{ walletIndexes: indexes, startOffsetMs: 0, mode: 'public' }], 'public')).toThrow('FIRE_LANE_WALLET_SCOPE_INVALID');
  });
  it('refuses changed mode, unbounded/decreasing offsets and malformed groups', () => {
    for (const startOffsetMs of [-1, 30_001, 0.1, Number.NaN]) expect(() => planFireLanes([0], [{ walletIndexes: [0], startOffsetMs, mode: 'public' }], 'public')).toThrow();
    for (const mode of ['flashbots', 'unknown'] as BroadcastMode[]) expect(() => planFireLanes([0], [{ walletIndexes: [0], startOffsetMs: 0, mode }], 'public')).toThrow();
    expect(() => planFireLanes([0, 1], [{ walletIndexes: [0], startOffsetMs: 5, mode: 'public' }, { walletIndexes: [1], startOffsetMs: 0, mode: 'public' }], 'public')).toThrow();
    expect(() => planFireLanes([0], [], 'public')).toThrow();
    expect(() => planFireLanes([0, 0], undefined, 'public')).toThrow();
  });
});
