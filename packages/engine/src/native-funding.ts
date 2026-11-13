import { keccak256, parseTransaction, type Address, type Hex } from 'viem';
import { assertSignedMatchesIntent } from './pre-sign.js';
import type { TransactionIntent, SupportedChainId } from './types.js';

/** Structural ports keep funding custody separate from the mint signer/family registry. */
export interface NativeFundingEnginePolicy {
  kind: 'native-fleet-topup-v1'; active: boolean; chainId: SupportedChainId; hub: string;
  recipients: readonly string[]; recordDigest: string; budgetProfileDigest: string; walletSetDigest: string;
  policyReference: string; expiresAt: string; maxTransferWei: bigint;
  gasLimitMax: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint;
}
export interface NativeFundingEngineRequest {
  id: string; parentRunId: string; parentHoldId: string; parentHoldDigest: string;
  chainId: SupportedChainId; recipient: string; requiredBalanceWei: bigint; expiresAt: string;
}
export interface NativeFundingEnginePreparation {
  hub: string; recipientBalanceWei: bigint; fleetBalanceWei: bigint; hubBalanceWei: bigint;
  valueWei: bigint; gasLimit: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint;
  l1DataFeeBoundWei: bigint; operatorFeeBoundWei: bigint; nonce: number;
  observedAt: string; blockNumber: bigint; blockHash: string; recipientCode: '0x';
}
export interface NativeFundingEngineRecord {
  request: NativeFundingEngineRequest; policy: NativeFundingEnginePolicy;
  preparation: NativeFundingEnginePreparation; state: string;
}
export interface NativeFundingReader {
  getChainId(): Promise<number>;
  getBlockNumber(): Promise<bigint>;
  getBlock(number: bigint): Promise<{ number: bigint; hash: string; timestamp: bigint }>;
  getBalance(address: Address, block: bigint | 'pending'): Promise<bigint>;
  getCode(address: Address, block: bigint | 'pending'): Promise<Hex>;
  getPendingNonce(address: Address): Promise<number>;
  estimateGas(intent: TransactionIntent, block: bigint): Promise<bigint>;
  simulate(intent: TransactionIntent, block: bigint): Promise<Hex | undefined>;
  /** Must include chain-specific L1/operator bounds, not silently substitute zero on L2. */
  feeBounds(intent: TransactionIntent, block: bigint): Promise<{ l1DataFeeBoundWei: bigint; operatorFeeBoundWei: bigint }>;
}
export interface NativeFundingSigner {
  readonly address: Address;
  /** Separate owner-approved native-funding custody role. Reconfirm at the final provider boundary. */
  sign(intent: TransactionIntent, assertCurrent: () => Promise<void>): Promise<Hex>;
}
export interface NativeFundingEngineHooks {
  assertCurrent(): Promise<void>;
  claimForSigning(): Promise<void>;
  persistSigned(hash: string): Promise<void>;
  markBroadcasting(): Promise<void>;
  markSubmitted(hash: string): Promise<void>;
}
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const HASH = /^0x[0-9a-f]{64}$/i;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const fail = (code: string): never => { throw new Error(`NATIVE_FUNDING_${code}`); };
const integer = (value: unknown): value is bigint => typeof value === 'bigint' && value >= 0n;
const encoded = (value: unknown) => JSON.stringify(value, (_key, entry: unknown) => typeof entry === 'bigint' ? entry.toString() : entry);

/** No network or custody is constructed here. The authoritative coordinator supplies approved ports. */
export class NativeFundingEngine {
  private readonly readers: readonly NativeFundingReader[];
  private readonly now: () => Date;
  public constructor(private readonly options: {
    readers: readonly { endpoint: string; client: NativeFundingReader }[];
    signer: NativeFundingSigner;
    /** Exactly one chain-approved broadcaster; no fallback or multi-provider raw-byte fanout. */
    broadcast(signed: Hex): Promise<string>;
    now?: () => Date;
  }) {
    if (options.readers.length !== 2 || options.readers[0]!.client === options.readers[1]!.client) fail('INDEPENDENT_READERS_REQUIRED');
    let hosts: string[];
    try { hosts = options.readers.map(({ endpoint }) => { const url = new URL(endpoint); if (url.protocol !== 'https:' || !url.hostname) fail('INDEPENDENT_READERS_REQUIRED'); return url.hostname.toLowerCase().replace(/\.$/, ''); }); }
    catch { fail('INDEPENDENT_READERS_REQUIRED'); }
    if (hosts![0] === hosts![1]) fail('INDEPENDENT_READERS_REQUIRED');
    this.readers = options.readers.map(reader => reader.client);
    this.now = options.now ?? (() => new Date());
  }

  public async prepare(request: NativeFundingEngineRequest, policy: NativeFundingEnginePolicy): Promise<NativeFundingEnginePreparation> {
    // Snapshot public inputs before the first await; provider callbacks cannot alter the intent.
    request = structuredClone(request); policy = structuredClone(policy);
    try {
      this.validate(request, policy);
      const heads = await Promise.all(this.readers.map(reader => reader.getBlockNumber()));
      if (heads.some(head => !integer(head) || head < 2n)) fail('OBSERVATION_STALE');
      const block = (heads[0]! < heads[1]! ? heads[0]! : heads[1]!) - 2n;
      const rows = await Promise.all(this.readers.map(async reader => {
        const [chain, header, hubBalanceWei, balances, recipientCode, nonce] = await Promise.all([
          reader.getChainId(), reader.getBlock(block), reader.getBalance(policy.hub as Address, block),
          Promise.all(policy.recipients.map(address => reader.getBalance(address as Address, block))),
          reader.getCode(request.recipient as Address, block), reader.getPendingNonce(policy.hub as Address),
        ]);
        const age = this.now().getTime() - Number(header.timestamp) * 1000;
        if (chain !== request.chainId || header.number !== block || !HASH.test(header.hash) || !Number.isFinite(age) || age < -30_000 || age > 300_000 || !integer(hubBalanceWei) || balances.some(value => !integer(value)) || recipientCode !== '0x' || !Number.isSafeInteger(nonce) || nonce < 0) fail('OBSERVATION_INVALID');
        const recipientBalanceWei = balances[policy.recipients.findIndex(address => same(address, request.recipient))]!;
        const value = request.requiredBalanceWei - recipientBalanceWei;
        if (value <= 0n) fail('ALREADY_FUNDED');
        if (value > policy.maxTransferWei) fail('TRANSFER_CAP');
        const intent = this.intent(request, policy, value, nonce);
        const [estimate, result, fees, currentCode, currentHub, currentBalances] = await Promise.all([
          reader.estimateGas(intent, block), reader.simulate(intent, block), reader.feeBounds(intent, block),
          reader.getCode(request.recipient as Address, 'pending'), reader.getBalance(policy.hub as Address, 'pending'),
          Promise.all(policy.recipients.map(address => reader.getBalance(address as Address, 'pending'))),
        ]);
        if (!integer(estimate) || estimate <= 0n || estimate > intent.gasLimit || result !== undefined && result !== '0x' || !integer(fees.l1DataFeeBoundWei) || !integer(fees.operatorFeeBoundWei) || currentCode !== '0x' || currentHub !== hubBalanceWei || encoded(currentBalances) !== encoded(balances)) fail('SIMULATION_INVALID');
        return { hub: policy.hub, recipientBalanceWei, fleetBalanceWei: balances.reduce((sum, value) => sum + value, 0n), hubBalanceWei, valueWei: value, gasLimit: policy.gasLimitMax, maxFeePerGas: policy.maxFeePerGas, maxPriorityFeePerGas: policy.maxPriorityFeePerGas, l1DataFeeBoundWei: fees.l1DataFeeBoundWei, operatorFeeBoundWei: fees.operatorFeeBoundWei, nonce, blockNumber: block, blockHash: header.hash.toLowerCase(), recipientCode: '0x' as const };
      }));
      if (encoded(rows[0]) !== encoded(rows[1])) fail('RPC_DISAGREEMENT');
      this.validate(request, policy);
      return { ...rows[0]!, observedAt: this.now().toISOString() };
    } catch (error) { throw this.safe(error); }
  }

  public async execute(record: NativeFundingEngineRecord, hooks: NativeFundingEngineHooks): Promise<{ hash: string }> {
    record = structuredClone(record);
    try {
      if (record.state !== 'reserved') fail('ALREADY_STARTED');
      await hooks.assertCurrent();
      const current = await this.prepare(record.request, record.policy);
      const identity = ({ observedAt: _at, blockNumber: _number, blockHash: _hash, ...rest }: NativeFundingEnginePreparation) => encoded(rest);
      if (identity(current) !== identity(record.preparation)) fail('PREPARATION_CHANGED');
      await hooks.assertCurrent();
      await hooks.claimForSigning();
      const intent = Object.freeze(this.intent(record.request, record.policy, record.preparation.valueWei, record.preparation.nonce));
      await hooks.assertCurrent();
      const signed = await this.options.signer.sign(intent, hooks.assertCurrent);
      await assertSignedMatchesIntent(signed, intent);
      const decoded = parseTransaction(signed);
      if (decoded.type !== 'eip1559' || (decoded.accessList?.length ?? 0) !== 0) fail('SIGNED_INTENT_INVALID');
      const hash = keccak256(signed);
      await hooks.persistSigned(hash);
      await hooks.assertCurrent();
      this.validate(record.request, record.policy);
      await hooks.markBroadcasting();
      await hooks.assertCurrent();
      const received = await this.options.broadcast(signed);
      if (!HASH.test(received) || !same(received, hash)) fail('BROADCAST_AMBIGUOUS');
      await hooks.markSubmitted(hash);
      return { hash };
    } catch (error) { throw this.safe(error); }
  }

  private intent(request: NativeFundingEngineRequest, policy: NativeFundingEnginePolicy, value: bigint, nonce: number): TransactionIntent {
    return { chainId: request.chainId, from: policy.hub as Address, to: request.recipient as Address, value, data: '0x', nonce, gasLimit: policy.gasLimitMax, maxFeePerGas: policy.maxFeePerGas, maxPriorityFeePerGas: policy.maxPriorityFeePerGas, accessList: [], campaignId: request.parentHoldId, runId: request.parentRunId, policyRef: policy.policyReference, evidenceRef: request.parentHoldDigest };
  }
  private validate(request: NativeFundingEngineRequest, policy: NativeFundingEnginePolicy): void {
    const now = this.now().getTime();
    if (policy.kind !== 'native-fleet-topup-v1' || policy.active !== true || ![1, 8453, 4663].includes(request.chainId) || policy.chainId !== request.chainId || !Number.isFinite(now) || !Number.isFinite(Date.parse(policy.expiresAt)) || Date.parse(policy.expiresAt) <= now || !Number.isFinite(Date.parse(request.expiresAt)) || Date.parse(request.expiresAt) <= now || !ADDRESS.test(policy.hub) || BigInt(policy.hub) === 0n || !ADDRESS.test(request.recipient) || same(policy.hub, request.recipient) || !same(this.options.signer.address, policy.hub) || !DIGEST.test(policy.recordDigest) || !DIGEST.test(policy.budgetProfileDigest) || !DIGEST.test(policy.walletSetDigest) || !policy.recipients.length || policy.recipients.length > 100 || policy.recipients.some(address => !ADDRESS.test(address) || BigInt(address) === 0n || same(address, policy.hub)) || new Set(policy.recipients.map(value => value.toLowerCase())).size !== policy.recipients.length || !policy.recipients.some(address => same(address, request.recipient)) || !integer(request.requiredBalanceWei) || request.requiredBalanceWei <= 0n || !integer(policy.maxTransferWei) || policy.maxTransferWei <= 0n || !integer(policy.gasLimitMax) || policy.gasLimitMax <= 0n || !integer(policy.maxFeePerGas) || policy.maxFeePerGas <= 0n || !integer(policy.maxPriorityFeePerGas) || policy.maxPriorityFeePerGas > policy.maxFeePerGas) fail('POLICY_REQUIRED');
  }
  private safe(error: unknown): Error {
    return new Error(error instanceof Error && /^NATIVE_FUNDING_[A-Z_]{1,70}$/.test(error.message) ? error.message : 'NATIVE_FUNDING_ENGINE_UNAVAILABLE');
  }
}
