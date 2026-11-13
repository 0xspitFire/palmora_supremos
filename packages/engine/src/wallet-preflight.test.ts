import { describe, expect, it, vi } from 'vitest';
import { BaseError, ExecutionRevertedError, InsufficientFundsError, type Address, type PublicClient } from 'viem';
import { prepareWalletSimulations, walletEstimateFailure } from './wallet-preflight.js';
import type { DropConfig, MintStrategy } from './types.js';

const A = '0x1111111111111111111111111111111111111111' as Address;
const B = '0x2222222222222222222222222222222222222222' as Address;
const drop = { nftContract: A } as DropConfig;
function fixture(failAt?: Address, failure: Error = new ExecutionRevertedError()) {
  const call = vi.fn(async () => ({ data: '0x' }));
  const strategy = { estimateGas: vi.fn(async (_client: unknown, _drop: unknown, address: Address) => { if (address === failAt) throw failure; return 100_000n; }), buildCalldata: () => '0x1234' } as unknown as MintStrategy;
  const checkKill = vi.fn();
  const input = { wallets: [{ index: 0, address: A }, { index: 1, address: B }], publicClient: { getBlockNumber: async () => 12n, call } as unknown as PublicClient, strategy, drop, quantity: 1, value: 0n, padding: 1.2, checkKill, now: () => new Date('2026-11-07T00:00:00Z') };
  return { input, call, checkKill };
}

describe('wallet preflight failure isolation', () => {
  it.each([A, B])('retains a healthy wallet when %s has an explicit revert', async (failed) => {
    const { input, call } = fixture(failed);
    const result = await prepareWalletSimulations(input);
    expect(result.gasLimits.size).toBe(1);
    expect(result.simulations.get(failed === A ? 0 : 1)).toMatchObject({ success: false, error: 'WALLET_ESTIMATE_REVERTED' });
    expect(result.simulations.get(failed === A ? 1 : 0)).toMatchObject({ success: true, gasEstimate: 100_000n });
    expect(call).toHaveBeenCalledTimes(1);
  });
  it('all failed estimates yield no usable gas/simulation and never call the chain', async () => {
    const { input, call } = fixture();
    input.strategy.estimateGas = async () => { throw new InsufficientFundsError(); };
    const result = await prepareWalletSimulations(input);
    expect(result.gasLimits.size).toBe(0);
    expect([...result.simulations.values()].every((sim) => !sim.success)).toBe(true);
    expect(call).not.toHaveBeenCalled();
  });
  it.each([new Error('execution reverted'), new Error('network unavailable'), new BaseError('provider timeout', { cause: new ExecutionRevertedError() })])('unknown or systemic errors abort without authorizing a wallet', async (error) => {
    const { input, call } = fixture(A, error);
    await expect(prepareWalletSimulations(input)).rejects.toBe(error);
    expect(call).not.toHaveBeenCalled();
  });
  it('honors a kill after an estimate failure rather than continuing', async () => {
    const { input, checkKill } = fixture(A);
    checkKill.mockImplementationOnce(() => undefined).mockImplementation(() => { throw new Error('KILLED'); });
    await expect(prepareWalletSimulations(input)).rejects.toThrow('KILLED');
    expect(input.strategy.estimateGas).toHaveBeenCalledTimes(1);
  });
  it('does not promote nested, cyclic, or over-deep unknown errors to wallet failures', () => {
    const cyclic = new ExecutionRevertedError();
    Object.assign(cyclic, { cause: cyclic });
    expect(walletEstimateFailure(cyclic)).toBeUndefined();
    let nested: Error = new Error('unknown');
    for (let i = 0; i < 9; i++) nested = new BaseError('wrapper', { cause: nested });
    expect(walletEstimateFailure(nested)).toBeUndefined();
  });
  it('simulation payloads retain only fixed failure classifications', async () => {
    const { input } = fixture();
    input.publicClient.call = vi.fn(async () => { throw new Error('insufficient funds https://rpc.example/synthetic-marker data=0x123456789abcdef0'); });
    const result = await prepareWalletSimulations(input);
    expect(result.simulations.get(0)?.error).toBe('SIMULATION_FAILED:insufficient-funds');
    expect(JSON.stringify([...result.simulations.values()], (_key, value) => typeof value === 'bigint' ? value.toString() : value)).not.toContain('synthetic-marker');
  });
});
