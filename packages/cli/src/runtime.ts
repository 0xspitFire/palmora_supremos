import { resolve } from 'node:path';
import { BackendApplication, ExecutionCoordinator, resolveWalletPath, SqliteStateStore, type BackendStore, type EngineAdapter } from '@mint-bot/backend';
import { createMintEngineAdapter, type MintEngineAdapterOptions } from './engine-adapter.js';

export interface CliRuntime { store: BackendStore; coordinator: ExecutionCoordinator; application: BackendApplication; walletRoot: string; }

export async function createCliRuntime(projectRoot: string, engine?: EngineAdapter, statePath = './Rets/state/backend.sqlite', adapterOptions?: Partial<Omit<MintEngineAdapterOptions, 'getState'>>): Promise<CliRuntime> {
  const store = await SqliteStateStore.open(resolve(projectRoot, statePath));
  const actualEngine = engine ?? createMintEngineAdapter({
    walletFile: resolveWalletPath(projectRoot),
    killSwitchFile: resolve(projectRoot, 'Rets', 'state', 'killswitch'),
    secretRoot: resolve(projectRoot, 'Rets'),
    logFile: resolve(projectRoot, 'Rets', 'state', 'mint-bot.log'),
    maxFeePerGasGwei: 100,
    gasLimitPadding: 1.2,
    maxReplacementBumps: 2,
    ...adapterOptions,
    getState: () => store.snapshot(),
    transact: (mutate) => store.transaction(mutate),
  });
  const coordinator = new ExecutionCoordinator(store, actualEngine);
  return { store, coordinator, application: new BackendApplication(store, coordinator), walletRoot: resolveWalletPath(projectRoot) };
}
