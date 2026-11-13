import { ContractFunctionRevertedError, ExecutionRevertedError, InsufficientFundsError, type Address, type PublicClient } from 'viem';
import { simulateMint } from './drop-reader.js';
import type { DropConfig, MintStrategy, SimulationEvidence } from './types.js';

/** Only explicit typed execution/funding failures may be isolated to one sender. */
export function walletEstimateFailure(error: unknown): string | undefined {
  let current: unknown = error;
  let failure: string | undefined;
  const seen = new Set<object>();
  for (let i = 0; i < 8 && current instanceof Error && !seen.has(current); i++) {
    seen.add(current);
    if (/timeout|timed out|rate.limit|unauthori[sz]ed|forbidden|connection|socket|network|fetch failed/i.test(current.message)) return undefined;
    if (current instanceof ContractFunctionRevertedError || current instanceof ExecutionRevertedError) failure = 'WALLET_ESTIMATE_REVERTED';
    if (current instanceof InsufficientFundsError) failure = 'WALLET_ESTIMATE_INSUFFICIENT_FUNDS';
    current = current.cause;
  }
  // A cause deeper than the inspection bound is unknown, even if an outer error looked local.
  if (current !== undefined) return undefined;
  return failure;
}

export async function prepareWalletSimulations(input: {
  wallets: readonly { index: number; address: Address }[];
  publicClient: PublicClient; strategy: MintStrategy; drop: DropConfig;
  quantity: number; value: bigint; padding: number; checkKill(): void; now(): Date;
}): Promise<{ gasLimits: Map<number, bigint>; simulations: Map<number, SimulationEvidence> }> {
  const gasLimits = new Map<number, bigint>();
  const simulations = new Map<number, SimulationEvidence>();
  for (const wallet of input.wallets) {
    input.checkKill();
    let estimate: bigint;
    try {
      estimate = await input.strategy.estimateGas(input.publicClient, input.drop, wallet.address, input.quantity);
    } catch (error) {
      input.checkKill();
      const failure = walletEstimateFailure(error);
      if (!failure) throw error;
      simulations.set(wallet.index, { walletIndex: wallet.index, address: wallet.address, sourceBlock: 0n, checkedAt: input.now(), success: false, error: failure });
      continue;
    }
    if (estimate <= 0n || !Number.isSafeInteger(Number(estimate)) || !Number.isFinite(input.padding) || input.padding < 1) throw new Error('INVALID_GAS_ESTIMATE');
    const padded = Math.ceil(Number(estimate) * input.padding);
    if (!Number.isSafeInteger(padded)) throw new Error('INVALID_GAS_ESTIMATE');
    gasLimits.set(wallet.index, BigInt(padded));
    const simulation = await simulateMint(input.publicClient, input.strategy, input.drop, wallet.address, input.quantity, input.value, wallet.index, input.now());
    input.checkKill();
    simulations.set(wallet.index, { ...simulation, gasEstimate: estimate });
  }
  return { gasLimits, simulations };
}
