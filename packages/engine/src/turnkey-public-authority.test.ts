import { describe, expect, it, vi } from 'vitest';
import { encodeFunctionData, parseAbi, zeroAddress, type Address, type Hex } from 'viem';
import { OPENSEA_FEE_COLLECTOR, SEADROP_V1_ADDRESS } from './chains.js';
import { assertIndependentPublicAuthority, independentPublicRpcEndpoints, type PublicAuthorityClient } from './turnkey-public-authority.js';
import type { TransactionIntent } from './types.js';

const NOW = new Date('2030-01-01T00:00:00.000Z');
const NOW_SECONDS = BigInt(Math.floor(NOW.getTime() / 1000));
const wallet = '0x1111111111111111111111111111111111111111' as Address;
const nft = '0x2222222222222222222222222222222222222222' as Address;
const other = '0x3333333333333333333333333333333333333333' as Address;
const hash = `0x${'a'.repeat(64)}` as Hex;
const ABI = parseAbi(['function mintPublic(address nftContract,address feeRecipient,address minterIfNotPayer,uint256 quantity) payable']);

function intent(chainId: 1 | 8453 | 4663 = 1, quantity = 4n): TransactionIntent {
  return { chainId, from: wallet, to: SEADROP_V1_ADDRESS, value: 0n,
    data: encodeFunctionData({ abi: ABI, functionName: 'mintPublic', args: [nft, OPENSEA_FEE_COLLECTOR, zeroAddress, quantity] }),
    nonce: 1, gasLimit: 200000n, maxFeePerGas: 200000000n, maxPriorityFeePerGas: 100000000n,
    campaignId: 'campaign', runId: 'run', familyContext: { nftContract: nft, feeRecipient: OPENSEA_FEE_COLLECTOR, assertReady: () => undefined } };
}
function drop() { return { mintPrice: 0n, startTime: Number(NOW_SECONDS) - 60, endTime: Number(NOW_SECONDS) + 60, maxTotalMintableByWallet: 10, feeBps: 0, restrictFeeRecipients: false }; }
interface Changes {
  chain?: number; head?: bigint; hash?: Hex | null; timestamp?: bigint;
  drop?: unknown; fees?: unknown; totalSupply?: unknown; maxSupply?: unknown;
  unknownSupply?: boolean; transportFailure?: boolean;
}
function client(changes: Changes = {}): PublicAuthorityClient {
  return {
    getBlockNumber: vi.fn(async () => {
      if (changes.transportFailure) throw new Error('https://provider.example/private-credential?api_key=secret');
      return changes.head ?? 105n;
    }),
    getChainId: vi.fn(async () => changes.chain ?? 1),
    getBlock: vi.fn(async () => ({ hash: changes.hash === undefined ? hash : changes.hash, timestamp: changes.timestamp ?? NOW_SECONDS })),
    readContract: vi.fn(async input => {
      if (input.functionName === 'getPublicDrop') return changes.drop === undefined ? drop() : changes.drop;
      if (input.functionName === 'getAllowedFeeRecipients') return changes.fees === undefined ? [] : changes.fees;
      if (changes.unknownSupply) throw new Error('optional-method-not-supported');
      return input.functionName === 'totalSupply' ? changes.totalSupply ?? 1n : changes.maxSupply ?? 100n;
    }),
  };
}
const check = (a: Changes = {}, b: Changes = a, current = intent(), now = NOW) => assertIndependentPublicAuthority(current, [client(a), client(b)], now);

describe('free public Turnkey authority at the signing boundary', () => {
  it.each([1, 8453, 4663] as const)('accepts two current agreeing free public-drop views on chain %s', async chain => {
    await expect(check({ chain }, { chain }, intent(chain))).resolves.toBeUndefined();
  });

  it('uses the same common settled block for every chain, drop, fee and supply read', async () => {
    const first = client({ head: 105n }); const second = client({ head: 103n });
    await assertIndependentPublicAuthority(intent(), [first, second], NOW);
    for (const rpc of [first, second]) {
      expect(rpc.getBlock).toHaveBeenCalledWith({ blockNumber: 101n });
      for (const [request] of vi.mocked(rpc.readContract).mock.calls) expect(request.blockNumber).toBe(101n);
      expect(rpc.readContract).toHaveBeenCalledWith(expect.objectContaining({ address: SEADROP_V1_ADDRESS, functionName: 'getPublicDrop', args: [nft] }));
      expect(rpc.readContract).toHaveBeenCalledWith(expect.objectContaining({ address: nft, functionName: 'totalSupply', args: [] }));
    }
  });

  it('rejects local context, method, canonical encoding, payer, value and quantity changes before RPC reads', async () => {
    const current = intent();
    const invalid: TransactionIntent[] = [
      { ...current, to: other }, { ...current, value: 1n }, { ...current, from: zeroAddress },
      { ...current, chainId: 999 as 1 }, { ...current, familyContext: undefined }, { ...current, campaignId: undefined },
      { ...current, runId: undefined }, { ...current, familyContext: { ...current.familyContext!, nftContract: other } },
      { ...current, familyContext: { ...current.familyContext!, feeRecipient: other } },
      { ...current, data: `${current.data}00` as Hex }, { ...current, data: '0x4300a4e6' },
      { ...current, data: encodeFunctionData({ abi: ABI, functionName: 'mintPublic', args: [nft, OPENSEA_FEE_COLLECTOR, other, 4n] }) },
      intent(1, 0n), intent(1, 16n), intent(8453, 5n),
    ];
    for (const changed of invalid) {
      const rpc = client();
      await expect(assertIndependentPublicAuthority(changed, [rpc, rpc], NOW)).rejects.toThrow('TURNKEY_PUBLIC_INTENT_INVALID');
      expect(rpc.getBlockNumber).not.toHaveBeenCalled();
    }
  });

  it('requires two sources and different RPC hosts, rather than different credentials or paths', async () => {
    await expect(assertIndependentPublicAuthority(intent(), [client()], NOW)).rejects.toThrow('TURNKEY_PUBLIC_AUTHORITY_REQUIRED');
    for (const endpoints of [[], ['https://one.example/a'], ['https://one.example/a', 'https://ONE.example/b'], ['invalid', 'https://two.example'], ['ftp://one.example', 'https://two.example']]) expect(() => independentPublicRpcEndpoints(endpoints)).toThrow('TURNKEY_PUBLIC_AUTHORITY_REQUIRED');
    expect(independentPublicRpcEndpoints(['https://one.example/a', 'invalid', 'https://one.example/b', 'https://two.example/rpc'])).toEqual(['https://one.example/a', 'https://two.example/rpc']);
  });

  it.each([
    { head: 1n }, { chain: 8453 }, { hash: null }, { hash: '0x00' as Hex },
    { timestamp: NOW_SECONDS - 301n }, { timestamp: NOW_SECONDS + 31n },
    { drop: null }, { drop: { ...drop(), mintPrice: -1n } }, { drop: { ...drop(), feeBps: 10001 } },
    { drop: { ...drop(), startTime: 'invalid' } }, { fees: ['not-an-address'] }, { totalSupply: -1n },
  ] as Changes[])('fails closed on stale or malformed authority case %#', async changes => {
    await expect(check(changes)).rejects.toThrow('TURNKEY_PUBLIC_AUTHORITY_STALE');
  });

  it('requires matching canonical block hashes, timestamps, drop terms, fee sets and supply observations', async () => {
    for (const changed of [
      { hash: `0x${'b'.repeat(64)}` as Hex }, { timestamp: NOW_SECONDS - 1n },
      { drop: { ...drop(), mintPrice: 1n } }, { drop: { ...drop(), maxTotalMintableByWallet: 9 } },
      { fees: [OPENSEA_FEE_COLLECTOR] }, { totalSupply: 2n }, { unknownSupply: true },
    ]) await expect(check({}, changed)).rejects.toThrow('TURNKEY_PUBLIC_RPC_DISAGREEMENT');
  });

  it('refuses a paid drop, a closed stage, excess per-wallet quantity and exhausted known supply', async () => {
    await expect(check({ drop: { ...drop(), mintPrice: 1n } })).rejects.toThrow('TURNKEY_PUBLIC_DROP_NOT_FREE');
    await expect(check({ drop: { ...drop(), maxTotalMintableByWallet: 3 } })).rejects.toThrow('TURNKEY_PUBLIC_QUANTITY_EXCEEDED');
    await expect(check({ totalSupply: 98n })).rejects.toThrow('TURNKEY_PUBLIC_SUPPLY_EXCEEDED');
    await expect(check({ maxSupply: 0n })).rejects.toThrow('TURNKEY_PUBLIC_SUPPLY_EXCEEDED');
    for (const terms of [{ startTime: 0, endTime: 0 }, { startTime: Number(NOW_SECONDS) + 1 }, { endTime: Number(NOW_SECONDS) - 1 }]) await expect(check({ drop: { ...drop(), ...terms } })).rejects.toThrow('TURNKEY_PUBLIC_STAGE_NOT_OPEN');
    // A still-fresh common block inside a stage cannot authorize signing after wall-clock expiry.
    const past = { timestamp: NOW_SECONDS - 120n, drop: { ...drop(), startTime: Number(NOW_SECONDS) - 180, endTime: Number(NOW_SECONDS) - 60 } };
    await expect(check(past)).rejects.toThrow('TURNKEY_PUBLIC_STAGE_NOT_OPEN');
  });

  it('uses consistently unavailable optional supply methods without inventing supply facts', async () => {
    await expect(check({ unknownSupply: true })).resolves.toBeUndefined();
    await expect(check({ totalSupply: 96n })).resolves.toBeUndefined();
  });

  it.each(['stage-end', 'block-age'] as const)('samples current time after awaited RPCs cross %s', async boundary => {
    let clock = NOW;
    let finish!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { finish = resolve; });
    const terms = boundary === 'stage-end' ? drop() : { ...drop(), endTime: Number(NOW_SECONDS) + 3600 };
    const first = client({ drop: terms });
    const second = client({ drop: terms });
    second.getBlock = vi.fn(async () => {
      entered();
      await blocked;
      return { hash, timestamp: NOW_SECONDS };
    });
    const pending = assertIndependentPublicAuthority(intent(), [first, second], () => clock);
    await started;
    clock = new Date(NOW.getTime() + (boundary === 'stage-end' ? 61_000 : 301_000));
    finish();
    await expect(pending).rejects.toThrow(boundary === 'stage-end' ? 'TURNKEY_PUBLIC_STAGE_NOT_OPEN' : 'TURNKEY_PUBLIC_AUTHORITY_STALE');
  });

  it('enforces restricted recipients and only permits the existing OpenSea fallback for unrestricted drops', async () => {
    await expect(check({ drop: { ...drop(), restrictFeeRecipients: true } })).rejects.toThrow('TURNKEY_PUBLIC_FEE_RECIPIENT_INVALID');
    await expect(check({ drop: { ...drop(), restrictFeeRecipients: true }, fees: [OPENSEA_FEE_COLLECTOR] })).resolves.toBeUndefined();
    const custom = { ...intent(), data: encodeFunctionData({ abi: ABI, functionName: 'mintPublic', args: [nft, other, zeroAddress, 4n] }), familyContext: { ...intent().familyContext!, feeRecipient: other } };
    await expect(check({}, {}, custom)).rejects.toThrow('TURNKEY_PUBLIC_FEE_RECIPIENT_INVALID');
    await expect(check({ fees: [other] }, { fees: [other] }, custom)).resolves.toBeUndefined();
  });

  it('redacts upstream RPC errors and invalid time rather than exposing endpoint credentials', async () => {
    await expect(check({ transportFailure: true })).rejects.toThrow(/^TURNKEY_PUBLIC_AUTHORITY_UNAVAILABLE$/);
    await expect(check({}, {}, intent(), new Date('invalid'))).rejects.toThrow(/^TURNKEY_PUBLIC_AUTHORITY_STALE$/);
  });
});
