import { readFile } from 'node:fs/promises';
import { createPublicClient, http, formatEther, formatGwei, type Address, type Hash } from 'viem';
import {
  MintEngine,
  BaseFinalityObserver,
  RobinhoodFinalityObserver,
  baseReceiptFees,
  readBaseOperatorFee,
  canonicalExecutionIdentity,
  resolveChainByNameFromSecrets,
  type EngineLifecycleStore,
  type MintJobConfig,
  type MintJobResult,
  type ReservationSettlementComponents,
  type RobinhoodEnablementGrant,
  type BaseEnablementGrant,
  type SignerFactory,
  type SpendReservationProvider,
  type WalletInfo,
} from '@mint-bot/engine';
import type {
  AttemptRecord,
  BackendStore,
  BackendState,
  Campaign,
  EngineAdapter,
  ExecutionResult,
  ReceiptRecord,
  ReconciliationUpdate,
  RunRecord,
} from '@mint-bot/backend';
import { BASE_PERSONAL_LIVE_FLEET_POLICY, PERSONAL_LIVE_FLEET_POLICY, validBaseEnablement, validRobinhoodEnablement } from '@mint-bot/backend';
import { promptHiddenPassphrase } from './secure-prompt.js';
import { createNitroFinalitySources } from './robinhood-readonly.js';
import { parseGasUsedForL1, reconcileRobinhood } from './robinhood-reconcile.js';

interface WalletFile {
  wallets?: Array<{ index?: number; address?: string }>;
}

export interface MintEngineAdapterOptions {
  readonly walletFile?: string;
  readonly walletList?: () => Promise<WalletInfo[]>;
  readonly signerFactory?: SignerFactory;
  readonly passphraseProvider?: () => Promise<string>;
  readonly policyRef?: string;
  readonly killSwitchFile: string;
  readonly secretRoot: string;
  readonly logFile: string;
  readonly maxFeePerGasGwei: number;
  readonly gasLimitPadding: number;
  readonly maxReplacementBumps: number;
  readonly getState: () => BackendState;
  readonly transact: <T>(mutate: (state: BackendState) => T) => Promise<T>;
  readonly lifecycleStore?: EngineLifecycleStore;
  readonly settleComponents?: (reservationId: string, components: ReservationSettlementComponents) => Promise<void>;
  /** Robinhood only (D-050): returns the owner's stored enablement record, or undefined. The only source of the engine's Robinhood grant. */
  readonly robinhoodEnablement?: () => unknown;
  readonly baseEnablement?: () => unknown;
}

type CanonicalLifecycleDelegate = BackendStore & {
  persistEngineRun(record: unknown): Promise<void>;
  persistEngineIntent(record: unknown): Promise<void>;
  persistEngineAttempt(record: unknown): Promise<void>;
  persistEngineReceipt(record: unknown): Promise<void>;
  persistEngineReconciliation(record: unknown): Promise<void>;
};

export function createCanonicalLifecycleStore(store: BackendStore): EngineLifecycleStore {
  const delegate = store as Partial<CanonicalLifecycleDelegate>;
  if (!delegate.persistEngineRun || !delegate.persistEngineIntent || !delegate.persistEngineAttempt || !delegate.persistEngineReceipt || !delegate.persistEngineReconciliation) throw new Error('CANONICAL_LIFECYCLE_STORE_REQUIRED');
  return {
    durable: true,
    storeKind: 'normalized-sqlite',
    persistRun: (record) => delegate.persistEngineRun!(record),
    persistIntent: (record) => delegate.persistEngineIntent!(record),
    persistAttempt: (record) => delegate.persistEngineAttempt!(record),
    persistReceipt: (record) => delegate.persistEngineReceipt!(record),
    persistReconciliation: (record) => delegate.persistEngineReconciliation!(record),
  };
}

export function chainName(chainId: Campaign['chainId']): MintJobConfig['target']['chain'] {
  if (chainId === 1) return 'ethereum';
  if (chainId === 8453) return 'base';
  if (chainId === 4663) return 'robinhood';
  throw new Error(`UNSUPPORTED_ENGINE_CHAIN:${chainId}`);
}

function asFiniteNumber(value: bigint, label: string): number {
  const number = Number(formatEther(value));
  if (!Number.isFinite(number)) throw new Error(`INVALID_${label.toUpperCase()}`);
  return number;
}

export function paidRunMintValueCapEth(campaign: Campaign): number {
  if (campaign.feePolicy.kind !== 'paid') return 0;
  const cap = asFiniteNumber(campaign.spendPolicy.maxRunWei, 'max_run_spend');
  if (cap <= 0) throw new Error('PAID_RUN_MINT_VALUE_CAP_REQUIRED');
  return cap;
}

export function baseReceiptFactsAgree(
  primary: { blockHash: string; blockNumber: bigint; status: string; gasUsed: bigint; effectiveGasPrice: bigint },
  fallback: { blockHash: string; blockNumber: bigint; status: string; gasUsed: bigint; effectiveGasPrice: bigint },
): boolean {
  return primary.blockHash.toLowerCase() === fallback.blockHash.toLowerCase()
    && primary.blockNumber === fallback.blockNumber
    && primary.status === fallback.status
    && primary.gasUsed === fallback.gasUsed
    && primary.effectiveGasPrice === fallback.effectiveGasPrice;
}

async function loadWallets(path: string): Promise<Array<{ index: number; address: Address }>> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as WalletFile;
  if (!Array.isArray(parsed.wallets) || parsed.wallets.length === 0) throw new Error('WALLET_FILE_EMPTY');
  return parsed.wallets.map((wallet, position) => {
    if (!Number.isSafeInteger(wallet.index) || !wallet.address || !/^0x[0-9a-fA-F]{40}$/.test(wallet.address)) throw new Error('WALLET_FILE_PUBLIC_SCHEMA_INVALID');
    return { index: wallet.index ?? position, address: wallet.address as Address };
  });
}

/**
 * The engine signs with the first N wallets of the key list, so the requested wallets must be exactly those N. The order
 * they arrive in does not matter (the database returns a run's wallets in no fixed order), only the set: the same set
 * of addresses, no repeats, no wallet outside the first N. Returns the wallet indexes in key-list order.
 */
export function selectKeyListPrefix(available: ReadonlyArray<{ index: number; address: string }>, addresses: readonly string[]): number[] {
  if (addresses.length === 0) throw new Error('EMPTY_EXECUTION_FLEET');
  const selected = available.slice(0, addresses.length);
  const requested = new Set(addresses.map((address) => address.toLowerCase()));
  // A key list that repeats an address in its first N cannot be matched exactly, so refuse it.
  if (new Set(selected.map((wallet) => wallet.address.toLowerCase())).size !== selected.length) throw new Error('WALLET_SELECTION_NOT_REPRESENTABLE');
  if (selected.length !== addresses.length || requested.size !== addresses.length || selected.some((wallet) => !requested.has(wallet.address.toLowerCase()))) {
    throw new Error('WALLET_SELECTION_NOT_REPRESENTABLE');
  }
  return selected.map((wallet) => wallet.index);
}

async function assertPrefixSelection(path: string, addresses: readonly string[]): Promise<number[]> {
  if (addresses.length === 0) throw new Error('EMPTY_EXECUTION_FLEET');
  return selectKeyListPrefix(await loadWallets(path), addresses);
}

async function assertWalletSelection(options: MintEngineAdapterOptions, addresses: readonly string[]): Promise<number[]> {
  if (options.walletList) {
    if (addresses.length === 0) throw new Error('EMPTY_EXECUTION_FLEET');
    return selectKeyListPrefix(await options.walletList(), addresses);
  }
  if (!options.walletFile) throw new Error('WALLET_SOURCE_REQUIRED');
  return assertPrefixSelection(options.walletFile, addresses);
}

/**
 * FREE-mint gas reserve caps for the engine, per chain (D-042, D-057). Ethereum and Base expose their approved
 * policies to the job summary. The Engine independently pins Base and refuses caller attempts to widen it.
 */
export function freeMintReserveCapsFor(chainId: number): { perWalletCapWei: bigint; activePeriodCapWei: bigint } | undefined {
  if (chainId === 1) return { perWalletCapWei: PERSONAL_LIVE_FLEET_POLICY.freeFeeAllowanceWei, activePeriodCapWei: PERSONAL_LIVE_FLEET_POLICY.freeDailyCapWei };
  if (chainId === 8453) return { perWalletCapWei: BASE_PERSONAL_LIVE_FLEET_POLICY.freeFeeAllowanceWei, activePeriodCapWei: BASE_PERSONAL_LIVE_FLEET_POLICY.freeDailyCapWei };
  return undefined;
}

/**
 * The ONE place an engine Robinhood grant is made (D-050): from the stored owner record, judged by the backend policy at this
 * moment, and reduced to the expiry and the paid flag. Frozen. No record, or an invalid or expired one, gives no grant.
 */
export function robinhoodGrantFrom(record: unknown, now: Date): RobinhoodEnablementGrant | undefined {
  const valid = validRobinhoodEnablement(record, now);
  return valid ? Object.freeze({ expiresAt: valid.expiresAt, paidAllowed: valid.paidAllowed }) : undefined;
}
export function baseGrantFrom(record: unknown, now: Date): BaseEnablementGrant | undefined {
  const valid = validBaseEnablement(record, now);
  return valid ? Object.freeze({ expiresAt: valid.expiresAt, freeAllowed: true as const, paidAllowed: false as const }) : undefined;
}

export function engineConfigFromCampaign(campaign: Campaign, options: MintEngineAdapterOptions, dryRun: boolean, maxWallets: number): MintJobConfig {
  const chain = chainName(campaign.chainId);
  const robinhoodGrant = campaign.chainId === 4663 ? robinhoodGrantFrom(options.robinhoodEnablement?.(), new Date()) : undefined;
  const baseGrant = campaign.chainId === 8453 ? baseGrantFrom(options.baseEnablement?.(), new Date()) : undefined;
  const reserveCaps = freeMintReserveCapsFor(campaign.chainId);
  const priorityFeeGwei = Number(formatGwei(campaign.feePolicy.configuredPriorityFeeWei));
  if (!Number.isFinite(priorityFeeGwei) || priorityFeeGwei < 0) throw new Error('INVALID_PRIORITY_FEE_POLICY');
  return {
    target: { chain, contract: campaign.contract as Address, strategy: campaign.strategy, quantity: campaign.quantity, campaignId: campaign.id, ...(options.policyRef ? { policyRef: options.policyRef } : {}) },
    fleet: { walletFile: options.walletFile ?? 'turnkey://wallet-map', maxWallets },
    timing: { mintStartUnix: 'auto', armBeforeMs: 30_000 },
    fees: { maxFeePerGasGwei: options.maxFeePerGasGwei, maxPriorityFeePerGasGwei: priorityFeeGwei, gasLimitPadding: options.gasLimitPadding },
    safety: {
      maxSpendEth: asFiniteNumber(campaign.spendPolicy.maxRunWei, 'max_run_spend'),
      dailySpendCapEth: asFiniteNumber(campaign.spendPolicy.dailyCapWei, 'daily_spend_cap'),
      maxReplacementBumps: options.maxReplacementBumps,
      dryRun,
      killSwitchFile: options.killSwitchFile,
      paidMaxQuantityPerWallet: 15,
      paidRunMintValueCapEth: paidRunMintValueCapEth(campaign),
      ...(reserveCaps ? { freeMintReserveCaps: reserveCaps } : {}),
      ...(robinhoodGrant ? { robinhoodGrant } : {}),
      ...(baseGrant ? { baseGrant } : {}),
    },
    broadcast: {
      // Dry runs must not require relay credentials. Live Ethereum still
      // defaults to the Flashbots-backed auto route through the campaign.
      // D-057 binds Base to one owner-approved primary RPC. The other Base
      // endpoint is observation-only and must never receive the signed tx.
      mode: campaign.chainId === 8453 ? 'public' : dryRun && campaign.chainId === 1 ? 'public' : campaign.broadcastMode ?? (campaign.chainId === 1 ? 'auto' : 'sequencer'),
      rpcEndpoints: [],
      blastParallel: false,
      secretScope: 'mainnet',
      secretRoot: options.secretRoot,
    },
    observability: { logLevel: 'info', logFile: options.logFile },
  };
}

function robinhoodFinality(stage: MintJobResult['walletResults'][number]['finalityStage']): 'soft' | 'posted' | 'final' | undefined {
  if (stage === 'soft' || stage === 'posted') return stage;
  if (stage === 'ethereum_final') return 'final';
  return undefined;
}

export function mapResult(result: MintJobResult, runId: string, campaign: Campaign): ExecutionResult {
  const now = new Date().toISOString();
  const executionIds: string[] = [];
  const attempts: AttemptRecord[] = [];
  const receipts: ReceiptRecord[] = [];
  let hasPending = false;
  let hasFailed = false;

  for (const wallet of result.walletResults) {
    const executionId = wallet.executionId;
    const transactionIntentId = wallet.transactionIntentId;
    if (!executionId || !transactionIntentId) {
      if (result.dryRun) continue;
      throw new Error('ENGINE_IDENTITY_REQUIRED');
    }
    const attemptIds = [...(wallet.attemptIds ?? [])];
    const submittedAttemptId = wallet.submittedAttemptId ?? attemptIds.at(-1);
    executionIds.push(executionId);
    const pending = wallet.status === 'timeout' || (wallet.txHash !== undefined && wallet.blockNumber === undefined);
    const failed = wallet.status === 'failed' || wallet.status === 'killed' || wallet.status === 'skipped';
    const state = result.dryRun ? 'Prepared' : pending ? 'Pending' : failed ? 'Failed' : 'Confirmed';
    if (pending) hasPending = true;
    if (failed && !pending) hasFailed = true;
    for (const attemptId of attemptIds) attempts.push({
      id: attemptId,
      executionId,
      runId,
      wallet: wallet.address,
      ...(wallet.nonce === undefined ? {} : { nonce: wallet.nonce }),
      ...(wallet.txHash === undefined ? {} : { hash: wallet.txHash }),
      state: attemptId === submittedAttemptId ? state : attemptId.endsWith(':signed') ? 'Signed' : 'Submitted',
      ...(campaign.chainId === 4663 && robinhoodFinality(wallet.finalityStage) ? { robinhoodFinality: robinhoodFinality(wallet.finalityStage) } : {}),
      createdAt: now,
      updatedAt: now,
    });
    if (wallet.txHash && wallet.blockNumber !== undefined && wallet.blockHash && wallet.totalCostWei !== undefined) {
      if (!submittedAttemptId && !result.dryRun) throw new Error('ENGINE_ATTEMPT_IDENTITY_REQUIRED');
      receipts.push({
        id: `${executionId}:receipt:${wallet.blockHash}`,
        executionId,
        runId,
        ...(submittedAttemptId ? { transactionAttemptId: submittedAttemptId } : {}),
        state: wallet.lifecycleState === 'reorged' ? 'Reorged' : campaign.chainId === 8453 && pending ? 'Pending' : failed ? 'Failed' : 'Confirmed',
        ...((campaign.chainId === 4663 || campaign.chainId === 8453) && (wallet.finalityStage === 'soft' || wallet.finalityStage === 'posted' || wallet.finalityStage === 'ethereum_final') ? { finalityStage: wallet.finalityStage } : {}),
        ...(campaign.chainId === 4663 && robinhoodFinality(wallet.finalityStage) ? { robinhoodFinality: robinhoodFinality(wallet.finalityStage) } : {}),
        blockNumber: wallet.blockNumber,
        blockHash: wallet.blockHash,
        ...(wallet.gasUsed === undefined ? {} : { gasUsed: wallet.gasUsed }),
        ...(wallet.effectiveGasPrice === undefined ? {} : { effectiveGasPrice: wallet.effectiveGasPrice }),
        ...(wallet.l1DataFeeWei === undefined ? {} : { l1DataFeeWei: wallet.l1DataFeeWei }),
        ...(wallet.operatorFeeWei === undefined ? {} : { operatorFeeWei: wallet.operatorFeeWei }),
        actualSpendWei: wallet.totalCostWei,
        observedAt: now,
      });
    }
  }

  return {
    executionIds,
    attempts,
    receipts,
    state: result.dryRun ? 'Prepared' : hasPending ? 'Pending' : hasFailed ? 'Failed' : 'Confirmed',
  };
}

/**
 * Lifecycle persistence records both the signed transaction and every provider
 * response. A signed and an accepted attempt can therefore describe the same
 * canonical transaction. Reconciliation observes that transaction once and
 * prefers the provider-facing attempt as the receipt linkage.
 */
export function uniqueSubmittedAttempts(attempts: readonly AttemptRecord[]): AttemptRecord[] {
  const unique = new Map<string, AttemptRecord>();
  for (const attempt of attempts) {
    const key = `${attempt.executionId}:${attempt.nonce ?? 'unknown'}:${attempt.hash?.toLowerCase() ?? attempt.id}`;
    const existing = unique.get(key);
    if (!existing || (existing.state === 'Signed' && attempt.state !== 'Signed')) unique.set(key, attempt);
  }
  return [...unique.values()];
}

/**
 * Pre-sign guard (T-010, D-019): the transaction the engine is about to sign must match what was
 * admitted. Its value must equal the admitted price × quantity, and value plus worst-case gas must fit
 * inside the durable reservation. A price change or fee rise after admission refuses signing
 * instead of being discovered at settlement after broadcast.
 */
export function assertWithinAdmittedExposure(input: { valueWei: bigint; maxGasCostWei: bigint; l1DataGasWei: bigint }, campaign: Pick<Campaign, 'mintPriceWei' | 'quantity'>, reservation: { amountWei: bigint }): void {
  const admittedValueWei = campaign.mintPriceWei * BigInt(campaign.quantity);
  if (input.valueWei !== admittedValueWei) throw new Error('MINT_VALUE_CHANGED_SINCE_ADMISSION');
  if (input.maxGasCostWei < 0n || input.l1DataGasWei < 0n) throw new Error('EXPOSURE_EXCEEDS_RESERVATION');
  if (input.valueWei + input.maxGasCostWei + input.l1DataGasWei > reservation.amountWei) throw new Error('EXPOSURE_EXCEEDS_RESERVATION');
}

/**
 * The complete pre-sign gate, run by the adapter's reserve step before the engine may sign (T-010):
 * kill switch, durable reservation present and `reserved`, canonical identity, then admitted value and
 * exposure. Returns the reservation to settle against; any failure throws and nothing is signed.
 */
export function preSignReservationGate<R extends { status: string; amountWei: bigint }>(args: {
  killed: boolean;
  byWallet: ReadonlyMap<string, R>;
  runId: string;
  intentId: string;
  campaign: Pick<Campaign, 'id' | 'mintPriceWei' | 'quantity'>;
  input: { address: string; walletIndex: number; runId: string; campaignId: string; executionId: string; transactionIntentId: string; valueWei: bigint; maxGasCostWei: bigint; l1DataGasWei: bigint };
}): R {
  const { killed, byWallet, runId, intentId, campaign, input } = args;
  if (killed) throw new Error('KILLED');
  const reservation = byWallet.get(input.address.toLowerCase());
  if (!reservation || reservation.status !== 'reserved') throw new Error('DURABLE_RESERVATION_REQUIRED');
  const expectedIdentity = canonicalExecutionIdentity(runId, intentId, input.walletIndex, input.address as Address);
  if (input.runId !== runId || input.campaignId !== campaign.id || input.executionId !== expectedIdentity.executionId || input.transactionIntentId !== expectedIdentity.transactionIntentId) throw new Error('CANONICAL_IDENTITY_REQUIRED');
  assertWithinAdmittedExposure(input, campaign, reservation);
  return reservation;
}

export function createMintEngineAdapter(options: MintEngineAdapterOptions): EngineAdapter {
  const run = async (campaign: Campaign, wallets: readonly string[], dryRun: boolean, runId: string, intentId?: string, reservationProvider?: SpendReservationProvider): Promise<ExecutionResult> => {
    await assertWalletSelection(options, wallets);
    const config = engineConfigFromCampaign(campaign, options, dryRun, wallets.length);
    const persistedRun = options.getState().runs.find((run) => run.id === runId);
    const engineOptions = {
      ...(reservationProvider ? { reservationProvider } : {}),
      ...(options.lifecycleStore ? { lifecycleStore: options.lifecycleStore } : {}),
      ...(options.signerFactory ? { signerFactory: options.signerFactory } : {}),
      runId,
      ...(intentId ? { intentId } : {}),
      requestId: persistedRun?.idempotencyKey ?? runId,
      requestFingerprint: persistedRun?.requestDigest ?? `${campaign.id}:${campaign.chainId}:${campaign.contract.toLowerCase()}:${campaign.quantity}`,
      identityForWallet: (wallet: { index: number; address: Address }, identityRunId: string) => canonicalExecutionIdentity(identityRunId, intentId, wallet.index, wallet.address),
    };
    const passphrase = options.passphraseProvider ? await options.passphraseProvider() : await promptHiddenPassphrase();
    const result = await new MintEngine(config, engineOptions).execute(passphrase);
    return mapResult(result, runId, campaign);
  };

  return {
    prepare: ({ runId, campaign, wallets }) => run(campaign, wallets, true, runId, options.getState().runs.find((run) => run.id === runId)?.intentId),
    execute: async ({ runId, intentId, campaign, reservationIds }) => {
      const state = options.getState();
      const intent = state.intents.find((candidate) => candidate.id === intentId);
      if (!intent) throw new Error('INTENT_NOT_FOUND');
      const reservations = state.reservations.filter((reservation) => reservation.runId === runId && reservationIds.includes(reservation.id));
      if (reservationIds.length === 0 || reservations.length !== reservationIds.length || reservationIds.some((id) => !reservations.some((reservation) => reservation.id === id))) throw new Error('DURABLE_RESERVATION_REQUIRED');
      const provider: SpendReservationProvider = {
        durable: true,
        storeKind: 'normalized-sqlite',
        reserve: async (input) => {
          // T-021: read the reservations again now, not the copy taken when execute started, so a release or
          // settlement that happened in between is seen before anything is signed.
          const current = options.getState();
          const freshByWallet = new Map(current.reservations.filter((candidate) => candidate.runId === runId && reservationIds.includes(candidate.id)).map((candidate) => [candidate.wallet.toLowerCase(), candidate]));
          const reservation = preSignReservationGate({ killed: current.killed, byWallet: freshByWallet, runId, intentId, campaign, input });
          const settleTotal = async (components: ReservationSettlementComponents): Promise<void> => {
            if (options.settleComponents) {
              await options.settleComponents(reservation.id, components);
              return;
            }
            await options.transact((current) => {
              const currentReservation = current.reservations.find((candidate) => candidate.id === reservation.id);
              if (!currentReservation || currentReservation.status === 'released') throw new Error('INVALID_RESERVATION_TRANSITION');
              if (currentReservation.status === 'settled') return;
              const actualAmountWei = components.actualMintValueWei + components.actualL2ExecutionGasWei + components.actualL1DataGasWei + (components.actualPriorityFeeComponentWei ?? 0n) + (components.actualReplacementBudgetWei ?? 0n);
              if (actualAmountWei < 0n || actualAmountWei > currentReservation.amountWei) throw new Error('INVALID_SETTLEMENT_AMOUNT');
              currentReservation.status = 'settled';
              currentReservation.actualAmountWei = actualAmountWei;
              currentReservation.updatedAt = new Date().toISOString();
            });
          };
          return {
            durable: true,
            storeKind: 'normalized-sqlite',
            reservationId: reservation.id,
            walletIndex: input.walletIndex,
            maxValueWei: reservation.amountWei,
            maxGasCostWei: reservation.amountWei,
            settle: async (actualValueWei, actualGasCostWei) => settleTotal({ actualMintValueWei: actualValueWei, actualL2ExecutionGasWei: actualGasCostWei, actualL1DataGasWei: 0n, actualPriorityFeeComponentWei: 0n, actualReplacementBudgetWei: 0n }),
            settleComponents: settleTotal,
            release: async () => options.transact((current) => {
              const currentReservation = current.reservations.find((candidate) => candidate.id === reservation.id);
              if (!currentReservation || currentReservation.status !== 'reserved') return;
              currentReservation.status = 'released';
              currentReservation.updatedAt = new Date().toISOString();
            }),
          };
        },
      };
      return run(campaign, intent.wallets, false, runId, intentId, provider);
    },
    reconcile: async (run: RunRecord): Promise<ReconciliationUpdate> => {
      const state = options.getState();
      const intent = state.intents.find((candidate) => candidate.id === run.intentId);
      const attempts = state.attempts.filter((attempt) => attempt.runId === run.id);
      if (!intent || attempts.length === 0) return { result: 'unknown', attempts: [], receipts: [], reason: 'no persisted transaction attempts' };
      const config = await resolveChainByNameFromSecrets(chainName(intent.campaignSnapshot.chainId), 'mainnet', options.secretRoot);
      const endpoint = config.rpcEndpoints[0];
      if (!endpoint) return { result: 'unknown', attempts: [], receipts: [], reason: 'chain endpoint unavailable' };
      const client = createPublicClient({ transport: http(endpoint) });
      if (intent.campaignSnapshot.chainId === 8453) {
        const fallbackEndpoint = config.rpcEndpoints[1];
        if (!fallbackEndpoint) return { result: 'unknown', attempts: [], receipts: [], reason: 'independent Base fallback endpoint unavailable' };
        const fallback = createPublicClient({ transport: http(fallbackEndpoint) });
        const observerFor = (source: typeof client) => new BaseFinalityObserver({
          chainId: 8453,
          currentBlockNumber: () => source.getBlockNumber(),
          receiptBlockHash: async (hash) => (await source.getTransactionReceipt({ hash })).blockHash,
          canonicalBlockHash: async (blockNumber) => (await source.getBlock({ blockNumber })).hash,
          safeBlockNumber: async () => (await source.getBlock({ blockTag: 'safe' })).number,
          finalizedBlockNumber: async () => (await source.getBlock({ blockTag: 'finalized' })).number,
        });
        const primaryObserver = observerFor(client);
        const fallbackObserver = observerFor(fallback);
        const updatedAttempts: AttemptRecord[] = [];
        const receipts: ReceiptRecord[] = [];
        let weakest: 'soft' | 'posted' | 'final' = 'final';
        for (const attempt of uniqueSubmittedAttempts(attempts)) {
          if (!attempt.hash || attempt.nonce === undefined) continue;
          try {
            const hash = attempt.hash as Hash;
            const [primaryReceipt, fallbackReceipt] = await Promise.all([client.getTransactionReceipt({ hash }), fallback.getTransactionReceipt({ hash })]);
            if (!baseReceiptFactsAgree(primaryReceipt, fallbackReceipt)) return { result: 'unknown', attempts: [], receipts: [], reason: 'Base providers disagree on receipt facts' };
            const [primaryFinality, fallbackFinality] = await Promise.all([
              primaryObserver.observe({ txHash: hash, txBlockNumber: primaryReceipt.blockNumber }),
              fallbackObserver.observe({ txHash: hash, txBlockNumber: fallbackReceipt.blockNumber }),
            ]);
            if (primaryFinality.stage !== fallbackFinality.stage || primaryFinality.canonical !== fallbackFinality.canonical) return { result: 'unknown', attempts: [], receipts: [], reason: 'Base providers disagree on finality' };
            if (primaryFinality.canonical !== true) return { result: primaryFinality.canonical === false ? 'reorged' : 'unknown', attempts: [], receipts: [], reason: primaryFinality.reason };
            const fields = primaryReceipt as typeof primaryReceipt & { l1Fee?: bigint | string; l1DataFee?: bigint | string; operatorFee?: bigint | string; operatorFeeScalar?: bigint | number; operatorFeeConstant?: bigint };
            const fallbackFields = fallbackReceipt as typeof fallbackReceipt & { l1Fee?: bigint | string; l1DataFee?: bigint | string; operatorFee?: bigint | string };
            const [primaryOracleOperatorFee, fallbackOracleOperatorFee] = await Promise.all([
              fields.operatorFee === undefined ? readBaseOperatorFee(client, primaryReceipt.gasUsed, primaryReceipt.blockNumber) : undefined,
              fallbackFields.operatorFee === undefined ? readBaseOperatorFee(fallback, fallbackReceipt.gasUsed, fallbackReceipt.blockNumber) : undefined,
            ]);
            const fees = baseReceiptFees(fields, primaryReceipt.gasUsed, primaryOracleOperatorFee);
            const fallbackFees = baseReceiptFees(fallbackFields, fallbackReceipt.gasUsed, fallbackOracleOperatorFee);
            if (fees.operatorFeeWei !== fallbackFees.operatorFeeWei || fees.l1DataFeeWei !== fallbackFees.l1DataFeeWei) return { result: 'unknown', attempts: [], receipts: [], reason: 'Base providers disagree on fee components' };
            const stage = primaryFinality.stage;
            if (stage !== 'soft' && stage !== 'posted' && stage !== 'ethereum_final') return { result: 'unknown', attempts: [], receipts: [], reason: 'Base observer returned an invalid finality stage' };
            weakest = stage === 'soft' ? 'soft' : stage === 'posted' && weakest === 'final' ? 'posted' : weakest;
            const finalized = stage === 'ethereum_final';
            updatedAttempts.push({ ...attempt, state: finalized ? (primaryReceipt.status === 'success' ? 'Confirmed' : 'Failed') : 'Submitted', updatedAt: new Date().toISOString() });
            receipts.push({ id: `${attempt.executionId}:base:${primaryReceipt.blockHash}:${stage}`, executionId: attempt.executionId, runId: run.id, transactionAttemptId: attempt.id, state: finalized ? (primaryReceipt.status === 'success' ? 'Confirmed' : 'Failed') : 'Pending', finalityStage: stage, finalitySource: 'base-independent-safe-finalized-heads', blockNumber: primaryReceipt.blockNumber, blockHash: primaryReceipt.blockHash, gasUsed: primaryReceipt.gasUsed, effectiveGasPrice: primaryReceipt.effectiveGasPrice, l1DataFeeWei: fees.l1DataFeeWei, operatorFeeWei: fees.operatorFeeWei, actualSpendWei: (primaryReceipt.status === 'success' ? intent.campaignSnapshot.mintPriceWei * BigInt(intent.campaignSnapshot.quantity) : 0n) + primaryReceipt.gasUsed * primaryReceipt.effectiveGasPrice + fees.l1DataFeeWei + fees.operatorFeeWei, observedAt: new Date().toISOString() });
          } catch (error) {
            if (error instanceof Error && (error.message.startsWith('BASE_RECEIPT_') || error.message.startsWith('BASE_OPERATOR_'))) return { result: 'unknown', attempts: [], receipts: [], reason: error.message };
          }
        }
        if (receipts.length === 0) return { result: 'unknown', attempts: updatedAttempts, receipts, reason: 'Base receipt unavailable; outcome unresolved' };
        if (receipts.some((receipt) => receipt.state === 'Failed' && receipt.finalityStage === 'ethereum_final')) return { result: 'failed', attempts: updatedAttempts, receipts };
        return { result: weakest, attempts: updatedAttempts, receipts };
      }
      if (intent.campaignSnapshot.chainId === 4663) {
        // Robinhood: final only when canonical and Ethereum-final; the settled amount is the observed cost (T-035 piece 2).
        const observer = new RobinhoodFinalityObserver(createNitroFinalitySources(client), 1);
        return reconcileRobinhood({
          run,
          attempts,
          mintPriceWei: intent.campaignSnapshot.mintPriceWei,
          quantity: intent.campaignSnapshot.quantity,
          readReceipt: async (hash) => {
            const receipt = await client.getTransactionReceipt({ hash: hash as Hash });
            return { status: receipt.status === 'success' ? 'success' : 'reverted', blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice, gasUsedForL1: parseGasUsedForL1((receipt as unknown as { gasUsedForL1?: unknown }).gasUsedForL1) };
          },
          observe: async (observed) => {
            const observation = await observer.observe({ txHash: observed.txHash as Hash, txBlockNumber: observed.txBlockNumber });
            return { stage: observation.stage === 'ethereum_final' || observation.stage === 'posted' ? observation.stage : 'soft', canonical: observation.canonical, ready: observation.ready };
          },
        });
      }
      const updatedAttempts: AttemptRecord[] = [];
      const receipts: ReceiptRecord[] = [];
      const receiptExecutions = new Set<string>();
      for (const attempt of attempts) {
        if (!attempt.hash || attempt.nonce === undefined) continue;
        try {
          const receipt = await client.getTransactionReceipt({ hash: attempt.hash as Hash });
          updatedAttempts.push({ ...attempt, state: receipt.status === 'success' ? 'Confirmed' : 'Failed', updatedAt: new Date().toISOString() });
          if (receiptExecutions.has(attempt.executionId)) continue;
          receiptExecutions.add(attempt.executionId);
          const existingReceipt = state.receipts.find((candidate) => candidate.executionId === attempt.executionId && candidate.blockHash === receipt.blockHash);
          receipts.push(existingReceipt ?? { id: `${attempt.executionId}:reconciled:${receipt.blockHash}`, executionId: attempt.executionId, runId: run.id, transactionAttemptId: attempt.id, state: receipt.status === 'success' ? 'Confirmed' : 'Failed', blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, actualSpendWei: (receipt.status === 'success' ? intent.campaignSnapshot.mintPriceWei * BigInt(intent.campaignSnapshot.quantity) : 0n) + receipt.gasUsed * receipt.effectiveGasPrice, observedAt: new Date().toISOString() });
        } catch {
          // Missing receipts remain unresolved; do not invent a failure.
        }
      }
      if (receipts.length === 0) return { result: 'unknown', attempts: updatedAttempts, receipts, reason: 'receipt unavailable; outcome unresolved' };
      return { result: receipts.every((receipt) => receipt.state === 'Confirmed') ? 'confirmed' : 'failed', attempts: updatedAttempts, receipts };
    },
  };
}
