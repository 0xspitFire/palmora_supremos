import { resolve } from 'node:path';
import { BackendApplication, CanonicalStoreBridge, ExecutionCoordinator, resolveWalletPath, type BackendStore, type EngineAdapter } from '@mint-bot/backend';
import { openDatabase } from '@mint-bot/database';
import { createCanonicalLifecycleStore, createMintEngineAdapter, type MintEngineAdapterOptions } from './engine-adapter.js';

export interface CliRuntime { store: BackendStore; coordinator: ExecutionCoordinator; application: BackendApplication; walletRoot: string; }

export async function createCliRuntime(projectRoot: string, engine?: EngineAdapter, statePath = process.env.MINT_BOT_STATE_PATH ?? './Rets/state/backend.sqlite', adapterOptions?: Partial<Omit<MintEngineAdapterOptions, 'getState'>>): Promise<CliRuntime> {
  const store = new CanonicalStoreBridge(openDatabase(resolve(projectRoot, statePath)), { durable: true });
  await store.open();
  const lifecycleStore = createCanonicalLifecycleStore(store);
  const actualEngine = engine ?? createMintEngineAdapter({
    walletFile: resolveWalletPath(projectRoot),
    killSwitchFile: resolve(projectRoot, 'Rets', 'state', 'killswitch'),
    secretRoot: resolve(projectRoot, 'Rets'),
    logFile: resolve(projectRoot, 'Rets', 'state', 'mint-bot.log'),
    maxFeePerGasGwei: 100,
    gasLimitPadding: 1.2,
    maxReplacementBumps: 0,
    ...adapterOptions,
    getState: () => store.snapshot(),
    transact: (mutate) => store.transaction(mutate),
    lifecycleStore: adapterOptions?.lifecycleStore ?? lifecycleStore,
    settleComponents: adapterOptions?.settleComponents ?? ((reservationId, components) => store.settleExecutionComponents(reservationId, components)),
  });
  const coordinator = new ExecutionCoordinator(store, actualEngine);
  await coordinator.start();
  return { store, coordinator, application: new BackendApplication(store, coordinator), walletRoot: resolveWalletPath(projectRoot) };
}
