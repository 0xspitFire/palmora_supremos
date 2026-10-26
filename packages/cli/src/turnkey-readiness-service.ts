import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createPublicClient, type Address } from 'viem';
import { RuntimeReadinessService, type AssuranceRun, type CompensatingAssuranceConfig, type CanonicalStoreBridge, type CustodyPolicyBinding } from '@mint-bot/backend';
import { TurnkeySigner, failoverTransport, readTurnkeySecretConfig, resolveChainConfigFromSecrets, turnkeyPolicySelection, validateTurnkeyPolicyBundle, verifyTurnkeySignedPolicyCatalog, verifyTurnkeySignedPolicyRecord } from '@mint-bot/engine';
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
  expectedCustodyPolicy: CustodyPolicyBinding | ((run: AssuranceRun) => CustodyPolicyBinding);
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
  const createForPolicy = async (policyReference?: string, recordDigest?: string): Promise<TurnkeyReadiness> => {
    if (policyReference && !recordDigest) throw new Error('TURNKEY_POLICY_RECORD_DIGEST_REQUIRED');
    let binding: CustodyPolicyBinding | undefined;
    const readiness = await createTurnkeyReadiness({
    readSigned: async () => {
      const config = await readTurnkeySecretConfig(inputs.secretRoot);
      const publicKey = await readProtectedText(config.policyApproverPublicKeyPath, 'TURNKEY_POLICY_APPROVER_KEY_PERMISSIONS_REQUIRED', true);
      // The key file sits beside the record it verifies, so its digest is also pinned in settings the service cannot change.
      assertApproverKeyPin(publicKey, inputs.approverKeySha256);
      const bundle = config.policyBundlePath
        ? JSON.parse(await readProtectedText(config.policyBundlePath, 'TURNKEY_POLICY_BUNDLE_PERMISSIONS_REQUIRED', true)) as unknown
        : undefined;
      if (bundle) validateTurnkeyPolicyBundle(bundle, publicKey, now());
      const active = bundle ? (bundle as { activeRecord: unknown }).activeRecord : JSON.parse(await readProtectedText(config.policyRecordPath, 'TURNKEY_POLICY_RECORD_PERMISSIONS_REQUIRED', true)) as unknown;
      if (!policyReference) return { signed: active, publicKey };
      const activeRecord = verifyTurnkeySignedPolicyRecord(active, publicKey, now());
      const activeSelection = turnkeyPolicySelection(activeRecord);
      if (activeSelection.policyReference === policyReference && (recordDigest === undefined || activeSelection.recordDigest === recordDigest)) return { signed: active, publicKey };
      if (!bundle && !config.policyCatalogPath) throw new Error('TURNKEY_POLICY_SELECTION_NOT_FOUND');
      const catalog = bundle ? (bundle as { catalog: { records?: unknown[] } }).catalog : JSON.parse(await readProtectedText(config.policyCatalogPath!, 'TURNKEY_POLICY_CATALOG_PERMISSIONS_REQUIRED', true)) as { records?: unknown[] };
      const records = verifyTurnkeySignedPolicyCatalog(catalog, publicKey, now());
      const selectedRecord = records.find((record) => { const selection = turnkeyPolicySelection(record); return selection.policyReference === policyReference && selection.recordDigest === recordDigest; });
      const selectedDigest = selectedRecord ? turnkeyPolicySelection(selectedRecord).recordDigest : undefined;
      const signed = selectedDigest ? catalog.records?.find((entry) => Boolean(entry) && typeof entry === 'object' && (entry as { recordDigest?: unknown }).recordDigest === selectedDigest) : undefined;
      if (!signed) throw new Error('TURNKEY_POLICY_SELECTION_NOT_FOUND');
      return { signed, publicKey };
    },
    readOptional: () => readJsonIfPresent(join(inputs.secretRoot, 'turnkey-signing-rehearsal.json')),
    lockfileDigest: () => lockfileDigest(inputs.projectRoot),
    createSigner: async () => {
      const signer = await TurnkeySigner.fromSecrets('mainnet', inputs.secretRoot, policyReference, recordDigest);
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
    return readiness;
  };
  const readiness = await createForPolicy();
  const readinessByPolicy = new Map<string, Promise<TurnkeyReadiness>>();
  const readyByPolicy = new Map<string, TurnkeyReadiness>();
  const selected = (run: AssuranceRun): Promise<TurnkeyReadiness> => {
    const reference = run.campaign.custodyPolicy?.policyReference;
    const digest = run.campaign.custodyPolicy?.recordDigest;
    if (run.campaign.dryRun === false && (!reference || !digest)) throw new Error('TURNKEY_CAMPAIGN_POLICY_BINDING_REQUIRED');
    if (!reference || (reference === readiness.expectedCustodyPolicy.policyReference && (digest === undefined || digest === readiness.expectedCustodyPolicy.recordDigest))) return Promise.resolve(readiness);
    const key = `${reference}:${digest ?? ''}`;
    let value = readinessByPolicy.get(key);
    if (!value) {
      value = createForPolicy(reference, digest).then((created) => { readyByPolicy.set(key, created); return created; });
      readinessByPolicy.set(key, value);
    }
    return value;
  };
  const expected = (run: AssuranceRun): CustodyPolicyBinding => {
    if (run.campaign.dryRun === false && (!run.campaign.custodyPolicy?.policyReference || !run.campaign.custodyPolicy.recordDigest)) throw new Error('TURNKEY_CAMPAIGN_POLICY_BINDING_REQUIRED');
    return run.campaign.custodyPolicy
      ? { provider: 'turnkey', providerIdentity: readiness.expectedCustodyPolicy.providerIdentity, policyReference: run.campaign.custodyPolicy.policyReference, policyDigest: run.campaign.custodyPolicy.policyDigest, recordDigest: run.campaign.custodyPolicy.recordDigest }
      : readiness.expectedCustodyPolicy;
  };
  return {
    expectedCustodyPolicy: expected,
    compensatingAssurance: (run) => {
      const reference = run.campaign.custodyPolicy?.policyReference;
      const digest = run.campaign.custodyPolicy?.recordDigest;
      const instance = !reference || (reference === readiness.expectedCustodyPolicy.policyReference && (digest === undefined || digest === readiness.expectedCustodyPolicy.recordDigest)) ? readiness : readyByPolicy.get(`${reference}:${digest ?? ''}`);
      if (!instance) throw new Error('READINESS_NOT_REFRESHED');
      return instance.assurance(run);
    },
    refreshReadiness: async (run) => { await (await selected(run)).refresh(run); },
    // Late-bound: the watcher starts after the runtime exists. Until it does, nothing counts as watched.
    walletWatch: {
      covers: (chainId, wallets) => inputs.watcher()?.covers(chainId, wallets) ?? false,
      isHealthy: (at) => inputs.watcher()?.isHealthy(at) ?? false,
    },
    readiness,
  };
}
