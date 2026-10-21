import { parseAbi, serializeTransaction, type PublicClient, type TransactionSerializableEIP1559 } from 'viem';

export const BASE_GAS_PRICE_ORACLE = '0x420000000000000000000000000000000000000F';
export const BASE_L1_BLOCK = '0x4200000000000000000000000000000000000015';
export const BASE_FEE_SAFETY_BPS = 12_000n;
const BPS = 10_000n;
const MAX_UINT256 = (1n << 256n) - 1n;

const GAS_PRICE_ORACLE_ABI = parseAbi([
  'function getL1FeeUpperBound(uint256 unsignedTxSize) view returns (uint256)',
  'function getOperatorFee(uint256 gasUsed) view returns (uint256)',
]);
const L1_BLOCK_ABI = parseAbi([
  'function operatorFeeScalar() view returns (uint32)',
  'function operatorFeeConstant() view returns (uint64)',
]);

export interface BaseFeeBound {
  readonly l1DataFeeWei: bigint;
  readonly operatorFeeWei: bigint;
  readonly totalWei: bigint;
  readonly unsignedTxSize: number;
  readonly operatorFeeScalar: bigint;
  readonly operatorFeeConstant: bigint;
}

export function baseOperatorFeeWei(gas: bigint, scalar: bigint, constant: bigint): bigint {
  if (gas < 0n || scalar < 0n || scalar > 0xffff_ffffn || constant < 0n || constant > 0xffff_ffff_ffff_ffffn) throw new Error('BASE_OPERATOR_FEE_MALFORMED');
  return gas * scalar / 1_000_000n + constant;
}

export function applyBaseFeeSafetyMargin(value: bigint): bigint {
  if (value < 0n) throw new Error('BASE_FEE_MALFORMED');
  return (value * BASE_FEE_SAFETY_BPS + BPS - 1n) / BPS;
}

/** Quotes Base-native non-L2 charges for the exact unsigned transaction shape. */
export async function quoteBaseFeeBound(client: PublicClient, tx: TransactionSerializableEIP1559): Promise<BaseFeeBound> {
  if (tx.chainId !== 8453 || tx.gas === undefined) throw new Error('BASE_FEE_QUOTE_CHAIN_MISMATCH');
  const unsignedTxSize = (serializeTransaction(tx).length - 2) / 2;
  const [l1Upper, operatorUpper, scalar, constant] = await Promise.all([
    client.readContract({ address: BASE_GAS_PRICE_ORACLE, abi: GAS_PRICE_ORACLE_ABI, functionName: 'getL1FeeUpperBound', args: [BigInt(unsignedTxSize)] }),
    client.readContract({ address: BASE_GAS_PRICE_ORACLE, abi: GAS_PRICE_ORACLE_ABI, functionName: 'getOperatorFee', args: [tx.gas] }),
    client.readContract({ address: BASE_L1_BLOCK, abi: L1_BLOCK_ABI, functionName: 'operatorFeeScalar' }),
    client.readContract({ address: BASE_L1_BLOCK, abi: L1_BLOCK_ABI, functionName: 'operatorFeeConstant' }),
  ]);
  if (typeof l1Upper !== 'bigint' || typeof operatorUpper !== 'bigint' || typeof scalar !== 'number' || typeof constant !== 'bigint') throw new Error('BASE_FEE_QUOTE_MALFORMED');
  const operatorFeeScalar = BigInt(scalar);
  const l1DataFeeWei = applyBaseFeeSafetyMargin(l1Upper);
  const operatorFeeWei = applyBaseFeeSafetyMargin(operatorUpper);
  return { l1DataFeeWei, operatorFeeWei, totalWei: l1DataFeeWei + operatorFeeWei, unsignedTxSize, operatorFeeScalar, operatorFeeConstant: constant };
}

export interface BaseReceiptFeeFields {
  /** Unknown-chain RPCs can expose EIP-2718 quantities as raw hex strings. */
  readonly l1Fee?: bigint | string;
  readonly l1DataFee?: bigint | string;
  readonly operatorFee?: bigint | string;
  readonly operatorFeeScalar?: bigint | number;
  readonly operatorFeeConstant?: bigint;
}

/** Returns complete observed receipt charges or refuses incomplete provider data. */
export async function readBaseOperatorFee(client: PublicClient, gasUsed: bigint, blockNumber?: bigint): Promise<bigint> {
  let value: unknown;
  try {
    value = await client.readContract({
      address: BASE_GAS_PRICE_ORACLE,
      abi: GAS_PRICE_ORACLE_ABI,
      functionName: 'getOperatorFee',
      args: [gasUsed],
      ...(blockNumber === undefined ? {} : { blockNumber }),
    });
  } catch { throw new Error('BASE_OPERATOR_FEE_ORACLE_UNAVAILABLE'); }
  if (typeof value !== 'bigint' || value < 0n) throw new Error('BASE_OPERATOR_FEE_ORACLE_MALFORMED');
  return value;
}

export function baseReceiptFees(fields: BaseReceiptFeeFields, _gasUsed: bigint, oracleOperatorFee?: bigint): { l1DataFeeWei: bigint; operatorFeeWei: bigint } {
  const normalize = (value: bigint | string | undefined, required: string, malformed: string): bigint => {
    if (value === undefined) throw new Error(required);
    if (typeof value === 'bigint') {
      if (value < 0n || value > MAX_UINT256) throw new Error(malformed);
      return value;
    }
    if (value.length > 66 || !/^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/i.test(value)) throw new Error(malformed);
    return BigInt(value);
  };
  if (fields.l1DataFee === undefined && fields.l1Fee === undefined) throw new Error('BASE_RECEIPT_L1_FEE_REQUIRED');
  const normalizedL1DataFee = fields.l1DataFee === undefined ? undefined : normalize(fields.l1DataFee, 'BASE_RECEIPT_L1_FEE_REQUIRED', 'BASE_RECEIPT_L1_FEE_MALFORMED');
  const normalizedL1Fee = fields.l1Fee === undefined ? undefined : normalize(fields.l1Fee, 'BASE_RECEIPT_L1_FEE_REQUIRED', 'BASE_RECEIPT_L1_FEE_MALFORMED');
  if (normalizedL1DataFee !== undefined && normalizedL1Fee !== undefined && normalizedL1DataFee !== normalizedL1Fee) throw new Error('BASE_RECEIPT_L1_FEE_MALFORMED');
  const l1DataFeeWei = normalizedL1DataFee ?? normalizedL1Fee!;
  const operatorFeeWei = normalize(fields.operatorFee ?? oracleOperatorFee, 'BASE_RECEIPT_OPERATOR_FEE_REQUIRED', 'BASE_RECEIPT_OPERATOR_FEE_MALFORMED');
  return { l1DataFeeWei, operatorFeeWei };
}
