import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createPublicClient, type Address } from 'viem';
import { RuntimeReadinessService, type AssuranceRun, type CompensatingAssuranceConfig, type CanonicalStoreBridge, type CustodyPolicyBinding } from '@mint-bot/backend';
import { TurnkeySigner, failoverTransport, readTurnkeySecretConfig, resolveChainConfigFromSecrets } from '@mint-bot/engine';
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
  /** SHA-256 (hex) of the pinned approver public key file, set in the root-owned settings so a swap of both secret-root files is detected. */
  approverKeySha256: string;
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

/** The approver public key must hash to the digest pinned in settings; anything else is refused with one fixed code. */
export function assertApproverKeyPin(publicKeyText: string, expectedSha256Hex: string): void {
  if (!/^[0-9a-fA-F]{64}$/.test(expectedSha256Hex) || createHash('sha256').update(publicKeyText, 'utf8').digest('hex') !== expectedSha256Hex.toLowerCase()) throw new Error('TURNKEY_APPROVER_KEY_PIN_MISMATCH');
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
      // The key file sits beside the record it verifies, so its digest is also pinned in settings the service cannot change.
      assertApproverKeyPin(publicKey, inputs.approverKeySha256);
      return { signed, publicKey };
    },
    readOptional: () => readJsonIfPresent(join(inputs.secretRoot, 'turnkey-signing-rehearsal.json')),
    lockfileDigest: () => lockfileDigest(inputs.projectRoot),
    createSigner: async () => {
      const signer = await TurnkeySigner.fromSecrets('mainnet', inputs.secretRoot);
      return { probe: async () => { const health = await signer.probe(); return { status: health.status, policyRecordDigest: health.policyRecordDigest }; }, zeroize: () => signer.zeroize() };
    },
    readBalances: async (chainId, addresses) => {
      const chain = await resolveChainConfigFromSecrets(chainId as 1 | 8453 | 4663, 'mainnet', inputs.secretRoot);
      if (chain.rpcEndpoints.length === 0) throw new Error('CHAIN_ENDPOINT_UNAVAILABLE');
      const client = createPublicClient({ transport: failoverTransport(chain.rpcEndpoints) });
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
