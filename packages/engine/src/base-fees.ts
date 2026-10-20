import { parseAbi, serializeTransaction, type PublicClient, type TransactionSerializableEIP1559 } from 'viem';

export const BASE_GAS_PRICE_ORACLE = '0x420000000000000000000000000000000000000F';
export const BASE_L1_BLOCK = '0x4200000000000000000000000000000000000015';
export const BASE_FEE_SAFETY_BPS = 12_000n;
const BPS = 10_000n;

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
  readonly l1Fee?: bigint;
  readonly l1DataFee?: bigint;
  readonly operatorFee?: bigint;
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
  const l1DataFeeWei = fields.l1DataFee ?? fields.l1Fee;
  if (l1DataFeeWei === undefined || l1DataFeeWei < 0n) throw new Error('BASE_RECEIPT_L1_FEE_REQUIRED');
  const operatorFeeWei = fields.operatorFee ?? oracleOperatorFee;
  if (operatorFeeWei === undefined) throw new Error('BASE_RECEIPT_OPERATOR_FEE_REQUIRED');
  if (operatorFeeWei < 0n) throw new Error('BASE_RECEIPT_OPERATOR_FEE_MALFORMED');
  return { l1DataFeeWei, operatorFeeWei };
}
