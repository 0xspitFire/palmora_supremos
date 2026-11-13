import { encodeFunctionData, parseAbi, parseGwei, zeroAddress, type Address, type Hex } from 'viem';
import { SEADROP_V1_ADDRESS, validateTurnkeyPolicyAst, type TurnkeyEnvironment, type TurnkeyWalletReference } from '@mint-bot/engine';

const ABI = parseAbi(['function mintPublic(address nftContract,address feeRecipient,address minterIfNotPayer,uint256 quantity)']);

export interface RobinhoodTurnkeyPolicyInput {
  environment: TurnkeyEnvironment;
  organizationId: string;
  userId: string;
  policyId: string;
  wallets: readonly TurnkeyWalletReference[];
  nftContract: Address;
  feeRecipient: Address;
  policyFamily?: boolean;
  allowlistFamily?: boolean;
  publicFamily?: boolean;
  signedFamily?: boolean;
  chainId?: 1 | 8453 | 4663;
  quantity: number;
  gasLimitMax: string;
  maxFeePerGasGwei: string;
  maxPriorityFeePerGasGwei: string;
}

/** Creates the exact policy or the approved bounded Robinhood policy family. */
export function robinhoodTurnkeyPolicy(input: RobinhoodTurnkeyPolicyInput) {
  if (!Number.isSafeInteger(input.quantity) || input.quantity < 1 || input.quantity > 15 || !/^(?:0|[1-9]\d*)$/.test(input.gasLimitMax)) throw new Error('TURNKEY_ROBINHOOD_POLICY_LIMIT_INVALID');
  if ([input.allowlistFamily, input.policyFamily, input.publicFamily, input.signedFamily].filter(Boolean).length > 1 || input.chainId !== undefined && ![1, 8453, 4663].includes(input.chainId) || !(input.allowlistFamily || input.publicFamily || input.signedFamily) && input.chainId !== undefined && input.chainId !== 4663) throw new Error('TURNKEY_POLICY_FAMILY_INVALID');
  const maxFee = parseGwei(input.maxFeePerGasGwei);
  const priorityFee = parseGwei(input.maxPriorityFeePerGasGwei);
  if (maxFee <= 0n || priorityFee < 0n || priorityFee > maxFee) throw new Error('TURNKEY_ROBINHOOD_POLICY_FEE_INVALID');
  const data = input.signedFamily ? '0x4b61cd6f' as Hex : input.allowlistFamily ? '0x4300a4e6' as Hex : input.policyFamily || input.publicFamily
    ? '0x161ac21f' as Hex
    : encodeFunctionData({ abi: ABI, functionName: 'mintPublic', args: [input.nftContract, input.feeRecipient, zeroAddress, BigInt(input.quantity)] });
  return validateTurnkeyPolicyAst({
    version: 1,
    effect: 'allow',
    scope: {
      provider: 'turnkey',
      environment: input.environment,
      organizationId: input.organizationId,
      userId: input.userId,
      policyId: input.policyId,
      keyIds: input.wallets.map((wallet) => wallet.signWith),
    },
    transaction: {
      chainId: input.allowlistFamily || input.publicFamily || input.signedFamily ? input.chainId ?? 4663 : 4663,
      from: input.wallets.map((wallet) => wallet.address),
      to: SEADROP_V1_ADDRESS,
      valueWei: '0',
      data,
      gasLimitMax: input.gasLimitMax,
      maxFeePerGasMax: maxFee.toString(),
      maxPriorityFeePerGasMax: priorityFee.toString(),
      accessList: [],
    },
    ...(input.signedFamily ? { family: { kind: 'seadrop-free-signed-v1' as const, maxQuantity: input.quantity } } : input.allowlistFamily ? { family: { kind: 'seadrop-free-allowlist-v1' as const, maxQuantity: input.quantity } } : input.publicFamily ? { family: { kind: 'seadrop-free-public-v1' as const, maxQuantity: input.quantity } } : input.policyFamily ? { family: { kind: 'robinhood-seadrop-public-v1' as const, maxQuantity: input.quantity } } : {}),
  });
}
