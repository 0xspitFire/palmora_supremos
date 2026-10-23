import type { BackendStore } from './store.js';
import type { OperationalReadiness } from './types.js';
import { assertLiveOperationalReadiness, type CustodyPolicyBinding } from './custody.js';
import type { CompensatingAssuranceContext } from './compensating-controls.js';

export class RuntimeReadinessService {
  constructor(private readonly store: BackendStore, private readonly now: () => Date = () => new Date(), private readonly expectedCustodyPolicy?: CustodyPolicyBinding) {}
  /** `compensating` is given only by the service that accepts the compensated profile; without it that evidence kind is refused, as before. */
  async record(probe: OperationalReadiness, compensating?: CompensatingAssuranceContext): Promise<void> {
    const now = this.now().toISOString();
    if (!probe.secretStoreReference || !probe.storePath || !probe.lastReconciliationAt || !probe.observedAt || !probe.expiresAt) throw new Error('RUNTIME_PROBE_INCOMPLETE');
    if (probe.expiresAt <= now || probe.expiresAt <= probe.observedAt || probe.lastReconciliationAt > now) throw new Error('RUNTIME_PROBE_INVALID_TIME');
    assertLiveOperationalReadiness(probe, this.now(), this.expectedCustodyPolicy, undefined, compensating);
    await this.store.transaction(state => { state.runtime.operational = structuredClone(probe); });
  }
}
