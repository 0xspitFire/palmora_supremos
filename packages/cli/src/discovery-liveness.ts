import type { DiscoveryTickResult } from '@mint-bot/backend';
import type { IntelligenceReadState } from './bounded-intelligence-port.js';

export interface DiscoveryChainHealth {
  chainId: number;
  state: 'starting' | 'scanning' | 'catching_up' | 'partial' | 'healthy' | 'unavailable' | 'stalled';
  startedAt: string;
  lastSuccessAt?: string;
  lastSuccessBlock?: string;
  headBlock?: string;
  caughtUp?: boolean;
  watchedPartial?: boolean;
  activeSince?: string;
  operation?: string;
  pendingReads: number;
}

export interface DiscoveryHealthSnapshot {
  status: 'starting' | 'healthy' | 'degraded';
  chains: readonly DiscoveryChainHealth[];
}

interface ChainState {
  startedAt: number;
  activeSince?: number;
  lastSuccessAt?: number;
  lastSuccessBlock?: string;
  headBlock?: string;
  caughtUp?: boolean;
  watchedPartial?: boolean;
  failed: boolean;
  operation?: string;
  pendingReads: number;
}

/** Process-local scan coverage, independent of mint permission and readiness. */
export class DiscoveryLiveness {
  private readonly chains = new Map<number, ChainState>();

  constructor(private readonly now: () => number = Date.now, private readonly staleMs = 5 * 60_000) {
    if (!Number.isSafeInteger(staleMs) || staleMs < 1000) throw new Error('DISCOVERY_LIVENESS_BOUNDS_INVALID');
  }

  start(chainId: number): void {
    if (![1, 8453, 4663].includes(chainId)) throw new Error('DISCOVERY_LIVENESS_CHAIN_INVALID');
    if (!this.chains.has(chainId)) this.chains.set(chainId, { startedAt: this.now(), failed: false, pendingReads: 0 });
  }

  begin(chainId: number): void {
    this.start(chainId);
    this.chains.get(chainId)!.activeSince = this.now();
  }

  read(value: IntelligenceReadState): void {
    this.start(value.chainId);
    const state = this.chains.get(value.chainId)!;
    state.pendingReads = value.pending;
    if (value.state !== 'completed') state.operation = value.operation;
    else if (value.pending === 0) state.operation = undefined;
  }

  complete(chainId: number, result: DiscoveryTickResult): void {
    this.start(chainId);
    const state = this.chains.get(chainId)!;
    state.activeSince = undefined;
    state.operation = undefined;
    state.failed = result.status === 'unavailable';
    if (result.headBlock !== undefined) state.headBlock = result.headBlock;
    if (result.caughtUp !== undefined) state.caughtUp = result.caughtUp;
    if (result.fromBlock !== undefined || result.watchedPartial === true) state.watchedPartial = result.watchedPartial === true;
    if (!state.failed) {
      state.lastSuccessAt = this.now();
      if (result.toBlock !== undefined) state.lastSuccessBlock = result.toBlock;
    }
  }

  fail(chainId: number): void {
    this.start(chainId);
    const state = this.chains.get(chainId)!;
    state.activeSince = undefined;
    state.failed = true;
  }

  snapshot(): DiscoveryHealthSnapshot {
    const now = this.now();
    const chains: DiscoveryChainHealth[] = [...this.chains].sort(([a], [b]) => a - b).map(([chainId, row]) => {
      const lastProgress = row.lastSuccessAt ?? row.startedAt;
      const state: DiscoveryChainHealth['state'] = now < lastProgress || now - lastProgress >= this.staleMs ? 'stalled'
        : row.failed ? 'unavailable'
        : row.lastSuccessAt === undefined ? 'starting'
        : row.caughtUp === false ? 'catching_up'
        : row.watchedPartial === true ? 'partial'
        : row.activeSince !== undefined ? 'scanning' : 'healthy';
      return {
        chainId, state, startedAt: new Date(row.startedAt).toISOString(), pendingReads: row.pendingReads,
        ...(row.lastSuccessAt === undefined ? {} : { lastSuccessAt: new Date(row.lastSuccessAt).toISOString() }),
        ...(row.lastSuccessBlock === undefined ? {} : { lastSuccessBlock: row.lastSuccessBlock }),
        ...(row.headBlock === undefined ? {} : { headBlock: row.headBlock }),
        ...(row.caughtUp === undefined ? {} : { caughtUp: row.caughtUp }),
        ...(row.watchedPartial === undefined ? {} : { watchedPartial: row.watchedPartial }),
        ...(row.activeSince === undefined ? {} : { activeSince: new Date(row.activeSince).toISOString() }),
        ...(row.operation === undefined ? {} : { operation: row.operation }),
      };
    });
    const degraded = chains.some(row => ['stalled', 'unavailable', 'catching_up', 'partial'].includes(row.state));
    return { status: degraded ? 'degraded' : chains.length === 0 || chains.some(row => row.state === 'starting') ? 'starting' : 'healthy', chains };
  }
}
