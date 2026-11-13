import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutionRevertedError, type Address } from 'viem';
import { MintEngine } from './mint-engine.js';
import { registerStrategy } from './drop-reader.js';
import type { MintJobConfig, MintStrategy, SpendReservationProvider, EngineLifecycleStore, WalletMintResult } from './types.js';

const fakes = vi.hoisted(() => ({ client: { getChainId: vi.fn(), getBlockNumber: vi.fn(), call: vi.fn(), getBalance: vi.fn() }, createBroadcaster: vi.fn() }));
vi.mock('viem', async (original) => ({ ...await original<typeof import('viem')>(), createPublicClient: () => fakes.client }));
vi.mock('./chains.js', async (original) => { const actual = await original<typeof import('./chains.js')>(); return { ...actual, resolveChainByNameFromSecrets: async () => ({ ...actual.getChainConfig(1), rpcEndpoints: ['http://127.0.0.1:1'] }) }; });
vi.mock('./broadcasters/index.js', () => ({ createBroadcaster: fakes.createBroadcaster }));
const A = '0x1111111111111111111111111111111111111111' as Address;
const B = '0x2222222222222222222222222222222222222222' as Address;
const contract = '0x3333333333333333333333333333333333333333' as Address;
const now = new Date('2026-11-07T00:00:00Z');

function engineFor(failed: Address[]) {
  const strategy: MintStrategy = { name: 'preflight-isolation-test', readDrop: async () => ({ nftContract: contract, mintPrice: 0n, maxTotalMintableByWallet: 10, maxTokenSupply: 100n, totalMinted: 0n, startTime: 0, endTime: 2_000_000_000, feePayer: A, strategyName: 'preflight-isolation-test', chainId: 1 }), validateDrop: () => ({ valid: true, errors: [], warnings: [] }), estimateGas: async (_client, _drop, address) => { if (failed.includes(address)) throw new ExecutionRevertedError(); return 100_000n; }, buildCalldata: () => '0x1234' };
  registerStrategy(strategy);
  const signer = { listWallets: async () => [{ index: 0, address: A }, { index: 1, address: B }], signTransaction: vi.fn(), zeroize: vi.fn() };
  const reserve = vi.fn();
  const config = { target: { chain: 'ethereum', contract, strategy: strategy.name, quantity: 1, campaignId: 'test-campaign' }, fleet: { walletFile: '/tmp/not-read', maxWallets: 2 }, timing: { mintStartUnix: 'auto', armBeforeMs: 30_000 }, fees: { maxFeePerGasGwei: 0.1, maxPriorityFeePerGasGwei: 0.01, gasLimitPadding: 1.2 }, safety: { maxSpendEth: 0.002, dailySpendCapEth: 0.002, maxReplacementBumps: 0, dryRun: false, killSwitchFile: '' }, broadcast: { mode: 'public', rpcEndpoints: [], blastParallel: false }, observability: { logLevel: 'silent', logFile: '/tmp/mintbot-preflight-isolation.log' } } as unknown as MintJobConfig;
  const engine = new MintEngine(config, { signerFactory: async () => signer, now: () => now, runId: 'run', intentId: 'intent', reservationProvider: { durable: true, storeKind: 'normalized-sqlite', reserve } as unknown as SpendReservationProvider, lifecycleStore: { durable: true, storeKind: 'normalized-sqlite', persistRun: vi.fn() } as unknown as EngineLifecycleStore });
  const executeFleet = vi.spyOn(engine as unknown as { executeFleet: (...args: unknown[]) => Promise<WalletMintResult[]> }, 'executeFleet').mockResolvedValue([]);
  return { engine, signer, reserve, executeFleet };
}

beforeEach(() => {
  vi.clearAllMocks();
  fakes.client.getChainId.mockResolvedValue(1);
  fakes.client.getBlockNumber.mockResolvedValue(1n);
  fakes.client.call.mockResolvedValue({ data: '0x' });
  fakes.client.getBalance.mockResolvedValue(1_000_000_000_000_000_000n);
  fakes.createBroadcaster.mockReturnValue({ name: 'test' });
});
describe('MintEngine preprocessing wallet admission', () => {
  it.each([[A, 1], [B, 0]] as const)('never admits failed %s and retains healthy index %s', async (failed, healthy) => {
    const { engine, signer, executeFleet } = engineFor([failed]);
    const result = await engine.execute('not-used');
    expect(executeFleet.mock.calls[0]?.[1]).toEqual([healthy]);
    expect(result.walletResults).toEqual([expect.objectContaining({ address: failed, status: 'skipped', notStarted: 'engine-preflight-v1', error: 'WALLET_ESTIMATE_REVERTED' })]);
    expect(signer.signTransaction).not.toHaveBeenCalled();
    expect(signer.zeroize).toHaveBeenCalledOnce();
  });
  it('returns all-skipped results without constructing a broadcaster, signing or reserving', async () => {
    const { engine, signer, executeFleet, reserve } = engineFor([A, B]);
    const result = await engine.execute('not-used');
    expect(result.walletResults).toHaveLength(2);
    expect(result.walletResults.every((wallet) => wallet.status === 'skipped' && wallet.notStarted === 'engine-preflight-v1')).toBe(true);
    expect(result.totalGasSpentWei).toBe(0n);
    expect(fakes.createBroadcaster).not.toHaveBeenCalled();
    expect(executeFleet).not.toHaveBeenCalled();
    expect(signer.signTransaction).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
    expect(signer.zeroize).toHaveBeenCalledOnce();
  });
});
