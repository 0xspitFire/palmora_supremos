import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { BackendState, EventRecord } from './types.js';

const emptyState = (): BackendState => ({ campaigns: [], runs: [], intents: [], attempts: [], receipts: [], reconciliations: [], reservations: [], events: [], killed: false });
export class DurableStore {
  private state: BackendState = emptyState();
  private writeQueue: Promise<void> = Promise.resolve();
  private transactionQueue: Promise<void> = Promise.resolve();
  constructor(private readonly file?: string) {}
  async open(): Promise<void> {
    if (!this.file) return;
    try { const loaded = JSON.parse(await readFile(this.file, 'utf8'), (_, value) => typeof value === 'string' && /^\d+n$/.test(value) ? BigInt(value.slice(0, -1)) : value) as Partial<BackendState>; this.state = { ...emptyState(), ...loaded, intents: loaded.intents ?? [], attempts: loaded.attempts ?? [], receipts: loaded.receipts ?? [], reconciliations: loaded.reconciliations ?? [] }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  snapshot(): BackendState { return structuredClone(this.state); }
  replace(state: BackendState): void { this.state = state; }
  async transaction<T>(mutate: (state: BackendState) => T): Promise<T> {
    let result!: T;
    const operation = this.transactionQueue.then(async () => {
      const next = this.snapshot();
      result = mutate(next);
      this.state = next;
      await this.commit();
    });
    this.transactionQueue = operation.then(() => undefined, () => undefined);
    await operation;
    return result;
  }
  async commit(): Promise<void> {
    if (!this.file) return;
    const serialized = JSON.stringify(this.state, (_, value) => typeof value === 'bigint' ? `${value}n` : value);
    this.writeQueue = this.writeQueue.then(async () => { await mkdir(dirname(this.file!), { recursive: true }); const tmp = `${this.file}.tmp`; await writeFile(tmp, serialized, 'utf8'); await rename(tmp, this.file!); });
    await this.writeQueue;
  }
  appendEvent(event: EventRecord): void { this.state.events.push(event); }
}
