import { cleanCollectionName } from '../alert-card.js';
import type { IntelligenceChainPort } from './port.js';

export interface CollectionNamesOptions {
  /** Cached contracts; the oldest are dropped first. */
  maxEntries?: number;
  /** Give up on a contract after this many failed reads in a row (a network error is not an answer). */
  maxFailedReads?: number;
  /** Time allowed for one read. */
  readTimeoutMs?: number;
}

/**
 * Collection names read from the chain (T-029): a contract's own `name()`, read before any alert is built,
 * so an alert says `ETH MINT` only when the contract really has no name. One read per contract is kept for
 * the life of the process. A contract with no name (or a revert) is a final answer; a network error or a
 * timeout is not, and is retried once at once and again on a later alert. Names are untrusted text and
 * leave here already cleaned.
 */
export class CollectionNames {
  private readonly known = new Map<string, string | null>();
  private readonly failedReads = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<string | null>>();
  private readonly maxEntries: number;
  private readonly maxFailedReads: number;
  private readonly readTimeoutMs: number;

  public constructor(private readonly port: Pick<IntelligenceChainPort, 'readName'>, options: CollectionNamesOptions = {}) {
    this.maxEntries = options.maxEntries ?? 1_000;
    this.maxFailedReads = options.maxFailedReads ?? 3;
    this.readTimeoutMs = options.readTimeoutMs ?? 4_000;
  }

  /** The cleaned collection name, or null when the contract has none or it could not be read. */
  public async get(contract: string): Promise<string | null> {
    const key = contract.toLowerCase();
    if (this.known.has(key)) return this.known.get(key) ?? null;
    if (!this.port.readName || (this.failedReads.get(key) ?? 0) >= this.maxFailedReads) return null;
    let pending = this.inFlight.get(key);
    if (!pending) {
      pending = this.read(key).finally(() => this.inFlight.delete(key));
      this.inFlight.set(key, pending);
    }
    return pending;
  }

  private async read(key: string): Promise<string | null> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const outcome = await this.once(key);
      // A timeout is not asked again at once (that would double the wait); a quick network error is.
      if (outcome.status === 'timeout') break;
      if (outcome.status === 'error') continue;
      const name = outcome.status === 'name' ? cleanCollectionName(outcome.name) : null;
      this.remember(key, name);
      return name;
    }
    this.failedReads.set(key, (this.failedReads.get(key) ?? 0) + 1);
    if (this.failedReads.size > this.maxEntries) { const oldest = this.failedReads.keys().next().value; if (oldest !== undefined) this.failedReads.delete(oldest); }
    return null;
  }

  private async once(key: string): Promise<Awaited<ReturnType<NonNullable<IntelligenceChainPort['readName']>>> | { status: 'timeout' }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<{ status: 'timeout' }>((resolve) => { timer = setTimeout(() => resolve({ status: 'timeout' }), this.readTimeoutMs); });
      return await Promise.race([this.port.readName!(key), timeout]);
    } catch { return { status: 'error' }; } finally { if (timer) clearTimeout(timer); }
  }

  private remember(key: string, name: string | null): void {
    this.known.set(key, name);
    this.failedReads.delete(key);
    if (this.known.size > this.maxEntries) { const oldest = this.known.keys().next().value; if (oldest !== undefined) this.known.delete(oldest); }
  }
}
