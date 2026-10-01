import { describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { assertRequestMatchesIntent, assertSignedMatchesIntent, reserveThenSign, robinhoodL1DataGasWei } from './pre-sign.js';
import { MintError, type TransactionIntent } from './types.js';

const account = privateKeyToAccount(generatePrivateKey());
const other = privateKeyToAccount(generatePrivateKey());
const TO = '0x00005ea00ac477b1030ce78506496e8c2de24bf5';

const intent = (overrides: Partial<TransactionIntent> = {}): TransactionIntent => ({
  chainId: 1,
  from: account.address,
  to: TO,
  value: 0n,
  data: '0x1234',
  nonce: 7,
  gasLimit: 200_000n,
  maxFeePerGas: 2_000_000_000n,
  maxPriorityFeePerGas: 100_000_000n,
  campaignId: 'campaign',
  runId: 'run',
  policyRef: 'phase-1',
  ...overrides,
} as TransactionIntent);

const signFor = (signer: typeof account, item: TransactionIntent): Promise<Hex> => signer.signTransaction({ type: 'eip1559', chainId: item.chainId, to: item.to as Hex, value: item.value, data: item.data as Hex, nonce: item.nonce, gas: item.gasLimit, maxFeePerGas: item.maxFeePerGas, maxPriorityFeePerGas: item.maxPriorityFeePerGas });
const amounts = (item: TransactionIntent) => ({ valueWei: item.value, mintValueWei: item.value, maxGasCostWei: item.gasLimit * item.maxFeePerGas, l2ExecutionGasWei: item.gasLimit * item.maxFeePerGas });

describe('Robinhood L1 data-gas figure (E7)', () => {
  it('is in wei: gas units times the max fee, rounded up, never the bare unit count', () => {
    expect(robinhoodL1DataGasWei(160_000n, 1_000_000_000n)).toBe(10_000n * 1_000_000_000n);
    expect(robinhoodL1DataGasWei(160_001n, 1n)).toBe(10_001n);
    expect(robinhoodL1DataGasWei(0n, 5n)).toBe(0n);
    expect(() => robinhoodL1DataGasWei(-1n, 1n)).toThrow('L1_DATA_GAS_INPUT_INVALID');
    expect(() => robinhoodL1DataGasWei(1n, -1n)).toThrow('L1_DATA_GAS_INPUT_INVALID');
  });
});

describe('reservation amounts must equal the transaction (T-021)', () => {
  it('passes when they match and refuses a change in value, gas, or fee', () => {
    const item = intent({ value: 5n });
    expect(() => assertRequestMatchesIntent(item, amounts(item))).not.toThrow();
    expect(() => assertRequestMatchesIntent(item, { ...amounts(item), valueWei: 6n })).toThrow(MintError);
    expect(() => assertRequestMatchesIntent(item, { ...amounts(item), mintValueWei: 4n })).toThrow('differ');
    expect(() => assertRequestMatchesIntent(item, { ...amounts(item), maxGasCostWei: amounts(item).maxGasCostWei - 1n })).toThrow('differ');
    expect(() => assertRequestMatchesIntent(item, { ...amounts(item), l2ExecutionGasWei: 0n })).toThrow('differ');
  });
});

describe('the signed bytes must be the checked transaction (T-021)', () => {
  it('accepts the exact transaction from the expected wallet', async () => {
    const item = intent();
    await expect(assertSignedMatchesIntent(await signFor(account, item), item)).resolves.toBeUndefined();
  });

  it('refuses a signed transaction that differs in value, fee, gas, nonce, data, destination or chain', async () => {
    const item = intent();
    for (const changed of [{ value: 1n }, { maxFeePerGas: item.maxFeePerGas + 1n }, { maxPriorityFeePerGas: 1n }, { gasLimit: item.gasLimit + 1n }, { nonce: 8 }, { data: '0xdead' }, { to: other.address }, { chainId: 4663 }] as Array<Partial<TransactionIntent>>) {
      await expect(assertSignedMatchesIntent(await signFor(account, intent(changed)), item)).rejects.toThrow('differs');
    }
  });

  it('refuses a transaction signed by a different wallet and bytes that do not decode', async () => {
    const item = intent();
    await expect(assertSignedMatchesIntent(await signFor(other, item), item)).rejects.toThrow('expected wallet');
    await expect(assertSignedMatchesIntent('0x1234', item)).rejects.toThrow('could not be decoded');
  });
});

describe('reserve then sign (execute-level fail-closed behaviour)', () => {
  const run = (item: TransactionIntent, extra: { reserve?: () => Promise<string>; sign?: () => Promise<Hex>; checkKill?: () => void; request?: ReturnType<typeof amounts> } = {}) => {
    const calls: string[] = [];
    const result = reserveThenSign({
      intent: item,
      request: extra.request ?? amounts(item),
      reserve: async () => { calls.push('reserve'); return (extra.reserve ?? (async () => 'reservation-1'))(); },
      sign: async () => { calls.push('sign'); return (extra.sign ?? (() => signFor(account, item)))(); },
      checkKill: extra.checkKill ?? (() => undefined),
    });
    return { result, calls };
  };

  it('reserves, signs, verifies, and returns both', async () => {
    const item = intent();
    const { result, calls } = run(item);
    await expect(result).resolves.toMatchObject({ reservation: 'reservation-1' });
    expect(calls).toEqual(['reserve', 'sign']);
  });

  it('never calls the signer when the reservation is refused', async () => {
    const { result, calls } = run(intent(), { reserve: async () => { throw new Error('EXPOSURE_EXCEEDS_RESERVATION'); } });
    await expect(result).rejects.toThrow('EXPOSURE_EXCEEDS_RESERVATION');
    expect(calls).toEqual(['reserve']);
  });

  it('never reserves or signs when the reserved amounts differ from the transaction', async () => {
    const item = intent({ value: 3n });
    const { result, calls } = run(item, { request: { ...amounts(item), valueWei: 2n } });
    await expect(result).rejects.toThrow('differ');
    expect(calls).toEqual([]);
  });

  it('never signs when the kill switch trips after the reservation', async () => {
    let killed = false;
    const { result, calls } = run(intent(), { reserve: async () => { killed = true; return 'reservation-1'; }, checkKill: () => { if (killed) throw new Error('KILLED'); } });
    await expect(result).rejects.toThrow('KILLED');
    expect(calls).toEqual(['reserve']);
  });

  it('hands the reservation to the caller before any later refusal, so it can be released', async () => {
    for (const failure of ['kill', 'signer', 'mismatch'] as const) {
      const item = intent();
      let killed = false;
      const held: string[] = [];
      const result = reserveThenSign({
        intent: item,
        request: amounts(item),
        reserve: async () => { killed = failure === 'kill'; return 'reservation-1'; },
        sign: async () => { if (failure === 'signer') throw new Error('SIGNER_DOWN'); return signFor(account, failure === 'mismatch' ? intent({ value: 1n }) : item); },
        checkKill: () => { if (killed) throw new Error('KILLED'); },
        onReserved: (reservation) => { held.push(reservation); },
      });
      await expect(result).rejects.toThrow();
      expect(held).toEqual(['reservation-1']);
    }
  });

  it('refuses to hand back bytes when the signer returns a different transaction', async () => {
    const item = intent();
    const { result } = run(item, { sign: () => signFor(account, intent({ value: 1n })) });
    await expect(result).rejects.toThrow('differs');
  });
});
