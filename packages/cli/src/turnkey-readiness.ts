import {
  COMPENSATING_ASSURANCE_KIND,
  COMPENSATING_OBSERVATION_MAX_AGE_MS,
  DEFAULT_IDLE_BALANCE_CEILINGS,
  computeWalletSetDigest,
  planRunFunding,
  type AssuranceRun,
  type BalanceCeilings,
  type CompensatingAssuranceConfig,
  type CompensatingAssuranceContext,
  type CustodyPolicyBinding,
  type OperationalReadiness,
} from '@mint-bot/backend';
import { canonicalPolicyDigest, turnkeyPolicyRecordDigest, turnkeyPolicyRef, verifyTurnkeySignedPolicyRecord } from '@mint-bot/engine';
import { buildCompensatingEvidence, parseRehearsalEvidence, probeOrEngageKillSwitch } from './compensating-controls-cli.js';
import { requiredPerWallet } from './fleet-funding-cli.js';

/**
 * D-058 / D-059 service wiring (T-042 binding requirements 1 to 4). The running service, not a CLI command, decides whether a
 * Turnkey-custodied live run may arm:
 *  1. The expected digests come only from the owner-signed record that THIS code verifies with the pinned public key, plus
 *     configuration. Stored or CLI-produced evidence never supplies an expectation.
 *  2. The provider probe and the on-chain balances are taken in-process, just now, at every arm and execute, and recorded as the
 *     runtime's operational readiness by this code.
 *  3. The expected custody policy is derived from the verified record. Any probe failure engages the kill switch.
 *  4. Only the rehearsal record written earlier by a separate owner-run command is read, and it counts only
 *     when bound by digest to this record, wallet set and lockfile (the arm gate checks that).
 * Nothing here signs, broadcasts, funds or enables anything.
 */
export interface VerifiedTurnkeyRecord {
  digest: string;
  issuedAt: string;
  expiresAt: string;
  chainId: number;
  organizationId: string;
  policyReference: string;
  policyDigest: string;
  /** Lowercase addresses of every wallet the record covers. */
  addresses: readonly string[];
}

export interface ReadinessSigner {
  probe(): Promise<{ status: 'ok'; policyRecordDigest: string }>;
  zeroize(): void;
}

export interface TurnkeyReadinessOptions {
  readSigned: () => Promise<{ signed: unknown; publicKey: string }>;
  readOptional: (name: 'rehearsal') => Promise<unknown | undefined>;
  lockfileDigest: () => Promise<string>;
  createSigner: () => Promise<ReadinessSigner>;
  readBalances: (chainId: number, addresses: readonly string[]) => Promise<ReadonlyArray<{ address: string; balanceWei: bigint }>>;
  engageKillSwitch: (reason: string) => Promise<void>;
  killSwitchEngaged: () => Promise<boolean>;
  notificationsReady: () => Promise<boolean>;
  reconciledAt: () => string | undefined;
  chainVerified: (chainId: number) => boolean;
  /** Stores the readiness. The caller supplies the arm-gate context so the compensated evidence is judged exactly as a run would judge it. */
  record: (operational: OperationalReadiness, context: CompensatingAssuranceContext) => Promise<void>;
  secretStoreReference: string;
  storePath: string;
  ceilings?: BalanceCeilings;
  now?: () => Date;
  /** Tests inject a verifier; production uses the engine's signature and expiry check. */
  verifyRecord?: (signed: unknown, publicKey: string, at: Date) => VerifiedTurnkeyRecord;
}

/** The balances read for the run being armed are usable for this long, so a stale read can never fund a later run. */
const OBSERVATION_USABLE_MS = 60_000;

export function verifyOwnerSignedRecord(signed: unknown, publicKey: string, at: Date): VerifiedTurnkeyRecord {
  // Throws when the signature does not match the pinned key, or the record is expired.
  const record = verifyTurnkeySignedPolicyRecord(signed, publicKey, at);
  const policyDigest = canonicalPolicyDigest(record.enforcementPolicy);
  return {
    digest: turnkeyPolicyRecordDigest(record),
    issuedAt: record.issuedAt,
    expiresAt: record.expiresAt,
    chainId: record.enforcementPolicy.transaction.chainId,
    organizationId: record.enforcementPolicy.scope.organizationId,
    policyReference: turnkeyPolicyRef(record.enforcementPolicy.scope.policyId, policyDigest),
    policyDigest,
    addresses: record.wallets.map((wallet) => wallet.address.toLowerCase()),
  };
}

export interface TurnkeyReadiness {
  /** The binding the coordinator must hold every Turnkey observation to (T-042 requirement 3). */
  expectedCustodyPolicy: CustodyPolicyBinding;
  /** The coordinator's per-run assurance. Throws unless a fresh refresh for this run's chain exists. */
  assurance(run: AssuranceRun): CompensatingAssuranceConfig;
  /** Awaited before every live arm and execute. Throws (fail closed) on any problem. */
  refresh(run: AssuranceRun): Promise<void>;
  /** Run at service start: verifies the record and probes the provider. A failed probe engages the kill switch. */
  probeAtStart(): Promise<void>;
}

const FIXED_CODE = /^[A-Z][A-Z0-9_]{2,80}(?::[A-Z][A-Z0-9_]{2,80})?$/;
/** The message itself when it is entirely one or two fixed `UPPER_CASE` parts. Anything with provider text, an address, an amount or a system error's words is not a code. */
export function fixedCode(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : '';
  return FIXED_CODE.test(message) ? message : undefined;
}
/** Runs one readiness step; if it fails, the owner sees which step (a fixed name) or the step's own fixed code, never provider text. */
async function step<T>(fallback: string, work: () => Promise<T> | T): Promise<T> {
  try { return await work(); } catch (error) { throw new Error(fixedCode(error) ?? fallback); }
}

export async function createTurnkeyReadiness(options: TurnkeyReadinessOptions): Promise<TurnkeyReadiness> {
  const now = options.now ?? (() => new Date());
  const ceilings = options.ceilings ?? DEFAULT_IDLE_BALANCE_CEILINGS;
  const verify = options.verifyRecord ?? verifyOwnerSignedRecord;

  const loadRecord = async (): Promise<VerifiedTurnkeyRecord> => {
    const { signed, publicKey } = await options.readSigned();
    return verify(signed, publicKey, now());
  };

  const startup = await loadRecord();
  const binding: CustodyPolicyBinding = { provider: 'turnkey', providerIdentity: startup.organizationId, policyReference: startup.policyReference, policyDigest: startup.policyDigest, recordDigest: startup.digest };
  // One observation per chain, so a refresh on one chain never replaces the one another chain's arm is about to use.
  const observations = new Map<number, { at: number; balances: Map<string, bigint>; record: VerifiedTurnkeyRecord; lockfileDigest: string }>();

  /** Re-verifies the record and requires it to be the very record the service started with. */
  const currentRecord = async (): Promise<VerifiedTurnkeyRecord> => {
    const record = await loadRecord();
    if (record.digest !== startup.digest) throw new Error('TURNKEY_RECORD_CHANGED_RESTART_REQUIRED');
    return record;
  };

  const probe = async (record: VerifiedTurnkeyRecord) => {
    const signer = await step('READINESS_SIGNER_UNAVAILABLE', () => options.createSigner());
    try {
      const result = await probeOrEngageKillSwitch(() => signer.probe(), options.engageKillSwitch, now);
      // A provider that vouches for a different record than the verified one is drift: stop everything.
      if (result.policyRecordDigest !== record.digest) {
        await options.engageKillSwitch('provider-probe-failed').catch(() => undefined);
        throw new Error('TURNKEY_PROVIDER_DRIFT_KILL_SWITCH_ENGAGED');
      }
      return result;
    } finally {
      signer.zeroize();
    }
  };

  const assurance = (run: AssuranceRun): CompensatingAssuranceConfig => {
    const observed = observations.get(run.chainId);
    if (!observed || now().getTime() - observed.at > OBSERVATION_USABLE_MS) throw new Error('READINESS_NOT_REFRESHED');
    const wallets = run.wallets.map((wallet) => wallet.toLowerCase());
    const required = requiredPerWallet(run.campaign);
    const plan = planRunFunding({
      chainId: run.chainId,
      ceiling: ceilings[run.chainId],
      wallets: wallets.map((address) => {
        const balanceWei = observed.balances.get(address);
        if (balanceWei === undefined) throw new Error('COMPENSATING_CONTROL_WALLET_NOT_COVERED');
        return { address, balanceWei, requiredWei: required };
      }),
    });
    const blocker = plan.blockers[0];
    // The reason only, never the wallet address that some reasons carry after a colon.
    if (blocker) throw new Error(`FUNDING_PLAN_BLOCKED:${blocker.split(':')[0]}`);
    return {
      ceilings,
      expected: { recordDigest: observed.record.digest, walletSetDigest: computeWalletSetDigest(observed.record.addresses), lockfileDigest: observed.lockfileDigest },
      runEnvelopeWei: plan.runEnvelopeWei,
      minimumBalanceWei: plan.minimumBalanceWei,
    };
  };

  return {
    expectedCustodyPolicy: binding,
    assurance,
    probeAtStart: async () => { await probe(await currentRecord()); },
    refresh: async (run) => {
      const at = now();
      const record = await step('READINESS_RECORD_UNREADABLE', () => currentRecord());
      if (run.chainId !== record.chainId) throw new Error('TURNKEY_RECORD_CHAIN_MISMATCH');
      const covered = new Set(record.addresses);
      if (run.wallets.length === 0 || run.wallets.some((wallet) => !covered.has(wallet.toLowerCase()))) throw new Error('TURNKEY_WALLET_NOT_IN_RECORD');
      const providerProbe = await probe(record);
      const balances = await step('READINESS_BALANCES_UNREADABLE', () => options.readBalances(run.chainId, record.addresses));
      const lockfileDigest = await step('READINESS_LOCKFILE_UNREADABLE', () => options.lockfileDigest());
      const rehearsalRaw = await options.readOptional('rehearsal').catch(() => undefined);
      const rehearsal = (() => { try { return rehearsalRaw === undefined ? undefined : parseRehearsalEvidence(rehearsalRaw); } catch { return undefined; } })();
      const evidence = await step('READINESS_EVIDENCE_FAILED', () => buildCompensatingEvidence({
        chainId: run.chainId,
        record: { digest: record.digest, issuedAt: record.issuedAt, expiresAt: record.expiresAt, wallets: record.addresses },
        lockfileDigest,
        probe: providerProbe,
        balances,
        ...(rehearsal ? { rehearsal } : {}),
        now: at,
        balanceValiditySeconds: Math.floor(COMPENSATING_OBSERVATION_MAX_AGE_MS / 1000),
      }));
      observations.set(run.chainId, { at: at.getTime(), balances: new Map(balances.map((balance) => [balance.address.toLowerCase(), balance.balanceWei])), record, lockfileDigest });
      const reconciledAt = options.reconciledAt();
      if (!reconciledAt) throw new Error('RECONCILIATION_REQUIRED');
      const observedAt = at.toISOString();
      const expiresAt = new Date(at.getTime() + COMPENSATING_OBSERVATION_MAX_AGE_MS).toISOString();
      const operational: OperationalReadiness = {
        secretStoreReference: options.secretStoreReference,
        storePath: options.storePath,
        signerReady: true,
        custody: {
          provider: 'turnkey',
          providerIdentity: record.organizationId,
          policyReference: record.policyReference,
          policyDigest: record.policyDigest,
          recordDigest: record.digest,
          policyStatus: 'approved',
          healthStatus: 'healthy',
          attestationStatus: 'unknown',
          evidenceId: `compensating-${record.digest.slice(7, 23)}-${at.getTime()}`,
          observedAt,
          expiresAt,
          assuranceKind: COMPENSATING_ASSURANCE_KIND,
          compensatingControls: evidence,
        },
        killSwitchEngaged: await options.killSwitchEngaged(),
        notificationReady: await options.notificationsReady(),
        chainVerification: options.chainVerified(run.chainId) ? 'verified' : 'unverified',
        lastReconciliationAt: reconciledAt,
        observedAt,
        expiresAt,
      };
      await step('READINESS_RECORD_REJECTED', () => options.record(operational, { config: assurance(run), chainId: run.chainId, wallets: run.wallets }));
    },
  };
}
