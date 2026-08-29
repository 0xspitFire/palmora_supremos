import type { BackendStore } from './store.js';
import type { DependencyReadiness } from './types.js';

export class DeploymentReadinessService {
  constructor(private readonly store: BackendStore) {}
  async record(readiness: Partial<DependencyReadiness>): Promise<void> {
    await this.store.transaction(state => { state.runtime.dependencies = { ...state.runtime.dependencies, ...readiness }; });
  }
}
