import { describe, expect, it } from 'vitest';
import { applyBaseFeeSafetyMargin, baseOperatorFeeWei, baseReceiptFees, quoteBaseFeeBound, readBaseOperatorFee } from './base-fees.js';

describe('Base fee accounting', () => {
  it('computes the Isthmus operator fee in wei', () => {
    expect(baseOperatorFeeWei(200_000n, 1_500_000n, 7n)).toBe(300_007n);
  });

  it('applies the conservative bound with ceiling division', () => {
    expect(applyBaseFeeSafetyMargin(10n)).toBe(12n);
    expect(applyBaseFeeSafetyMargin(1n)).toBe(2n);
  });

  it('uses explicit receipt components or an operator fee observed from the oracle at the receipt block', () => {
    expect(baseReceiptFees({ l1Fee: 11n, operatorFee: 3n }, 20n)).toEqual({ l1DataFeeWei: 11n, operatorFeeWei: 3n });
    expect(baseReceiptFees({ l1DataFee: 11n, operatorFeeScalar: 1_000_000n, operatorFeeConstant: 3n }, 20n, 23n)).toEqual({ l1DataFeeWei: 11n, operatorFeeWei: 23n });
    expect(baseReceiptFees({ l1Fee: '0x1fea905d', operatorFee: '0x0' }, 20n)).toEqual({ l1DataFeeWei: 535_466_077n, operatorFeeWei: 0n });
    expect(baseReceiptFees({ l1Fee: '0xb', l1DataFee: 11n, operatorFee: 3n }, 20n)).toEqual({ l1DataFeeWei: 11n, operatorFeeWei: 3n });
  });

  it('fails closed when either receipt component cannot be proven', () => {
    expect(() => baseReceiptFees({ operatorFee: 0n }, 20n)).toThrow('BASE_RECEIPT_L1_FEE_REQUIRED');
    expect(() => baseReceiptFees({ l1Fee: 1n }, 20n)).toThrow('BASE_RECEIPT_OPERATOR_FEE_REQUIRED');
    expect(() => baseReceiptFees({ l1Fee: '-1', operatorFee: 0n }, 20n)).toThrow('BASE_RECEIPT_L1_FEE_MALFORMED');
    expect(() => baseReceiptFees({ l1Fee: 1n, operatorFee: '1' }, 20n)).toThrow('BASE_RECEIPT_OPERATOR_FEE_MALFORMED');
    expect(() => baseReceiptFees({ l1Fee: '0x01', operatorFee: 0n }, 20n)).toThrow('BASE_RECEIPT_L1_FEE_MALFORMED');
    expect(() => baseReceiptFees({ l1Fee: `0x1${'0'.repeat(64)}`, operatorFee: 0n }, 20n)).toThrow('BASE_RECEIPT_L1_FEE_MALFORMED');
    expect(() => baseReceiptFees({ l1Fee: 1n << 256n, operatorFee: 0n }, 20n)).toThrow('BASE_RECEIPT_L1_FEE_MALFORMED');
    expect(() => baseReceiptFees({ l1Fee: 1n, l1DataFee: '0x2', operatorFee: 0n }, 20n)).toThrow('BASE_RECEIPT_L1_FEE_MALFORMED');
  });

  it('accepts the maximum uint256 fee quantity and rejects larger operator fees', () => {
    const max = (1n << 256n) - 1n;
    expect(baseReceiptFees({ l1Fee: `0x${'f'.repeat(64)}`, operatorFee: max }, 20n)).toEqual({ l1DataFeeWei: max, operatorFeeWei: max });
    expect(() => baseReceiptFees({ l1Fee: 0n, operatorFee: 1n << 256n }, 20n)).toThrow('BASE_RECEIPT_OPERATOR_FEE_MALFORMED');
  });

  it('quotes the exact unsigned shape through Base predeploys', async () => {
    const values: unknown[] = [100n, 8n, 2, 7n];
    const client = { readContract: async () => values.shift() };
    const quote = await quoteBaseFeeBound(client as never, { type: 'eip1559', chainId: 8453, nonce: 1, to: '0x1111111111111111111111111111111111111111', value: 0n, data: '0x1234', gas: 200_000n, maxFeePerGas: 10n, maxPriorityFeePerGas: 1n });
    expect(quote.l1DataFeeWei).toBe(120n);
    expect(quote.operatorFeeWei).toBe(10n);
    expect(quote.totalWei).toBe(130n);
    expect(quote.unsignedTxSize).toBeGreaterThan(0);
  });

  it('reads the active operator-fe formula at the exact receipt block', async () => {
    const calls: unknown[] = [];
    const client = { readContract: async (request: unknown) => { calls.push(request); return 42n; } };
    await expect(readBaseOperatorFee(client as never, 21_000n, 123n)).resolves.toBe(42n);
    expect(calls[0]).toMatchObject({ functionName: 'getOperatorFee', args: [21_000n], blockNumber: 123n });
  });
});
