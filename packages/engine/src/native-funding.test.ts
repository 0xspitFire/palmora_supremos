import { describe, expect, it, vi } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import type { TransactionIntent } from './types.js';
import { NativeFundingEngine, type NativeFundingEngineHooks, type NativeFundingEnginePolicy, type NativeFundingEngineRequest, type NativeFundingReader } from './native-funding.js';

const NOW = new Date('2026-11-13T15:00:00.000Z');
const WALLET = `0x${'2'.repeat(40)}`;
const DIGEST = `sha256:${'a'.repeat(64)}`;
const HASH = `0x${'b'.repeat(64)}`;
function fixture() {
  // Ephemeral synthetic test identity, never persisted or logged.
  const account = privateKeyToAccount(generatePrivateKey());
  const policy: NativeFundingEnginePolicy = { kind: 'native-fleet-topup-v1', active: true, chainId: 1, hub: account.address, recipients: [WALLET], recordDigest: DIGEST, budgetProfileDigest: DIGEST, walletSetDigest: DIGEST, policyReference: 'turnkey:hub-only', expiresAt: '2099-01-01T00:00:00.000Z', maxTransferWei: 1000n, gasLimitMax: 21_000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n };
  const request: NativeFundingEngineRequest = { id: 'fund:one', parentRunId: 'run', parentHoldId: 'hold', parentHoldDigest: DIGEST, chainId: 1, recipient: WALLET, requiredBalanceWei: 100n, expiresAt: '2099-01-01T00:00:00.000Z' };
  const reader = (): NativeFundingReader => ({
    getChainId: async () => 1,
    getBlockNumber: async () => 10n,
    getBlock: async number => ({ number, hash: HASH, timestamp: BigInt(NOW.getTime() / 1000) }),
    getBalance: async address => address.toLowerCase() === account.address.toLowerCase() ? 100_000n : 10n,
    getCode: async () => '0x', getPendingNonce: async () => 0,
    estimateGas: async () => 21_000n, simulate: async () => '0x',
    feeBounds: async () => ({ l1DataFeeBoundWei: 0n, operatorFeeBoundWei: 0n }),
  });
  const first = reader(); const second = reader();
  const events: string[] = [];
  const hooks: NativeFundingEngineHooks = {
    assertCurrent: vi.fn(async () => { events.push('current'); }),
    claimForSigning: vi.fn(async () => { events.push('claim'); }),
    persistSigned: vi.fn(async () => { events.push('signed'); }),
    markBroadcasting: vi.fn(async () => { events.push('broadcast-marker'); }),
    markSubmitted: vi.fn(async () => { events.push('submitted'); }),
  };
  const signer = { address: account.address, sign: vi.fn(async (intent: TransactionIntent, assertCurrent: () => Promise<void>) => {
    await assertCurrent(); events.push('provider-sign');
    return account.signTransaction({ type: 'eip1559', chainId: intent.chainId, nonce: intent.nonce, to: intent.to, value: intent.value, data: intent.data, gas: intent.gasLimit, maxFeePerGas: intent.maxFeePerGas, maxPriorityFeePerGas: intent.maxPriorityFeePerGas, accessList: [] });
  }) };
  const broadcaster = vi.fn(async (signed: Hex) => { events.push('broadcast'); const { keccak256 } = await import('viem'); return keccak256(signed); });
  const options = { readers: [{ endpoint: 'https://rpc-a.example', client: first }, { endpoint: 'https://rpc-b.example', client: second }], signer, broadcast: broadcaster, now: () => NOW };
  return { engine: new NativeFundingEngine(options), options, request, policy, first, second, hooks, signer, broadcaster, events };
}

describe('native funding engine custody boundary', () => {
  it('composes two-reader exact native simulation, reservation claim, recovered signing and durable broadcast marker', async () => {
    const f = fixture();
    const preparation = await f.engine.prepare(f.request, f.policy);
    expect(preparation).toMatchObject({ valueWei: 90n, hubBalanceWei: 100_000n, fleetBalanceWei: 10n, nonce: 0, recipientCode: '0x' });
    const result = await f.engine.execute({ request: f.request, policy: f.policy, preparation, state: 'reserved' }, f.hooks);
    expect(result.hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(f.signer.sign.mock.calls[0]![0]).toMatchObject({ to: WALLET, value: 90n, data: '0x', gasLimit: 21_000n });
    expect(f.events.indexOf('claim')).toBeLessThan(f.events.indexOf('provider-sign'));
    expect(f.events.indexOf('signed')).toBeLessThan(f.events.indexOf('broadcast-marker'));
    expect(f.events.indexOf('broadcast-marker')).toBeLessThan(f.events.indexOf('broadcast'));
    expect(f.events.at(-1)).toBe('submitted');
  });

  it('rejects multiple paths/ports on one provider host and missing readers', () => {
    const f = fixture();
    expect(() => new NativeFundingEngine({ ...f.options, readers: [{ endpoint: 'https://rpc-a.example/one', client: f.first }, { endpoint: 'https://rpc-a.example:443/two', client: f.second }] })).toThrow('INDEPENDENT_READERS_REQUIRED');
    expect(() => new NativeFundingEngine({ ...f.options, readers: [f.options.readers[0]!] })).toThrow('INDEPENDENT_READERS_REQUIRED');
  });

  it.each(['code', 'stale', 'disagree', 'simulation', 'pending-change', 'unknown-fees'] as const)('blocks %s before signing', async kind => {
    const f = fixture();
    if (kind === 'code') f.first.getCode = async () => '0x01';
    if (kind === 'stale') f.first.getBlock = async number => ({ number, hash: HASH, timestamp: 0n });
    if (kind === 'disagree') f.second.getBlock = async number => ({ number, hash: `0x${'c'.repeat(64)}`, timestamp: BigInt(NOW.getTime() / 1000) });
    if (kind === 'simulation') f.first.simulate = async () => '0x01';
    if (kind === 'pending-change') f.first.getBalance = async (address, block) => address.toLowerCase() === f.policy.hub.toLowerCase() ? 100_000n : block === 'pending' ? 11n : 10n;
    if (kind === 'unknown-fees') f.first.feeBounds = async () => { throw new Error('https://provider.invalid/private-credential raw provider dump'); };
    await expect(f.engine.prepare(f.request, f.policy)).rejects.toThrow(/^NATIVE_FUNDING_/);
    expect(f.signer.sign).not.toHaveBeenCalled(); expect(f.broadcaster).not.toHaveBeenCalled();
  });

  it('refuses policy disabled, non-whitelisted recipient and signer mismatch', async () => {
    const f = fixture();
    await expect(f.engine.prepare(f.request, { ...f.policy, active: false })).rejects.toThrow('POLICY_REQUIRED');
    await expect(f.engine.prepare({ ...f.request, recipient: `0x${'4'.repeat(40)}` }, f.policy)).rejects.toThrow('POLICY_REQUIRED');
    await expect(f.engine.prepare(f.request, { ...f.policy, hub: `0x${'4'.repeat(40)}` })).rejects.toThrow('POLICY_REQUIRED');
  });

  it('blocks when the exact deficit changed after admission or the kill check trips after provider validation', async () => {
    const f = fixture();
    const preparation = await f.engine.prepare(f.request, f.policy);
    await expect(f.engine.execute({ request: f.request, policy: f.policy, preparation: { ...preparation, valueWei: 91n }, state: 'reserved' }, f.hooks)).rejects.toThrow('PREPARATION_CHANGED');
    expect(f.signer.sign).not.toHaveBeenCalled();
    f.hooks.assertCurrent = vi.fn(async () => { throw new Error('NATIVE_FUNDING_KILLED'); });
    await expect(f.engine.execute({ request: f.request, policy: f.policy, preparation, state: 'reserved' }, f.hooks)).rejects.toThrow('KILLED');
    expect(f.broadcaster).not.toHaveBeenCalled();
  });

  it('rejects returned bytes signed by another wallet without persisting or broadcasting them', async () => {
    const f = fixture(); const other = privateKeyToAccount(generatePrivateKey());
    const preparation = await f.engine.prepare(f.request, f.policy);
    f.signer.sign.mockImplementation(async intent => other.signTransaction({ type: 'eip1559', chainId: intent.chainId, nonce: intent.nonce, to: intent.to, value: intent.value, data: intent.data, gas: intent.gasLimit, maxFeePerGas: intent.maxFeePerGas, maxPriorityFeePerGas: intent.maxPriorityFeePerGas }));
    await expect(f.engine.execute({ request: f.request, policy: f.policy, preparation, state: 'reserved' }, f.hooks)).rejects.toThrow('NATIVE_FUNDING_ENGINE_UNAVAILABLE');
    expect(f.hooks.persistSigned).not.toHaveBeenCalled(); expect(f.broadcaster).not.toHaveBeenCalled();
  });

  it('keeps the pre-send ambiguity marker after an accepted-but-timed-out send and never returns provider text', async () => {
    const f = fixture(); const preparation = await f.engine.prepare(f.request, f.policy);
    f.broadcaster.mockImplementation(async () => { throw new Error('https://rpc.invalid/credential response payload'); });
    await expect(f.engine.execute({ request: f.request, policy: f.policy, preparation, state: 'reserved' }, f.hooks)).rejects.toThrow('NATIVE_FUNDING_ENGINE_UNAVAILABLE');
    expect(f.hooks.persistSigned).toHaveBeenCalledOnce(); expect(f.hooks.markBroadcasting).toHaveBeenCalledOnce(); expect(f.hooks.markSubmitted).not.toHaveBeenCalled();
  });
});
