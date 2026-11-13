import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableStore } from '../store.js';
import { ContractMonitor, type ContractMonitorCandidate, type ContractMonitorPort, type ContractMonitorScan, type ContractObservation } from './contract-monitor.js';
import { DiscoveryService } from './discovery.js';
const wallet = `0x${'1'.repeat(40)}`, contract = `0x${'2'.repeat(40)}`, blockHash = `0x${'3'.repeat(64)}`;
const candidate: ContractMonitorCandidate = { version: 1, kind: 'mint', chainId: 1, transactionHash: `0x${'4'.repeat(64)}`, blockNumber: '90', blockHash, logIndex: 1, contract, wallet, standard: 'erc721' };
const observation: ContractObservation = { ...candidate, contract, standard: 'erc721', sender: wallet, identity: '1:mint:1', blockTimestamp: '2026-11-13T12:00:00Z', observedAt: '2026-11-13T12:01:00Z', tokenIds: ['1'], quantities: ['1'], quantity: '1', strategy: 'unsupported', stage: 'unknown', priceWei: null, factoryCoverage: 'not-observed' };
const scan = (candidates: ContractMonitorCandidate[] = []): ContractMonitorScan => ({ fromBlock: '90', toBlock: '98', settledHead: '98', candidates, callsUsed: 28, partialReasons: ['DEPLOYMENT_BLOCK_SAMPLING'], deploymentBlocksInspected: ['98', '97'], deploymentBlocksOmitted: '7', factoryCoverage: 'not-observed' });
function fixture(store = new DurableStore()) {
  const port: ContractMonitorPort = { beginTick: vi.fn(), scan: vi.fn(async () => scan([candidate])), verify: vi.fn(async () => ({ status: 'verified' as const, observation })), assertVerified: vi.fn() };
  const publish = vi.fn(async (_observation: ContractObservation): Promise<void> => undefined);
  return { store, port, publish, monitor: new ContractMonitor({ store, chainId: 1, port, watched: () => [wallet], publish }) };
}
describe('durable generic NFT queue', () => {
  it('commits candidate before cursor; verifies later and deduplicates restart scans', async () => {
    const f = fixture(); await f.store.open(); await f.monitor.tick();
    expect(f.store.snapshot().events.map(e => e.type)).toEqual(['contract_monitor_candidate', 'contract_monitor_cursor']);
    await f.monitor.tick(); expect(f.publish).toHaveBeenCalledTimes(1);
    expect(f.store.snapshot().events.filter(e => e.type === 'contract_monitor_candidate')).toHaveLength(1);
    expect(f.store.snapshot().events.some(e => e.type === 'contract_monitor_done' && e.data.status === 'published')).toBe(true);
    expect(f.port.scan).toHaveBeenLastCalledWith(expect.objectContaining({ fromBlock: '99' }));
  });
  it('retains continuation and cursor when capped, and refuses to scan beyond full queue', async () => {
    const f = fixture(); f.port.scan = vi.fn(async () => ({ ...scan([candidate]), continuation: { fromBlock: '90', toBlock: '98', watchlistDigest: blockHash, phase: 'logs' as const, queryIndex: 0, offset: 1, deploymentBlockIndex: 0 } }));
    const monitor = new ContractMonitor({ store: f.store, chainId: 1, port: f.port, watched: () => [wallet], publish: f.publish, maxPending: 1 });
    await monitor.tick(); const cursor = f.store.snapshot().events.at(-1)!; expect(cursor.data.cursor).toBeUndefined();
    f.port.verify = vi.fn(async () => ({ status: 'unavailable' as const, code: 'NFT_MONITOR_RPC_TIMEOUT' }));
    expect(await monitor.tick()).toMatchObject({ status: 'partial', reason: 'CANDIDATE_QUEUE_FULL', pending: 1 }); expect(f.port.scan).toHaveBeenCalledTimes(1);
  });
  it('reopens durable queue after crash before publication, keeping failed publication pending', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nft-monitor-'));
    try { const file = join(dir, 'events.json'); const first = fixture(new DurableStore(file)); await first.store.open(); await first.monitor.tick();
      first.publish.mockRejectedValueOnce(new Error('publish failed')); await first.monitor.tick(); expect(first.store.snapshot().events.some(e => e.type === 'contract_monitor_done')).toBe(false);
      const second = fixture(new DurableStore(file)); await second.store.open(); await second.monitor.tick(); expect(second.publish).toHaveBeenCalledTimes(1);
      expect(second.store.snapshot().events.filter(e => e.type === 'contract_observation_verified')).toHaveLength(1);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('records bounded retry exhaustion as an explicit coverage gap, never a negative NFT fact', async () => {
    const f = fixture(); f.port.verify = vi.fn(async () => ({ status: 'unavailable' as const, code: 'NFT_MONITOR_RPC_TIMEOUT' }));
    const monitor = new ContractMonitor({ store: f.store, chainId: 1, port: f.port, watched: () => [wallet], publish: f.publish, maxVerificationAttempts: 1 });
    await monitor.tick(); await monitor.tick(); expect(f.publish).not.toHaveBeenCalled();
    expect(f.store.snapshot().events.find(e => e.type === 'contract_monitor_done')?.data).toMatchObject({ status: 'unavailable' as const, coverageGap: true });
  });
  it('does not advance cursor when candidate capture transaction fails', async () => {
    const f = fixture(); const spy = vi.spyOn(f.store, 'transaction').mockRejectedValueOnce(new Error('disk full')); await f.monitor.tick(); expect(f.store.snapshot().events).toHaveLength(0); spy.mockRestore();
    await f.monitor.tick(); expect(f.port.scan).toHaveBeenLastCalledWith(expect.not.objectContaining({ fromBlock: expect.anything() }));
  });
  it('rejects forged observations and emits real generic facts as unsupported, never SeaDrop', async () => {
    const f = fixture(); const discovery = new DiscoveryService(f.store, { observedAddresses: () => [{ address: wallet }], cursor: () => undefined, advanceCursor: () => undefined } as never, { chainId: 1 } as never, { budgetPerNftWei: 1n });
    await expect(discovery.observeVerifiedNFT(observation)).rejects.toThrow('UNVERIFIED_OBSERVATION');
    f.publish.mockImplementation(obs => discovery.observeVerifiedNFT(obs)); await f.monitor.tick(); await f.monitor.tick();
    const events = f.store.snapshot().events;
    expect(events.find(e => e.type === 'opportunity_observed')?.data).toMatchObject({ blocked: true, strategy: 'unsupported', stage: 'unknown', priceWei: null, opportunityId: `generic-nft:1:${contract}`, executionAuthorized: false });
    expect(events.find(e => e.type === 'watched_wallet_mint')?.data).toMatchObject({ replicable: false, strategy: 'unsupported' });
    expect(events.some(e => ['opportunity_scored', 'opportunity_notified', 'calendar_entry'].includes(e.type))).toBe(false);
    expect(events.find(e => e.type === 'opportunity_observed')?.at).toBe(observation.blockTimestamp);
  });
});
