import { describe, expect, it } from 'vitest';
import { configuredFireLanes } from './fire-lane-config.js';
const config = { version: 1, lanes: [{ positions: [1], startOffsetMs: 0 }, { positions: [0], startOffsetMs: 50 }] };
const selection = { indexes: [7, 2], addresses: ['0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222'] };
describe('trusted opt-in host fire lanes', () => {
  it('keeps default unchanged and maps relative positions into the exact selected signer indexes', () => {
    expect(configuredFireLanes(undefined)).toBeUndefined();
    const resolve = configuredFireLanes(JSON.stringify(config))!;
    const lanes = resolve('campaign', selection, 'public')!;
    expect(lanes).toEqual([{ walletIndexes: [2], startOffsetMs: 0, mode: 'public' }, { walletIndexes: [7], startOffsetMs: 50, mode: 'public' }]);
    (lanes[0]!.walletIndexes as number[])[0] = 99;
    expect(resolve('campaign', selection, 'sequencer')![0]).toEqual({ walletIndexes: [2], startOffsetMs: 0, mode: 'sequencer' });
  });
  it('projects smaller paid/simulation fleets without expanding wallets and refuses insufficient coverage', () => {
    const resolve = configuredFireLanes(JSON.stringify(config))!;
    expect(resolve('campaign', { indexes: [7], addresses: selection.addresses.slice(0, 1) }, 'public')).toEqual([{ walletIndexes: [7], startOffsetMs: 50, mode: 'public' }]);
    expect(() => resolve('campaign', { indexes: [7, 2, 9], addresses: [...selection.addresses, selection.addresses[0]!] }, 'public')).toThrow('FIRE_LANE_SELECTED_FLEET_MISMATCH');
  });
  it.each([1, 2, 10])('covers exactly %i currently selected wallets with a ten-position host plan', (count) => {
    const resolve = configuredFireLanes(JSON.stringify({ version: 1, lanes: [{ positions: [0, 2, 4, 6, 8], startOffsetMs: 0 }, { positions: [1, 3, 5, 7, 9], startOffsetMs: 10 }] }))!;
    const indexes = Array.from({ length: count }, (_, index) => index * 3 + 7);
    const lanes = resolve('campaign', { indexes, addresses: indexes.map(() => selection.addresses[0]!) }, 'public')!;
    expect(lanes.flatMap((lane) => lane.walletIndexes).sort((a, b) => a - b)).toEqual(indexes);
  });
  it.each(['bad', '{"version":1,"lanes":[]}', '{"version":1,"lanes":[{"positions":[1],"startOffsetMs":0}]}', JSON.stringify({ ...config, mode: 'flashbots' }), JSON.stringify({ version: 1, lanes: [{ positions: [0, 0], startOffsetMs: 0 }] }), JSON.stringify({ version: 1, lanes: [{ positions: [0], startOffsetMs: 30_001 }] }), JSON.stringify({ version: 1, lanes: [{ positions: [0], startOffsetMs: -1 }] }), JSON.stringify({ version: 1, lanes: [{ positions: [0], startOffsetMs: 0, mode: 'flashbots' }] })])('rejects invalid or broadened host plan %s', (text) => {
    expect(() => configuredFireLanes(text)).toThrow('FIRE_LANE_HOST_CONFIG_INVALID');
  });
});
