import { BackendStateRepository, openDatabase, type SqliteDatabase } from '@mint-bot/database';
import type { BackendState, StoreCapabilities } from './types.js';
import type { BackendStore } from './store.js';

const emptyState = (): BackendState => ({
  schemaVersion: 1,
  campaigns: [],
  runs: [],
  intents: [],
  attempts: [],
  receipts: [],
  reconciliations: [],
  reservations: [],
  events: [],
  notificationOutbox: [],
  chainEvidence: [],
  simulations: [],
  runtime: {
    startupState: 'Cold',
    blockingReasons: ['RECONCILIATION_REQUIRED'],
    dependencies: { engine: false, chain: false, backup: false, notifications: false },
  },
  killed: false,
});

/** BackendStore implementation backed by the SQLite state repository. */
export class SqliteStateStore implements BackendStore {
  private readonly repository: BackendStateRepository;

  public constructor(private readonly db: SqliteDatabase) {
    this.repository = new BackendStateRepository(db);
  }

  public static async open(filename: string): Promise<SqliteStateStore> {
    const store = new SqliteStateStore(openDatabase(filename));
    await store.open();
    return store;
  }

  public async open(): Promise<void> {
    this.repository.initialize();
    if (!this.repository.read<BackendState>()) this.repository.write(emptyState());
  }

  public close(): void {
    this.db.close();
  }

  public capabilities(): StoreCapabilities {
    return { durable: true, atomicAcrossProcesses: true };
  }

  public snapshot(): BackendState {
    return this.repository.read<BackendState>() ?? emptyState();
  }

  public transaction<T>(mutate: (state: BackendState) => T): Promise<T> {
    return Promise.resolve(this.repository.transaction(emptyState(), mutate));
  }

  public commit(): Promise<void> {
    return Promise.resolve();
  }
}
