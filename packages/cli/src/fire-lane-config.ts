import { planFireLanes } from '@mint-bot/engine';
import type { MintEngineAdapterOptions } from './engine-adapter.js';

/** Optional trusted host plan. Positions address only the canonical selected fleet, never arbitrary wallets. */
export function configuredFireLanes(text: string | undefined): MintEngineAdapterOptions['fireLanesFor'] {
  if (text === undefined || text === '') return undefined;
  let raw: unknown;
  try { if (Buffer.byteLength(text) > 32_768) throw new Error(); raw = JSON.parse(text); }
  catch { throw new Error('FIRE_LANE_HOST_CONFIG_INVALID'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('FIRE_LANE_HOST_CONFIG_INVALID');
  const config = raw as Record<string, unknown>;
  if (config['version'] !== 1 || Object.keys(config).some((key) => !['version', 'lanes'].includes(key)) || !Array.isArray(config['lanes']) || !config['lanes'].length || config['lanes'].length > 100) throw new Error('FIRE_LANE_HOST_CONFIG_INVALID');
  let prior = 0;
  const seen = new Set<number>();
  const lanes = config['lanes'].map((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('FIRE_LANE_HOST_CONFIG_INVALID');
    const lane = value as Record<string, unknown>;
    const positions = lane['positions'];
    const offset = lane['startOffsetMs'];
    if (Object.keys(lane).some((key) => !['positions', 'startOffsetMs'].includes(key)) || typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < prior || offset > 30_000 || !Array.isArray(positions) || !positions.length || positions.length > 100) throw new Error('FIRE_LANE_HOST_CONFIG_INVALID');
    prior = offset;
    for (const position of positions) {
      if (typeof position !== 'number' || !Number.isSafeInteger(position) || position < 0 || position > 99 || seen.has(position)) throw new Error('FIRE_LANE_HOST_CONFIG_INVALID');
      seen.add(position);
    }
    return { positions: [...positions] as number[], startOffsetMs: offset };
  });
  for (let position = 0; position < seen.size; position += 1) if (!seen.has(position)) throw new Error('FIRE_LANE_HOST_CONFIG_INVALID');
  return (_campaignId, selection, mode) => {
    if (selection.indexes.length > seen.size) throw new Error('FIRE_LANE_SELECTED_FLEET_MISMATCH');
    const plan = lanes.map((lane) => ({ walletIndexes: lane.positions.filter((position) => position < selection.indexes.length).map((position) => {
      const index = selection.indexes[position];
      if (index === undefined) throw new Error('FIRE_LANE_SELECTED_FLEET_MISMATCH');
      return index;
    }), startOffsetMs: lane.startOffsetMs, mode })).filter((lane) => lane.walletIndexes.length > 0);
    planFireLanes(selection.indexes, plan, mode);
    return plan;
  };
}
