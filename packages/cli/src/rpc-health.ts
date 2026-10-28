import { createPublicClient, http } from 'viem';
import { classifyFailure, type FailureClass } from './rpc-probe.js';

/**
 * Read-only RPC failover check. For one chain it asks every configured provider slot for the chain id and the head block, and says
 * in plain words whether a mint-time read could fail over. It reports slot NAMES only: never a URL, a key or a host name.
 * It never signs or sends anything.
 */
export interface Reading { chainId: number; block: bigint }
export type ReadEndpoint = (url: string) => Promise<Reading>;
export interface RpcSlotInput { name: string; urls: readonly string[] }
export type SlotFailure = FailureClass | 'wrong_chain';
export interface SlotHealth {
  slot: string;
  configured: boolean;
  working: boolean;
  latencyMs?: number;
  block?: string;
  failure?: SlotFailure;
  /** Other working slots that run on the same provider, so they are not independent of this one. */
  sameProviderAs?: string[];
}
export interface ChainHealth {
  chainId: number;
  slots: SlotHealth[];
  workingSlots: number;
  independentProviders: number;
  blockSpread: number | null;
  failoverReady: boolean;
  notes: string[];
}

/** How far apart (in blocks) two working providers may be before one of them is called behind. */
const MAX_BLOCK_SPREAD: Record<number, number> = { 1: 3, 8453: 15, 4663: 15 };
/** Reads that must have an independent second source before live execution (D-057 for Base). */
const MIN_INDEPENDENT_PROVIDERS: Record<number, number> = { 1: 2, 8453: 2, 4663: 2 };

/** A coarse provider identity (the last two host labels) used only to compare slots; it is never reported. */
export function providerGroup(url: string): string | undefined {
  try { return new URL(url).hostname.split('.').slice(-2).join('.'); } catch { return undefined; }
}

export function viemReader(timeoutMs = 8_000): ReadEndpoint {
  return async (url) => {
    const client = createPublicClient({ transport: http(url, { timeout: timeoutMs, retryCount: 0 }) });
    const [chainId, block] = await Promise.all([client.getChainId(), client.getBlockNumber()]);
    return { chainId, block };
  };
}

export async function checkChainRpc(input: { chainId: number; slots: readonly RpcSlotInput[]; read: ReadEndpoint; now?: () => number }): Promise<ChainHealth> {
  const now = input.now ?? (() => performance.now());
  const probed = await Promise.all(input.slots.map(async (slot): Promise<{ health: SlotHealth; group?: string; block?: bigint }> => {
    if (slot.urls.length === 0) return { health: { slot: slot.name, configured: false, working: false } };
    let failure: SlotFailure = 'other';
    for (const url of slot.urls) {
      const started = now();
      try {
        const reading = await input.read(url);
        if (reading.chainId !== input.chainId) { failure = 'wrong_chain'; continue; }
        const group = providerGroup(url);
        return { health: { slot: slot.name, configured: true, working: true, latencyMs: Math.round(now() - started), block: reading.block.toString() }, ...(group ? { group } : {}), block: reading.block };
      } catch (error) { if (failure !== 'wrong_chain') failure = classifyFailure(error); }
    }
    return { health: { slot: slot.name, configured: true, working: false, failure } };
  }));

  const working = probed.filter((entry) => entry.health.working);
  for (const entry of working) {
    const same = working.filter((other) => other !== entry && entry.group !== undefined && other.group === entry.group).map((other) => other.health.slot);
    if (same.length > 0) entry.health.sameProviderAs = same;
  }
  const independentProviders = new Set(working.map((entry) => entry.group ?? entry.health.slot)).size;
  const blocks = working.map((entry) => entry.block!).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const blockSpread = blocks.length > 1 ? Number(blocks.at(-1)! - blocks[0]!) : blocks.length === 1 ? 0 : null;

  const notes: string[] = [];
  const configured = probed.filter((entry) => entry.health.configured).length;
  const need = MIN_INDEPENDENT_PROVIDERS[input.chainId] ?? 2;
  if (configured === 0) notes.push('No provider is configured for this chain.');
  for (const entry of probed) {
    if (entry.health.configured && !entry.health.working) notes.push(`${entry.health.slot} is not usable (${entry.health.failure ?? 'other'}).`);
    if (!entry.health.configured) notes.push(`${entry.health.slot} has no value set.`);
  }
  if (independentProviders < need) notes.push(`Fewer than ${need} independent working providers: a failure of one provider would stop reads on this chain.`);
  const spreadLimit = MAX_BLOCK_SPREAD[input.chainId] ?? 10;
  if (blockSpread !== null && blockSpread > spreadLimit) notes.push(`Working providers disagree about the head by ${blockSpread} blocks (limit ${spreadLimit}); one of them is behind.`);
  if (working.some((entry) => entry.health.sameProviderAs)) notes.push('Some working slots use the same provider, so they fail together and do not count as independent.');

  return {
    chainId: input.chainId,
    slots: probed.map((entry) => entry.health),
    workingSlots: working.length,
    independentProviders,
    blockSpread,
    failoverReady: independentProviders >= need && (blockSpread === null || blockSpread <= spreadLimit),
    notes,
  };
}

const CHAIN_LABEL: Record<number, string> = { 1: 'Ethereum', 8453: 'Base', 4663: 'Robinhood' };

export function renderRpcHealth(chains: readonly ChainHealth[]): string {
  return chains.map((chain) => {
    const lines = chain.slots.map((slot) => `  ${slot.slot}: ${!slot.configured ? 'not set' : slot.working ? `working, ${slot.latencyMs} ms, block ${slot.block}` : `NOT working (${slot.failure})`}`);
    return [`${CHAIN_LABEL[chain.chainId] ?? chain.chainId}: ${chain.failoverReady ? 'failover ready' : 'FAILOVER NOT READY'} (${chain.workingSlots} working, ${chain.independentProviders} independent)`, ...lines, ...chain.notes.map((note) => `  - ${note}`)].join('\n');
  }).join('\n\n');
}
