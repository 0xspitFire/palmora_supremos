import { DurableStore, HealthService, RuntimeReadinessService, validateOpsHealthEnvironment } from '../packages/backend/dist/index.js';

const environment = {
  mode: process.env.OPS_HEALTH_MODE,
  secretStoreReference: process.env.SECRET_STORE_REFERENCE,
  storePath: process.env.STORE_PATH,
  signerReady: process.env.SIGNER_READY,
  killSwitchEngaged: process.env.KILL_SWITCH_ENGAGED,
  notificationReady: process.env.NOTIFICATION_READY,
  chainVerification: process.env.CHAIN_VERIFICATION,
  lastReconciliationAt: process.env.LAST_RECONCILIATION_AT,
  probeTtlMs: process.env.RUNTIME_PROBE_TTL_MS,
  engineReady: process.env.ENGINE_READY,
  chainReady: process.env.CHAIN_READY,
  backupReady: process.env.BACKUP_READY,
  atomicStoreReady: process.env.ATOMIC_STORE_READY,
};
const validation = validateOpsHealthEnvironment(environment);
if (!validation.valid) {
  console.log(JSON.stringify({ status: 'failed', mode: 'non-production', blockingReasons: validation.blockingReasons }));
  process.exitCode = 1;
} else {
  class HarnessStore extends DurableStore { capabilities() { return { durable: true, atomicAcrossProcesses: true }; } }
  const store = new HarnessStore();
  await store.transaction(state => {
    state.runtime = { startupState: 'Ready', reconciliationCompletedAt: validation.probe.lastReconciliationAt, blockingReasons: [], dependencies: { engine: true, chain: true, backup: true, notifications: true } };
  });
  await new RuntimeReadinessService(store).record(validation.probe);
  const health = new HealthService(store).check();
  console.log(JSON.stringify({ status: health.ready ? 'ok' : 'failed', mode: 'non-production', blockingReasons: health.blockingReasons, policy: health.policy }));
  process.exitCode = health.ready ? 0 : 1;
}
