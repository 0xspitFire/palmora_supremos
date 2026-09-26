import type { BackendStore } from './store.js';
import type { OperationalReadiness } from './types.js';
import { assertLiveOperationalReadiness, type CustodyPolicyBinding } from './custody.js';

export class RuntimeReadinessService {
  constructor(private readonly store: BackendStore, private readonly now: () => Date = () => new Date(), private readonly expectedCustodyPolicy?: CustodyPolicyBinding) {}
  async record(probe: OperationalReadiness): Promise<void> {
    const now = this.now().toISOString();
    if (!probe.secretStoreReference || !probe.storePath || !probe.lastReconciliationAt || !probe.observedAt || !probe.expiresAt) throw new Error('RUNTIME_PROBE_INCOMPLETE');
    if (probe.expiresAt <= now || probe.expiresAt <= probe.observedAt || probe.lastReconciliationAt > now) throw new Error('RUNTIME_PROBE_INVALID_TIME');
    assertLiveOperationalReadiness(probe, this.now(), this.expectedCustodyPolicy);
    await this.store.transaction(state => { state.runtime.operational = structuredClone(probe); });
  }
}
