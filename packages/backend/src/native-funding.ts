import {
  assertNativeFundingPolicy,
  type NativeFundingPolicy, type NativeFundingRequest, type NativeFundingPreparation,
  type NativeFundingRecord, type NativeFundingReceiptObservation, type NativeFundingRepository,
  type NativeFundingCanonicalBlockObservation,
} from '@mint-bot/database';

export interface NativeFundingEnginePort {
  prepare(request: NativeFundingRequest, policy: NativeFundingPolicy): Promise<NativeFundingPreparation>;
  execute(record: NativeFundingRecord, hooks: {
    assertCurrent(): Promise<void>; claimForSigning(): Promise<void>;
    persistSigned(hash: string): Promise<void>; markBroadcasting(): Promise<void>; markSubmitted(hash: string): Promise<void>;
  }): Promise<{ hash: string }>;
}
const safe = (error: unknown): Error => new Error(error instanceof Error && /^NATIVE_FUNDING_[A-Z_]{1,70}$/.test(error.message) ? error.message : 'NATIVE_FUNDING_UNAVAILABLE');
const fingerprint = (value: unknown) => JSON.stringify(value, (_key, item: unknown) => typeof item === 'bigint' ? item.toString() : item);

/** Attach only to an authoritative ExecutionCoordinator operation.
 * This service creates no credentials, keys, RPC transports, policies or owner grants.
 * Repository authority is the synchronous canonical parent/current-policy check;
 * assertReady refreshes the independent custody/chain/simulation/watcher/kill evidence.
 */
export class FundingCoordinatorService {
  private readonly now: () => Date;
  public constructor(private readonly options: {
    repository: NativeFundingRepository;
    policy(): NativeFundingPolicy | undefined;
    assertReady(record: NativeFundingRecord): Promise<void>;
    engine: NativeFundingEnginePort;
    receipts(record: NativeFundingRecord): Promise<readonly NativeFundingReceiptObservation[]>;
    canonicalBlocks?(record: NativeFundingRecord): Promise<readonly NativeFundingCanonicalBlockObservation[]>;
    now?: () => Date;
  }) { this.now = options.now ?? (() => new Date()); }

  public async execute(request: NativeFundingRequest): Promise<NativeFundingRecord> {
    request = structuredClone(request);
    let claimed = false;
    try {
      const policy = this.currentPolicy();
      const existing = this.options.repository.get(request.id);
      const preparation = existing?.preparation ?? await this.options.engine.prepare(request, policy);
      const admitted = this.options.repository.admit(request, preparation, policy, this.now());
      // Durable claims never restart a signer or create an alternate nonce after ambiguity.
      if (admitted.state !== 'reserved') return admitted;
      const assertCurrent = async (): Promise<void> => {
        const current = this.currentPolicy();
        if (fingerprint(current) !== fingerprint(admitted.policy)) throw new Error('NATIVE_FUNDING_POLICY_CHANGED');
        this.options.repository.reconfirm(request.id, this.now());
        await this.options.assertReady(structuredClone(this.required(request.id)));
        // Readiness may await a provider; recheck current authority after it completes.
        if (fingerprint(this.currentPolicy()) !== fingerprint(admitted.policy)) throw new Error('NATIVE_FUNDING_POLICY_CHANGED');
        this.options.repository.reconfirm(request.id, this.now());
      };
      await assertCurrent();
      await this.options.engine.execute(admitted, {
        assertCurrent,
        claimForSigning: async () => { this.options.repository.claimForSigning(request.id, this.now()); claimed = true; },
        persistSigned: async hash => { this.options.repository.markSigned(request.id, hash, this.now()); },
        markBroadcasting: async () => { this.options.repository.markBroadcasting(request.id, this.now()); },
        markSubmitted: async hash => { this.options.repository.markSubmitted(request.id, hash, this.now()); },
      });
      return this.required(request.id);
    } catch (error) {
      const current = this.options.repository.get(request.id);
      // Only this worker's successful signing claim may update its ambiguity marker.
      // A competing caller must not overwrite another worker's signing lifecycle.
      if (claimed && current && !['reserved', 'settled', 'released'].includes(current.state)) this.options.repository.retainUnknown(request.id, this.now());
      throw safe(error);
    }
  }

  /** Reconciliation is permitted while killed or policy-expired; it grants no new signature. */
  public async reconcile(id: string): Promise<NativeFundingRecord> {
    try {
      let record = this.required(id);
      if (record.state === 'settled') {
        if (!record.receipt || !this.options.canonicalBlocks) return record;
        const blocks = await this.options.canonicalBlocks(structuredClone(record));
        if (blocks.length !== 2 || !blocks.every(block => block.blockHash.toLowerCase() !== record.receipt!.blockHash.toLowerCase())) return this.required(id);
        record = this.reconcileReorg(id, blocks);
      }
      if (!record.transactionHash || record.state === 'released') return record;
      const observations = await this.options.receipts(structuredClone(record));
      if (observations.length !== 2) return this.required(id);
      return this.options.repository.settle(id, observations, this.now());
    } catch (error) { throw safe(error); }
  }

  /** Called by the coordinator's chain observer with two positive canonical-block proofs. */
  public reconcileReorg(id: string, observations: readonly NativeFundingCanonicalBlockObservation[]): NativeFundingRecord {
    try { return this.options.repository.reopenAfterReorg(id, observations, this.now()); }
    catch (error) { throw safe(error); }
  }

  private currentPolicy(): NativeFundingPolicy {
    const policy = this.options.policy();
    if (!policy) throw new Error('NATIVE_FUNDING_POLICY_REQUIRED');
    const copy = structuredClone(policy);
    assertNativeFundingPolicy(copy, this.now());
    return copy;
  }
  private required(id: string): NativeFundingRecord {
    const record = this.options.repository.get(id);
    if (!record) throw new Error('NATIVE_FUNDING_NOT_FOUND');
    return record;
  }
}
