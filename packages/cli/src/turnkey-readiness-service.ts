import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createPublicClient, http, type Address } from 'viem';
import { RuntimeReadinessService, type AssuranceRun, type CompensatingAssuranceConfig, type CanonicalStoreBridge, type CustodyPolicyBinding } from '@mint-bot/backend';
import { TurnkeySigner, readTurnkeySecretConfig, resolveChainConfigFromSecrets } from '@mint-bot/engine';
import { engageKillSwitchFile, lockfileDigest } from './compensating-controls-cli.js';
import { createTurnkeyReadiness, type TurnkeyReadiness } from './turnkey-readiness.js';
import { readProtectedText } from './turnkey-files.js';

/**
 * Binds the service-side Turnkey readiness (turnkey-readiness.ts) to the real thing: the owner-signed record and pinned public
 * key under the secret root, the Turnkey provider, the chain RPC, the kill-switch file and the runtime store. Host mode only.
 * Nothing here signs a transaction, sends funds or enables anything.
 */
export interface ServiceReadinessInputs {
  projectRoot: string;
  secretRoot: string;
  killSwitchPath: string;
  storePath: string;
  /** Where a watcher handle appears once the watcher has started; until then no wallet counts as watched (fail closed). */
  watcher: () => { covers(chainId: number, wallets: readonly string[]): boolean; isHealthy(at?: Date): boolean } | undefined;
  now?: () => Date;
}

export interface CoordinatorAssuranceWiring {
  expectedCustodyPolicy: CustodyPolicyBinding;
  compensatingAssurance: (run: AssuranceRun) => CompensatingAssuranceConfig;
  refreshReadiness: (run: AssuranceRun) => Promise<void>;
  walletWatch: { covers(chainId: number, wallets: readonly string[]): boolean; isHealthy(at?: Date): boolean };
  readiness: TurnkeyReadiness;
}

async function readJsonIfPresent(path: string): Promise<unknown | undefined> {
  try { return JSON.parse(await readProtectedText(path, 'TURNKEY_ARTIFACT_PERMISSIONS_REQUIRED', true)) as unknown; } catch { return undefined; }
}

export async function createServiceAssurance(store: CanonicalStoreBridge, inputs: ServiceReadinessInputs): Promise<CoordinatorAssuranceWiring> {
  const now = inputs.now ?? (() => new Date());
  const killSwitchEngaged = async (): Promise<boolean> => existsSync(inputs.killSwitchPath) || store.snapshot().killed;
  let binding: CustodyPolicyBinding | undefined;
  const readiness = await createTurnkeyReadiness({
    readSigned: async () => {
      const config = await readTurnkeySecretConfig(inputs.secretRoot);
      const signed = JSON.parse(await readProtectedText(config.policyRecordPath, 'TURNKEY_POLICY_RECORD_PERMISSIONS_REQUIRED', true)) as unknown;
      const publicKey = await readProtectedText(config.policyApproverPublicKeyPath, 'TURNKEY_POLICY_APPROVER_KEY_PERMISSIONS_REQUIRED', true);
      return { signed, publicKey };
    },
    readOptional: (name) => readJsonIfPresent(join(inputs.secretRoot, name === 'rehearsal' ? 'turnkey-signing-rehearsal.json' : 'turnkey-trust-center-review.json')),
    lockfileDigest: () => lockfileDigest(inputs.projectRoot),
    createSigner: async () => {
      const signer = await TurnkeySigner.fromSecrets('mainnet', inputs.secretRoot);
      return { probe: async () => { const health = await signer.probe(); return { status: health.status, policyRecordDigest: health.policyRecordDigest }; }, zeroize: () => signer.zeroize() };
    },
    readBalances: async (chainId, addresses) => {
      const chain = await resolveChainConfigFromSecrets(chainId as 1 | 8453 | 4663, 'mainnet', inputs.secretRoot);
      const endpoint = chain.rpcEndpoints[0];
      if (!endpoint) throw new Error('CHAIN_ENDPOINT_UNAVAILABLE');
      const client = createPublicClient({ transport: http(endpoint, { timeout: 15_000, retryCount: 1 }) });
      return Promise.all(addresses.map(async (address) => ({ address, balanceWei: await client.getBalance({ address: address as Address }) })));
    },
    engageKillSwitch: (reason) => engageKillSwitchFile(inputs.killSwitchPath, reason),
    killSwitchEngaged,
    notificationsReady: async () => store.snapshot().runtime.dependencies.notifications === true,
    reconciledAt: () => store.snapshot().runtime.reconciliationCompletedAt,
    chainVerified: (chainId) => store.snapshot().chainEvidence.some((evidence) => evidence.chainId === chainId && evidence.status === 'accepted' && evidence.executionEnabled && Date.parse(evidence.expiresAt) > now().getTime()),
    secretStoreReference: 'host-secret-store',
    storePath: inputs.storePath,
    record: (operational, context) => new RuntimeReadinessService(store, now, binding).record(operational, context),
    ...(inputs.now ? { now: inputs.now } : {}),
  });
  binding = readiness.expectedCustodyPolicy;
  return {
    expectedCustodyPolicy: readiness.expectedCustodyPolicy,
    compensatingAssurance: (run) => readiness.assurance(run),
    refreshReadiness: (run) => readiness.refresh(run),
    // Late-bound: the watcher starts after the runtime exists. Until it does, nothing counts as watched.
    walletWatch: {
      covers: (chainId, wallets) => inputs.watcher()?.covers(chainId, wallets) ?? false,
      isHealthy: (at) => inputs.watcher()?.isHealthy(at) ?? false,
    },
    readiness,
  };
}
