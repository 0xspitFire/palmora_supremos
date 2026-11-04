import type { BroadcastMode } from './types.js';

/** D-081: ordered groups of already selected wallets. A lane cannot choose a new transport or expand the fleet. */
export interface FireLane {
  readonly walletIndexes: readonly number[];
  readonly startOffsetMs: number;
  readonly mode: BroadcastMode;
}
export interface FireLaneAssignment { readonly walletIndex: number; readonly laneIndex: number; readonly startOffsetMs: number }

export function planFireLanes(selected: readonly number[], lanes: readonly FireLane[] | undefined, mode: BroadcastMode): FireLaneAssignment[] {
  if (!selected.length || selected.some((index) => !Number.isSafeInteger(index) || index < 0) || new Set(selected).size !== selected.length) throw new Error('FIRE_LANE_FLEET_INVALID');
  if (lanes === undefined) return selected.map((walletIndex) => ({ walletIndex, laneIndex: 0, startOffsetMs: 0 }));
  if (!Array.isArray(lanes) || !lanes.length || lanes.length > selected.length) throw new Error('FIRE_LANES_INVALID');
  const allowed = new Set(selected);
  const seen = new Set<number>();
  const assignments: FireLaneAssignment[] = [];
  let priorOffset = 0;
  for (const [laneIndex, lane] of lanes.entries()) {
    if (!lane || lane.mode !== mode || !Number.isSafeInteger(lane.startOffsetMs) || lane.startOffsetMs < priorOffset || lane.startOffsetMs > 30_000 || !Array.isArray(lane.walletIndexes) || !lane.walletIndexes.length) throw new Error('FIRE_LANE_CONFIGURATION_INVALID');
    priorOffset = lane.startOffsetMs;
    for (const walletIndex of lane.walletIndexes) {
      if (!allowed.has(walletIndex) || seen.has(walletIndex)) throw new Error('FIRE_LANE_WALLET_SCOPE_INVALID');
      seen.add(walletIndex);
      assignments.push({ walletIndex, laneIndex, startOffsetMs: lane.startOffsetMs });
    }
  }
  if (seen.size !== allowed.size) throw new Error('FIRE_LANE_WALLET_SCOPE_INVALID');
  return assignments;
}
