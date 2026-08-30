export interface FeeBudgetInput { totalFeeWei?: bigint; gasLimit?: bigint; baseFeeWei?: bigint; configuredPriorityFeeWei?: bigint; dataFeeWei?: bigint; priorityFeeMultiplier?: number; }
export function normalizeTotalFeeBudget(input: FeeBudgetInput): bigint {
  if (input.totalFeeWei !== undefined) { if (input.totalFeeWei < 0n) throw new Error('INVALID_TOTAL_FEE'); return input.totalFeeWei; }
  if (input.gasLimit === undefined || input.baseFeeWei === undefined || input.configuredPriorityFeeWei === undefined || input.dataFeeWei === undefined) throw new Error('AMBIGUOUS_TOTAL_FEE_BUDGET');
  if (input.gasLimit < 0n || input.baseFeeWei < 0n || input.configuredPriorityFeeWei < 0n || input.dataFeeWei < 0n) throw new Error('INVALID_TOTAL_FEE');
  const multiplier = input.priorityFeeMultiplier ?? 1;
  if (!Number.isSafeInteger(multiplier) || multiplier < 1) throw new Error('AMBIGUOUS_TOTAL_FEE_BUDGET');
  const priority = input.configuredPriorityFeeWei * BigInt(multiplier);
  return input.gasLimit * (input.baseFeeWei + priority) + input.dataFeeWei;
}
