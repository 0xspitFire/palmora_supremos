export interface FeeBudgetInput { totalFeeWei?: bigint; gasLimit?: bigint; gasPriceWei?: bigint; dataFeeWei?: bigint; priorityFeeMultiplier?: number; baseFeeWei?: bigint; }
export function normalizeTotalFeeBudget(input: FeeBudgetInput): bigint {
  if (input.totalFeeWei !== undefined) { if (input.totalFeeWei < 0n) throw new Error('INVALID_TOTAL_FEE'); return input.totalFeeWei; }
  if (input.gasLimit === undefined || input.gasPriceWei === undefined || input.dataFeeWei === undefined) throw new Error('AMBIGUOUS_TOTAL_FEE_BUDGET');
  if (input.gasLimit < 0n || input.gasPriceWei < 0n || input.dataFeeWei < 0n) throw new Error('INVALID_TOTAL_FEE');
  const multiplier = input.priorityFeeMultiplier ?? 1;
  if (!Number.isSafeInteger(multiplier) || multiplier < 1 || input.baseFeeWei === undefined) throw new Error('AMBIGUOUS_TOTAL_FEE_BUDGET');
  const priority = input.baseFeeWei * BigInt(multiplier);
  return input.gasLimit * (input.gasPriceWei + priority) + input.dataFeeWei;
}
