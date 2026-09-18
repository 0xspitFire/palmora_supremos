import { describe, expect, it } from 'vitest';
import type { Address, Hash, Hex, PublicClient } from 'viem';
import {
  ChainFactsReader,
  appendReceiptObservation,
  classifyFreshness,
  detectReorg,
  type ChainFact,
  type ChainReceiptFact,
} from './chain-facts.js';
import type { DropConfig, MintStrategy } from './types.js';

const NOW = new Date('2026-09-17T00:00:00.000Z');
const ADDRESS = '0x1111111111111111111111111111111111111111' as Address;
const CONTRACT = '0x2222222222222222222222222222222222222222' as Address;
const TX_HASH = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Hash;
const RECEIPT_BLOCK_HASH = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Hash;
const REORG_BLOCK_HASH = '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' as Hash;

function baseDrop(overrides: Partial<DropConfig> = {}): DropConfig {
  return {
    nftContract: CONTRACT,
    mintPrice: 0n,
    maxTotalMintableByWallet: 1,
    maxTokenSupply: 0n,
    totalMinted: 0n,
    startTime: Math.floor(NOW.getTime() / 1000) - 60,
    endTime: Math.floor(NOW.getTime() / 1000) + 3_600,
    feePayer: ADDRESS,
    strategyName: 'fixture-strategy',
    chainId: 1,
    extra: { totalSupplyKnown: false, maxSupplyKnown: false },
    ...overrides,
  };
}

function clientFixture(overrides: Record<string, unknown> = {}): PublicClient {
  return {
    getBlockNumber: async () => 10n,
    getBlock: async () => ({ hash: RECEIPT_BLOCK_HASH, timestamp: 1_758_067_140n }),
    getBalance: async () => 100n,
    getTransactionCount: async () => 4,
    getCode: async () => '0x' as Hex,
    getTransactionReceipt: async () => ({
      transactionHash: TX_HASH,
      blockNumber: 10n,
      blockHash: RECEIPT_BLOCK_HASH,
      status: 'success' as const,
      gasUsed: 21_000n,
      effectiveGasPrice: 2n,
    }),
    getLogs: async () => [{
      address: CONTRACT,
      topics: ['0x01' as Hex],
      data: '0x' as Hex,
      blockNumber: 10n,
      blockHash: RECEIPT_BLOCK_HASH,
      transactionHash: TX_HASH,
      logIndex: 0,
      removed: false,
    }],
    ...overrides,
  } as unknown as PublicClient;
}

const strategy: MintStrategy = {
  name: 'fixture-strategy',
  readDrop: async () => baseDrop(),
  buildCalldata: () => '0x' as Hex,
  estimateGas: async () => 21_000n,
  validateDrop: () => ({ valid: true, errors: [], warnings: [] }),
};

function reader(client: PublicClient, chainId: 1 | 4663 = 1): ChainFactsReader {
  return new ChainFactsReader(client, {
    chainId,
    sourceRef: 'fixture-rpc',
    now: () => NOW,
    freshness: { version: 'fixture-v1', headMs: 1_000, logsMs: 1_000, dropMs: 1_000, walletMs: 1_000, receiptMs: 1_000, finalityMs: 1_000, reorgMs: 1_000 },
  });
}

describe('chain fact freshness and provenance', () => {
  it('distinguishes fresh, stale, and unknown timestamps deterministically', () => {
    expect(classifyFreshness('2026-09-17T00:00:00.000Z', '2026-09-17T00:00:10.000Z', NOW, 'fixture-v1')).toEqual({
      status: 'fresh',
      observedAt: '2026-09-17T00:00:00.000Z',
      expiresAt: '2026-09-17T00:00:10.000Z',
      ageSeconds: '0',
      policyVersion: 'fixture-v1',
    });
    expect(classifyFreshness('2026-09-16T23:59:00.000Z', '2026-09-17T00:00:00.000Z', NOW).status).toBe('stale');
    expect(classifyFreshness('not-a-date', '2026-09-17T00:00:10.000Z', NOW).status).toBe('unknown');
    expect(classifyFreshness('2026-09-17T00:00:01.000Z', '2026-09-17T00:00:10.000Z', NOW).status).toBe('unknown');
  });

  it('keeps missing supply explicit instead of treating zero as sold out or known', async () => {
    const fact = await reader(clientFixture()).readDrop(CONTRACT, strategy);
    expect(fact.value?.supply).toEqual({ totalMinted: null, maxSupply: null, totalMintedKnown: false, maxSupplyKnown: false, status: 'unknown' });
    expect(fact.freshness.status).toBe('fresh');
    expect(fact.provenance[0]).toMatchObject({ kind: 'strategy', sourceRef: 'fixture-rpc', sourceBlockNumber: 10n, sourceBlockHash: RECEIPT_BLOCK_HASH });
  });

  it('returns a partial wallet fact when one read is unavailable', async () => {
    const fact = await reader(clientFixture({ getBalance: async () => { throw new Error('rpc'); } })).readWallet(ADDRESS);
    expect(fact.availability).toBe('partial');
    expect(fact.value).toMatchObject({ address: ADDRESS, balanceWei: null, nonce: 4, codeKnown: true, isContract: false });
    expect(fact.errorCode).toBeUndefined();
  });
});

describe('read-only receipt, staged finality, and reorg facts', () => {
  it('retains Robinhood soft, posted, and Ethereum-final observations', async () => {
    let stage: 'soft' | 'posted' | 'ethereum_final' = 'soft';
    const current = reader(clientFixture(), 4663);
    const observed = new ChainFactsReader(clientFixture(), {
      chainId: 4663,
      sourceRef: 'fixture-rpc',
      now: () => NOW,
      finalityObserver: { observe: async () => ({ chainId: 4663, stage, canonical: true, ready: stage === 'ethereum_final', observedAt: NOW }) },
    });
    expect((await observed.readReceipt(TX_HASH)).value?.finality).toMatchObject({ stage: 'soft', requiredStage: 'ethereum_final', settlementReached: false });
    stage = 'posted';
    expect((await observed.readReceipt(TX_HASH)).value?.finality).toMatchObject({ stage: 'posted', settlementReached: false });
    stage = 'ethereum_final';
    expect((await observed.readReceipt(TX_HASH)).value?.finality).toMatchObject({ stage: 'ethereum_final', settlementReached: true, ready: true });
    expect((await current.readReceipt(TX_HASH)).value?.finality.stage).toBe('soft');
  });

  it('marks a receipt non-canonical and emits a reorg fact without deleting history', async () => {
    const client = clientFixture();
    const first = await reader(client).readReceipt(TX_HASH);
    const reorged = await reader(clientFixture({ getBlock: async () => ({ hash: REORG_BLOCK_HASH, timestamp: 1_758_067_140n }) })).readReceiptWithHistory(TX_HASH, first);
    expect(reorged.receipt.value).toMatchObject({ status: 'reorged', canonical: false });
    expect(reorged.receipt.value?.finality).toMatchObject({ stage: 'unknown', settlementReached: false, reason: 'receipt-not-canonical' });
    expect(reorged.reorg?.value).toMatchObject({ transactionHash: TX_HASH, previousBlockHash: RECEIPT_BLOCK_HASH, newStage: 'unknown' });
    const history = appendReceiptObservation({ observations: [first], reorgs: [] }, reorged.receipt, NOW);
    expect(history.observations).toHaveLength(2);
    expect(history.reorgs).toHaveLength(1);
  });

  it('does not call a missing receipt a dropped or reorged transaction', async () => {
    const fact = await reader(clientFixture({ getTransactionReceipt: async () => null })).readReceipt(TX_HASH);
    expect(fact.value).toBeNull();
    expect(fact.errorCode).toBe('RECEIPT_NOT_FOUND');
    expect(fact.freshness.status).toBe('fresh');
  });

  it('keeps canonicality unknown when the receipt-height block probe is unavailable', async () => {
    const fact = await reader(clientFixture({ getBlock: async () => { throw new Error('archive unavailable'); } })).readReceipt(TX_HASH);
    expect(fact.value).toMatchObject({ status: 'unknown', canonical: null });
    expect(fact.value?.finality).toMatchObject({ stage: 'unknown', canonical: null, ready: false, reason: 'canonicality-unknown' });
  });

  it('normalizes logs for discovery without invoking a write method', async () => {
    const fact = await reader(clientFixture()).readLogs({ address: CONTRACT, fromBlock: 10n, toBlock: 10n });
    expect(fact.value).toEqual([{
      address: CONTRACT,
      topics: ['0x01'],
      data: '0x',
      blockNumber: 10n,
      blockHash: RECEIPT_BLOCK_HASH,
      transactionHash: TX_HASH,
      logIndex: 0,
      removed: false,
    }]);
    expect(fact.provenance[0]?.kind).toBe('chain_observation');
  });
});

describe('pure reorg detector', () => {
  it('only emits a transition from a canonical observation to a non-canonical one', () => {
    const canonical = { value: { transactionHash: TX_HASH, status: 'confirmed', receiptStatus: 'success', blockNumber: 10n, blockHash: RECEIPT_BLOCK_HASH, confirmations: 1, gasUsed: 1n, effectiveGasPrice: 1n, canonical: true, finality: { stage: 'confirmed', requiredStage: 'confirmed', canonical: true, settlementReached: true, ready: true, confirmations: 1, observedAt: NOW.toISOString(), freshness: { status: 'fresh', observedAt: NOW.toISOString(), expiresAt: '2026-09-17T00:00:01.000Z', ageSeconds: '0', policyVersion: 'fixture' }, provenance: [] } } } as unknown as ChainFact<ChainReceiptFact>;
    const nonCanonical = { ...canonical, value: { ...canonical.value!, canonical: false, status: 'reorged', finality: { ...canonical.value!.finality, canonical: false, settlementReached: false, ready: false, stage: 'unknown' } } } as unknown as ChainFact<ChainReceiptFact>;
    expect(detectReorg(canonical, nonCanonical, NOW)?.value?.newStage).toBe('unknown');
    expect(detectReorg(nonCanonical, canonical, NOW)).toBeNull();
  });
});
