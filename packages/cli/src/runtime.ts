import { resolve } from 'node:path';
import { BackendApplication, DurableStore, ExecutionCoordinator, resolveWalletPath, type EngineAdapter } from '@mint-bot/backend';

export interface CliRuntime { store: DurableStore; coordinator: ExecutionCoordinator; application: BackendApplication; walletRoot: string; }

export async function createCliRuntime(projectRoot: string, engine: EngineAdapter, statePath = './Rets/state/backend.json'): Promise<CliRuntime> {
  const store = new DurableStore(resolve(projectRoot, statePath));
  await store.open();
  const coordinator = new ExecutionCoordinator(store, engine);
  return { store, coordinator, application: new BackendApplication(store, coordinator), walletRoot: resolveWalletPath(projectRoot) };
}
