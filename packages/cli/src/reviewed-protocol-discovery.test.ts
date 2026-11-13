import { describe, expect, it, vi } from 'vitest';
import { keccak256, stringToHex, zeroAddress, type Address, type Hex } from 'viem';
import { ContractMonitor, DurableStore, REVIEWED_ERC721_PUBLIC_BASELINE, type ActiveAdaptiveModel, type BackendStore, type ChainEvidenceRecord, type ContractObservation } from '@mint-bot/backend';
import { NFTDiscoveryObserver, type NFTDiscoveryReader } from '@mint-bot/engine';
import { createReviewedProtocolDiscovery, type ReviewedDiscoveryOptions } from './reviewed-protocol-discovery.js';
import type { QualifiedSource } from './replication-source.js';
const start = Date.parse('2026-11-13T12:00:00Z');
const wallet = `0x${'1'.repeat(40)}` as Address, contract = `0x${'2'.repeat(40)}` as Address;
const hash = `0x${'3'.repeat(64)}` as Hex, blockHash = `0x${'4'.repeat(64)}` as Hex;
const registryDigest = `sha256:${'a'.repeat(64)}`, descriptorDigest = `sha256:${'b'.repeat(64)}`;
const mintedAt = new Date(start - 5000).toISOString();
function baseline(): ChainEvidenceRecord {
  return { id: 'reviewed-baseline', chainId: 1, status: 'accepted', executionEnabled: true, seaDropCompatible: false, positiveLivePath: true, archiveForkPassed: true, reconciliationPassed: true, finalityPassed: true, negativeCases: { revert: true, sold_out: true, price_drift: true, insufficient_funds: true, quantity_limit: true, stale_phase: true, fee_recipient: true, kill: true, cap: true }, endpointIdentity: 'two-configured-hosts', strategyVersion: REVIEWED_ERC721_PUBLIC_BASELINE, sourceBlock: 98n, sourceBlockHash: blockHash, checkedAt: mintedAt, expiresAt: new Date(start + 3600_000).toISOString(), reviewedProtocol: { family: 'erc721-reviewed-public-v1', registryDigest, descriptorDigests: [descriptorDigest] } };
}
function qualified(): QualifiedSource {
  return { sourceBlockHash: blockHash, reviewedProtocol: { family: 'erc721-reviewed-public-v1', registryDigest, descriptorDigest }, mintedAt,
    observed: { chainId: 1, hash, from: wallet, to: contract, value: 0n, data: '0x12345678', blockNumber: 98n, observedAt: mintedAt },
    drop: { chainId: 1, nftContract: contract, strategyName: 'erc721-reviewed-public-v1', mintPrice: 0n, feePayer: zeroAddress, maxTotalMintableByWallet: 10, maxTokenSupply: 100n, totalMinted: 1n, startTime: start / 1000 - 60, endTime: start / 1000 + 3600 },
    plan: { version: 'replication-plan-v1', verdict: 'replicable', strategy: 'erc721-reviewed-public-v1', source: { hash, from: wallet, chainId: 1, blockNumber: 98n, observedAt: mintedAt }, observed: { nftContract: contract, quantity: 1 }, checklist: { knownStrategy: true, chainMatches: true, targetMatches: true, selectorDecoded: true, contractMatches: true, feeRecipientMatches: true, walletIndependent: false, valueMatches: true, quantityWithinDrop: true, simulationRequired: true, operatorApprovalRequired: true }, reasons: [], targets: [{ wallet, to: contract, value: 0n, data: '0x12345678', quantity: 1 }], operatorApprovalRequired: true, simulationRequired: true } };
}
/** Exercises BOTH WeakSets through actual observer verification and canonical monitor publication. */
async function fixture() {
  let time = start;
  const now = () => new Date(time); const store = new DurableStore(); await store.open();
  const log = { address: contract, topics: [keccak256(stringToHex('Transfer(address,address,uint256)')), `0x${'0'.repeat(64)}`, `0x${wallet.slice(2).padStart(64, '0')}`, `0x${'0'.repeat(63)}1`], data: '0x', logIndex: 0, transactionHash: hash, blockNumber: 98n, blockHash, removed: false };
  const tx = { hash, from: wallet, to: contract, nonce: 0, blockNumber: 98n, blockHash };
  const reader = (): NFTDiscoveryReader => ({ chainId: async () => 1, head: async () => 100n, block: async (number, full) => ({ number, hash: blockHash, timestamp: BigInt((start - 5000) / 1000), ...(full ? { transactions: [] } : {}) }), logs: async input => input.topics[0] === log.topics[0] ? [log] : [], transaction: async () => tx, receipt: async () => ({ transactionHash: hash, from: wallet, to: contract, contractAddress: null, status: 'success', blockNumber: 98n, blockHash, logs: [log] }), code: async () => '0x6000', supportsInterface: async (_address, id) => ['0x01ffc9a7', '0x80ac58cd'].includes(id) });
  const observer = new NFTDiscoveryObserver({ chainId: 1, readers: [{ endpoint: 'https://one.example', client: reader() }, { endpoint: 'https://two.example', client: reader() }], now });
  let observation: ContractObservation | undefined;
  const monitor = new ContractMonitor({ store, chainId: 1, port: observer, watched: () => [wallet], publish: async value => { observation = value; }, now });
  await monitor.tick(); await monitor.tick(); if (!observation) throw new Error('FIXTURE_REAL_PROOF_MISSING');
  await store.transaction(state => { state.chainEvidence.push(baseline()); });
  const source = qualified(); const qualify = vi.fn(async (_observation: ContractObservation): Promise<QualifiedSource | undefined> => source);
  const options: ReviewedDiscoveryOptions = { store, qualify, now };
  return { store, observation, source, qualify, options, advance: (ms: number) => { time += ms; }, now };
}
const scores = (store: BackendStore) => store.snapshot().events.filter(event => event.type.startsWith('opportunity_'));
describe('real branded generic NFT to reviewed discovery bridge', () => {
  it('publishes exact accepted chain/registry/descriptor as reviewed and never labels it SeaDrop or authorizes execution', async () => {
    const f = await fixture(); await createReviewedProtocolDiscovery(f.options).observe(f.observation);
    expect(scores(f.store)).toHaveLength(1); expect(scores(f.store)[0]!.data).toMatchObject({ opportunityId: `reviewed-erc721:1:${contract}`, strategy: 'erc721-reviewed-public-v1', priceWei: '0', executionAuthorized: false, sourceBlock: '98', sourceBlockHash: blockHash, reviewedProtocol: { registryDigest, descriptorDigest }, watchedMinters: [wallet] });
    expect(JSON.stringify(scores(f.store))).not.toContain('seadrop:');
    expect(f.store.snapshot().events.find(event => event.type === 'watched_wallet_mint')?.data).toMatchObject({ strategy: 'erc721-reviewed-public-v1', replicable: true });
  });
  it('rejects unbranded JSON copies before calling qualifier', async () => {
    const f = await fixture(); await expect(createReviewedProtocolDiscovery(f.options).observe({ ...f.observation })).rejects.toThrow('UNVERIFIED_OBSERVATION'); expect(f.qualify).not.toHaveBeenCalled();
  });
  it('does not score unknown contracts when qualifier returns no reviewed source', async () => {
    const f = await fixture(); f.qualify.mockResolvedValue(undefined); await createReviewedProtocolDiscovery(f.options).observe(f.observation); expect(scores(f.store)).toHaveLength(0);
  });
  it.each(['missing', 'chain', 'registry', 'descriptor', 'expired', 'revoked', 'legacy'] as const)('requires exact current baseline: %s', async variant => {
    const f = await fixture(); await f.store.transaction(state => { const evidence = state.chainEvidence[0]!; if (variant === 'missing') state.chainEvidence = []; if (variant === 'chain') evidence.chainId = 8453; if (variant === 'registry') evidence.reviewedProtocol!.registryDigest = `sha256:${'c'.repeat(64)}`; if (variant === 'descriptor') evidence.reviewedProtocol!.descriptorDigests = [`sha256:${'d'.repeat(64)}`]; if (variant === 'expired') evidence.expiresAt = f.now().toISOString(); if (variant === 'revoked') evidence.executionEnabled = false; if (variant === 'legacy') evidence.strategyVersion = 'seadrop-v1-public'; });
    await createReviewedProtocolDiscovery(f.options).observe(f.observation); expect(scores(f.store)).toHaveLength(0);
  });
  it.each(['hash', 'sender', 'contract', 'drop-chain', 'paid', 'strategy', 'unqualified'] as const)('rejects wrong qualified source binding: %s', async variant => {
    const f = await fixture(); const source = f.source;
    if (variant === 'hash') source.observed = { ...source.observed, hash: `0x${'9'.repeat(64)}` }; if (variant === 'sender') source.observed = { ...source.observed, from: contract }; if (variant === 'contract') source.drop = { ...source.drop, nftContract: wallet }; if (variant === 'drop-chain') source.drop = { ...source.drop, chainId: 8453 }; if (variant === 'paid') source.drop = { ...source.drop, mintPrice: 1n }; if (variant === 'strategy') source.drop = { ...source.drop, strategyName: 'seadrop-v1-public' }; if (variant === 'unqualified') source.reviewedProtocol = undefined;
    await createReviewedProtocolDiscovery(f.options).observe(f.observation); expect(scores(f.store)).toHaveLength(0);
  });
  it.each(['observed-chain', 'recipient', 'value', 'block', 'observed-time', 'mint-time', 'source-hash', 'scope-family'] as const)('rejects contradictory provenance returned by qualifier: %s', async variant => {
    const f = await fixture(); const source = f.source;
    if (variant === 'observed-chain') source.observed = { ...source.observed, chainId: 8453 }; if (variant === 'recipient') source.observed = { ...source.observed, to: wallet }; if (variant === 'value') source.observed = { ...source.observed, value: 1n }; if (variant === 'block') source.observed = { ...source.observed, blockNumber: 97n }; if (variant === 'observed-time') source.observed = { ...source.observed, observedAt: f.now().toISOString() }; if (variant === 'mint-time') source.mintedAt = f.now().toISOString(); if (variant === 'source-hash') source.sourceBlockHash = `0x${'8'.repeat(64)}`; if (variant === 'scope-family') (source.reviewedProtocol as unknown as { family: string }).family = 'seadrop-v1-public';
    await createReviewedProtocolDiscovery(f.options).observe(f.observation); expect(scores(f.store)).toHaveLength(0);
  });
  it('rejects a baseline that expires during awaited qualification', async () => {
    const f = await fixture(); await f.store.transaction(state => { state.chainEvidence[0]!.expiresAt = new Date(start + 1000).toISOString(); });
    f.qualify.mockImplementation(async () => { f.advance(2000); return f.source; }); await createReviewedProtocolDiscovery(f.options).observe(f.observation); expect(scores(f.store)).toHaveLength(0);
  });
  it('preserves watched convergence and explicit static/adaptive scores from cache-only ports', async () => {
    const f = await fixture(); const other = `0x${'5'.repeat(40)}`;
    await f.store.transaction(state => state.events.push({ id: 'prior-reviewed-selfmint', type: 'watched_wallet_mint', at: mintedAt, data: { chainId: 1, contract, wallet: other, strategy: 'erc721-reviewed-public-v1', replicable: true } }));
    const model: ActiveAdaptiveModel = { version: 'adaptive-model-v1', chainId: 1, epochId: 'bounded-approved-epoch', policyDigest: registryDigest, issuedAt: mintedAt, expiresAt: new Date(start + 3600_000).toISOString(), maxScoreChange: 3, weightsBps: { convergence: 12000 } };
    const snapshot = vi.fn(() => ({ version: 'advanced-facts-v1' as const, chainId: 1 as const, contract })); const adaptive = vi.fn(() => model);
    await createReviewedProtocolDiscovery({ ...f.options, advanced: { snapshot }, adaptive: { active: adaptive } }).observe(f.observation);
    const score = scores(f.store)[0]!.data; expect(score.watchedMinters).toEqual([other, wallet]); expect(score.modelEpochId).toBe(model.epochId); expect(typeof score.staticScore).toBe('number'); expect(Math.abs(Number(score.score) - Number(score.staticScore))).toBeLessThanOrEqual(3); expect(snapshot).toHaveBeenCalledWith(expect.objectContaining({ watchedWallets: [other, wallet] })); expect(adaptive).toHaveBeenCalledWith(1, expect.any(Date));
  });
  it('deduplicates durable score across publisher restart', async () => {
    const f = await fixture(); await createReviewedProtocolDiscovery(f.options).observe(f.observation); await createReviewedProtocolDiscovery(f.options).observe(f.observation);
    expect(scores(f.store)).toHaveLength(1); expect(f.qualify).toHaveBeenCalledTimes(1);
  });
  it('rate-bounds unavailable retries and concurrent duplicate work', async () => {
    const f = await fixture(); f.qualify.mockRejectedValueOnce(new Error('source unavailable')); const publisher = createReviewedProtocolDiscovery(f.options);
    await expect(publisher.observe(f.observation)).rejects.toThrow(); await expect(publisher.observe(f.observation)).rejects.toThrow('RATE_LIMITED'); expect(f.qualify).toHaveBeenCalledTimes(1);
    f.advance(30_000); await publisher.observe(f.observation); expect(f.qualify).toHaveBeenCalledTimes(2); expect(scores(f.store)).toHaveLength(1);
    const g = await fixture(); let resolve!: (value: QualifiedSource) => void; g.qualify.mockImplementation(async () => new Promise<QualifiedSource>(done => { resolve = done; })); const busy = createReviewedProtocolDiscovery(g.options); const first = busy.observe(g.observation); await expect(busy.observe(g.observation)).rejects.toThrow('RATE_LIMITED'); resolve(g.source); await first; expect(g.qualify).toHaveBeenCalledTimes(1);
  });
  it('rejects expired source before qualification and after awaited work crosses freshness', async () => {
    const f = await fixture(); f.advance(16 * 60_000); await createReviewedProtocolDiscovery(f.options).observe(f.observation); expect(f.qualify).not.toHaveBeenCalled();
    const g = await fixture(); g.qualify.mockImplementation(async () => { g.advance(16 * 60_000); return g.source; }); await createReviewedProtocolDiscovery(g.options).observe(g.observation); expect(scores(g.store)).toHaveLength(0);
  });
});
