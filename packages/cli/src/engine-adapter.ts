import { readFile } from 'node:fs/promises';
import { createPublicClient, http, formatEther, formatGwei, type Address, type Hash } from 'viem';
import {
  MintEngine,
  resolveChainByNameFromSecrets,
  type MintJobConfig,
  type MintJobResult,
  type SpendReservationProvider,
} from '@mint-bot/engine';
import type {
  AttemptRecord,
  BackendState,
  Campaign,
  EngineAdapter,
  ExecutionResult,
  ReceiptRecord,
  ReconciliationUpdate,
  RunRecord,
} from '@mint-bot/backend';
import { promptHiddenPassphrase } from './secure-prompt.js';

interface WalletFile {
  wallets?: Array<{ index?: number; address?: string }>;
}

export interface MintEngineAdapterOptions {
  readonly walletFile: string;
  readonly killSwitchFile: string;
  readonly secretRoot: string;
  readonly logFile: string;
  readonly maxFeePerGasGwei: number;
  readonly gasLimitPadding: number;
  readonly maxReplacementBumps: number;
  readonly getState: () => BackendState;
  readonly transact: <T>(mutate: (state: BackendState) => T) => Promise<T>;
}

function chainName(chainId: Campaign['chainId']): MintJobConfig['target']['chain'] {
  if (chainId === 1) return 'ethereum';
  if (chainId === 4663) return 'robinhood';
  throw new Error(`UNSUPPORTED_ENGINE_CHAIN:${chainId}`);
}

function asFiniteNumber(value: bigint, label: string): number {
  const number = Number(formatEther(value));
  if (!Number.isFinite(number)) throw new Error(`INVALID_${label.toUpperCase()}`);
  return number;
}

async function loadWallets(path: string): Promise<Array<{ index: number; address: Address }>> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as WalletFile;
  if (!Array.isArray(parsed.wallets) || parsed.wallets.length === 0) throw new Error('WALLET_FILE_EMPTY');
  return parsed.wallets.map((wallet, position) => {
    if (!Number.isSafeInteger(wallet.index) || !wallet.address || !/^0x[0-9a-fA-F]{40}$/.test(wallet.address)) throw new Error('WALLET_FILE_PUBLIC_SCHEMA_INVALID');
    return { index: wallet.index ?? position, address: wallet.address as Address };
  });
}

async function assertPrefixSelection(path: string, addresses: readonly string[]): Promise<number[]> {
  if (addresses.length === 0) throw new Error('EMPTY_EXECUTION_FLEET');
  const available = await loadWallets(path);
  const selected = available.slice(0, addresses.length);
  if (selected.length !== addresses.length || selected.some((wallet, index) => wallet.address.toLowerCase() !== addresses[index]!.toLowerCase())) {
    throw new Error('WALLET_SELECTION_NOT_REPRESENTABLE');
  }
  return selected.map((wallet) => wallet.index);
}

function makeConfig(campaign: Campaign, options: MintEngineAdapterOptions, dryRun: boolean, maxWallets: number): MintJobConfig {
  const chain = chainName(campaign.chainId);
  const priorityFeeGwei = Number(formatGwei(campaign.feePolicy.configuredPriorityFeeWei));
  if (!Number.isFinite(priorityFeeGwei) || priorityFeeGwei < 0) throw new Error('INVALID_PRIORITY_FEE_POLICY');
  return {
    target: { chain, contract: campaign.contract as Address, strategy: campaign.strategy, quantity: campaign.quantity },
    fleet: { walletFile: options.walletFile, maxWallets },
    timing: { mintStartUnix: 'auto', armBeforeMs: 30_000 },
    fees: { maxFeePerGasGwei: options.maxFeePerGasGwei, maxPriorityFeePerGasGwei: priorityFeeGwei, gasLimitPadding: options.gasLimitPadding },
    safety: {
      maxSpendEth: asFiniteNumber(campaign.spendPolicy.maxRunWei, 'max_run_spend'),
      dailySpendCapEth: asFiniteNumber(campaign.spendPolicy.dailyCapWei, 'daily_spend_cap'),
      maxReplacementBumps: options.maxReplacementBumps,
      dryRun,
      killSwitchFile: options.killSwitchFile,
      paidMaxQuantityPerWallet: 15,
      paidRunMintValueCapEth: 0,
    },
    broadcast: {
      // Dry runs must not require relay credentials. Live Ethereum still
      // defaults to the Flashbots-backed auto route through the campaign.
      mode: dryRun && campaign.chainId === 1 ? 'public' : campaign.broadcastMode ?? (campaign.chainId === 1 ? 'auto' : 'sequencer'),
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

function mapResult(result: MintJobResult, runId: string, campaign: Campaign): ExecutionResult {
  const now = new Date().toISOString();
  const executionIds: string[] = [];
  const attempts: AttemptRecord[] = [];
  const receipts: ReceiptRecord[] = [];
  let hasPending = false;
  let hasFailed = false;

  for (const wallet of result.walletResults) {
    const executionId = `${runId}:wallet:${wallet.walletIndex}`;
    const attemptId = `${executionId}:attempt`;
    executionIds.push(executionId);
    const pending = wallet.status === 'timeout' || (wallet.txHash !== undefined && wallet.blockNumber === undefined);
    const failed = wallet.status === 'failed' || wallet.status === 'killed' || wallet.status === 'skipped';
    const state = result.dryRun ? 'Prepared' : pending ? 'Pending' : failed ? 'Failed' : 'Confirmed';
    if (pending) hasPending = true;
    if (failed && !pending) hasFailed = true;
    attempts.push({
      id: attemptId,
      executionId,
      runId,
      wallet: wallet.address,
      ...(wallet.nonce === undefined ? {} : { nonce: wallet.nonce }),
      ...(wallet.txHash === undefined ? {} : { hash: wallet.txHash }),
      state,
      ...(campaign.chainId === 4663 && robinhoodFinality(wallet.finalityStage) ? { robinhoodFinality: robinhoodFinality(wallet.finalityStage) } : {}),
      createdAt: now,
      updatedAt: now,
    });
    if (wallet.txHash && wallet.blockNumber !== undefined && wallet.blockHash && wallet.totalCostWei !== undefined) {
      receipts.push({
        id: `${executionId}:receipt`,
        executionId,
        runId,
        state: wallet.status === 'success' ? 'Confirmed' : 'Failed',
        ...(campaign.chainId === 4663 && robinhoodFinality(wallet.finalityStage) ? { robinhoodFinality: robinhoodFinality(wallet.finalityStage) } : {}),
        blockNumber: wallet.blockNumber,
        blockHash: wallet.blockHash,
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

export function createMintEngineAdapter(options: MintEngineAdapterOptions): EngineAdapter {
  const run = async (campaign: Campaign, wallets: readonly string[], dryRun: boolean, runId: string, reservationProvider?: SpendReservationProvider): Promise<ExecutionResult> => {
    await assertPrefixSelection(options.walletFile, wallets);
    const config = makeConfig(campaign, options, dryRun, wallets.length);
    const result = await new MintEngine(config, reservationProvider ? { reservationProvider } : undefined).execute(await promptHiddenPassphrase());
    return mapResult(result, runId, campaign);
  };

  return {
    prepare: ({ runId, campaign, wallets }) => run(campaign, wallets, true, runId),
    execute: async ({ runId, intentId, campaign, reservationIds }) => {
      const state = options.getState();
      const intent = state.intents.find((candidate) => candidate.id === intentId);
      if (!intent) throw new Error('INTENT_NOT_FOUND');
      const reservations = state.reservations.filter((reservation) => reservation.runId === runId && reservationIds.includes(reservation.id));
      if (reservationIds.length === 0 || reservations.length !== reservationIds.length || reservationIds.some((id) => !reservations.some((reservation) => reservation.id === id))) throw new Error('DURABLE_RESERVATION_REQUIRED');
      const byWallet = new Map(reservations.map((reservation) => [reservation.wallet.toLowerCase(), reservation]));
      const provider: SpendReservationProvider = {
        reserve: async (input) => {
          if (options.getState().killed) throw new Error('KILLED');
          const reservation = byWallet.get(input.address.toLowerCase());
          if (!reservation || reservation.status !== 'reserved') throw new Error('DURABLE_RESERVATION_REQUIRED');
          return {
            reservationId: reservation.id,
            walletIndex: input.walletIndex,
            maxValueWei: reservation.amountWei,
            maxGasCostWei: reservation.amountWei,
            settle: async (actualValueWei, actualGasCostWei) => options.transact((current) => {
              const currentReservation = current.reservations.find((candidate) => candidate.id === reservation.id);
              if (!currentReservation || currentReservation.status !== 'reserved') throw new Error('INVALID_RESERVATION_TRANSITION');
              const actualAmountWei = actualValueWei + actualGasCostWei;
              if (actualAmountWei < 0n || actualAmountWei > currentReservation.amountWei) throw new Error('INVALID_SETTLEMENT_AMOUNT');
              currentReservation.status = 'settled';
              currentReservation.actualAmountWei = actualAmountWei;
              currentReservation.updatedAt = new Date().toISOString();
            }),
            release: async () => options.transact((current) => {
              const currentReservation = current.reservations.find((candidate) => candidate.id === reservation.id);
              if (!currentReservation || currentReservation.status !== 'reserved') return;
              currentReservation.status = 'released';
              currentReservation.updatedAt = new Date().toISOString();
            }),
          };
        },
      };
      return run(campaign, intent.wallets, false, runId, provider);
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
      const updatedAttempts: AttemptRecord[] = [];
      const receipts: ReceiptRecord[] = [];
      for (const attempt of attempts) {
        if (!attempt.hash || attempt.nonce === undefined) continue;
        try {
          const receipt = await client.getTransactionReceipt({ hash: attempt.hash as Hash });
          updatedAttempts.push({ ...attempt, state: receipt.status === 'success' ? 'Confirmed' : 'Failed', updatedAt: new Date().toISOString() });
          receipts.push({ id: `${attempt.executionId}:reconciled:${receipt.blockHash}`, executionId: attempt.executionId, runId: run.id, state: receipt.status === 'success' ? 'Confirmed' : 'Failed', blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, actualSpendWei: intent.campaignSnapshot.mintPriceWei * BigInt(intent.campaignSnapshot.quantity) + receipt.gasUsed * receipt.effectiveGasPrice, observedAt: new Date().toISOString() });
        } catch {
          // Missing receipts remain unresolved; do not invent a failure.
        }
      }
      if (receipts.length === 0) return { result: 'unknown', attempts: updatedAttempts, receipts, reason: 'receipt unavailable; outcome unresolved' };
      return { result: receipts.every((receipt) => receipt.state === 'Confirmed') ? 'confirmed' : 'failed', attempts: updatedAttempts, receipts };
    },
  };
}
