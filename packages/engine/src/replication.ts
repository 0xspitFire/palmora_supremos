import {
  decodeFunctionData,
  type Address,
  type Hash,
  type Hex,
  parseAbi,
  zeroAddress,
} from 'viem';
import type { DropConfig, SupportedChainId } from './types.js';
import { SEADROP_V1_ADDRESS } from './chains.js';
import { buildSeaDropPublicMintCalldata } from './strategies/seadrop-v1-public.js';

const SEADROP_PUBLIC_ABI = parseAbi([
  'function mintPublic(address nftContract,address feeRecipient,address minterIfNotPayer,uint256 quantity) payable',
]);

export type ReplicationReasonCode =
  | 'CHAIN_MISMATCH'
  | 'TARGET_NOT_SEADROP'
  | 'UNKNOWN_SELECTOR'
  | 'MALFORMED_CALLDATA'
  | 'CONTRACT_MISMATCH'
  | 'FEE_RECIPIENT_MISMATCH'
  | 'WALLET_BOUND_ARGUMENT'
  | 'INVALID_QUANTITY'
  | 'QUANTITY_EXCEEDS_DROP_LIMIT'
  | 'VALUE_MISMATCH'
  | 'NO_TARGET_WALLETS';

export interface ObservedMintTransaction {
  readonly chainId: SupportedChainId;
  readonly hash?: Hash;
  readonly from: Address;
  readonly to: Address;
  readonly value: bigint;
  readonly data: Hex;
  readonly gasLimit?: bigint;
  readonly maxFeePerGas?: bigint;
  readonly maxPriorityFeePerGas?: bigint;
  readonly observedAt?: string;
  readonly blockNumber?: bigint;
}

export interface ReplicationSource {
  readonly hash?: Hash;
  readonly from: Address;
  readonly chainId: SupportedChainId;
  readonly observedAt?: string;
  readonly blockNumber?: bigint;
}

export interface ReplicationTarget {
  readonly wallet: Address;
  readonly to: Address;
  readonly value: bigint;
  readonly data: Hex;
  readonly quantity: number;
}

export interface ReplicationChecklist {
  readonly knownStrategy: boolean;
  readonly chainMatches: boolean;
  readonly targetMatches: boolean;
  readonly selectorDecoded: boolean;
  readonly contractMatches: boolean;
  readonly feeRecipientMatches: boolean;
  readonly walletIndependent: boolean;
  readonly valueMatches: boolean;
  readonly quantityWithinDrop: boolean;
  readonly simulationRequired: true;
  readonly operatorApprovalRequired: true;
}

export interface ReplicationPlan {
  readonly version: 'replication-plan-v1';
  readonly verdict: 'replicable' | 'not_replicable';
  readonly strategy: 'seadrop-v1-public';
  readonly source: ReplicationSource;
  readonly observed: {
    readonly nftContract?: Address;
    readonly feeRecipient?: Address;
    readonly minterIfNotPayer?: Address;
    readonly quantity?: number;
  };
  readonly checklist: ReplicationChecklist;
  readonly reasons: readonly { code: ReplicationReasonCode; message: string }[];
  readonly targets: readonly ReplicationTarget[];
  /** A plan is never an execution authorization. */
  readonly operatorApprovalRequired: true;
  /** Every target must pass a fresh eth_call before promotion. */
  readonly simulationRequired: true;
}

const sameAddress = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

function validAddress(value: unknown): value is Address {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function uniqueTargets(wallets: readonly Address[]): Address[] {
  return [...new Map(wallets.map((wallet) => [wallet.toLowerCase(), wallet])).values()];
}

function reason(code: ReplicationReasonCode, message: string): { code: ReplicationReasonCode; message: string } {
  return { code, message };
}

/**
 * Decode and qualify an observed mint transaction without signing or sending.
 *
 * The first supported replication class is SeaDrop v1 public minting. It is
 * safe to reconstruct only when the observed call uses `minterIfNotPayer = 0`;
 * a non-zero value is wallet-bound and is therefore explicitly refused. The
 * returned targets still require simulation, the normal campaign gates, and
 * operator approval before they can become a campaign.
 */
export function buildReplicationPlan(input: {
  readonly observed: ObservedMintTransaction;
  readonly drop: DropConfig;
  readonly targetWallets: readonly Address[];
}): ReplicationPlan {
  const { observed, drop } = input;
  const source: ReplicationSource = {
    ...(observed.hash ? { hash: observed.hash } : {}),
    from: observed.from,
    chainId: observed.chainId,
    ...(observed.observedAt ? { observedAt: observed.observedAt } : {}),
    ...(observed.blockNumber !== undefined ? { blockNumber: observed.blockNumber } : {}),
  };
  const reasons: { code: ReplicationReasonCode; message: string }[] = [];
  const checklist = {
    knownStrategy: drop.strategyName === 'seadrop-v1-public',
    chainMatches: observed.chainId === drop.chainId,
    targetMatches: sameAddress(observed.to, drop.extra?.['seaDropAddress'] as string | undefined ?? SEADROP_V1_ADDRESS),
    selectorDecoded: false,
    contractMatches: false,
    feeRecipientMatches: false,
    walletIndependent: false,
    valueMatches: false,
    quantityWithinDrop: false,
    simulationRequired: true as const,
    operatorApprovalRequired: true as const,
  };

  if (!checklist.knownStrategy) reasons.push(reason('UNKNOWN_SELECTOR', `Strategy ${drop.strategyName} is not an approved replication strategy`));
  if (!checklist.chainMatches) reasons.push(reason('CHAIN_MISMATCH', `Observed chain ${observed.chainId} differs from drop chain ${drop.chainId}`));
  if (!checklist.targetMatches) reasons.push(reason('TARGET_NOT_SEADROP', 'Observed transaction target is not the configured SeaDrop singleton'));

  let nftContract: Address | undefined;
  let feeRecipient: Address | undefined;
  let minterIfNotPayer: Address | undefined;
  let quantity: number | undefined;
  if (observed.data.length < 10 || observed.data.slice(0, 10).toLowerCase() !== '0x161ac21f') {
    reasons.push(reason('UNKNOWN_SELECTOR', 'Observed calldata is not SeaDrop mintPublic'));
  } else {
    try {
      const decoded = decodeFunctionData({ abi: SEADROP_PUBLIC_ABI, data: observed.data });
      const args = decoded.args as readonly [Address, Address, Address, bigint];
      [nftContract, feeRecipient, minterIfNotPayer] = args;
      const rawQuantity = args[3];
      if (rawQuantity > BigInt(Number.MAX_SAFE_INTEGER)) quantity = undefined;
      else quantity = Number(rawQuantity);
      checklist.selectorDecoded = true;
    } catch {
      reasons.push(reason('MALFORMED_CALLDATA', 'SeaDrop selector was present but its arguments could not be decoded'));
    }
  }

  if (checklist.selectorDecoded) {
    checklist.contractMatches = Boolean(nftContract && sameAddress(nftContract, drop.nftContract));
    if (!checklist.contractMatches) reasons.push(reason('CONTRACT_MISMATCH', 'Observed NFT contract differs from the approved drop'));
    checklist.feeRecipientMatches = Boolean(feeRecipient && sameAddress(feeRecipient, drop.feePayer));
    if (!checklist.feeRecipientMatches) reasons.push(reason('FEE_RECIPIENT_MISMATCH', 'Observed fee recipient differs from the approved drop'));
    checklist.walletIndependent = Boolean(minterIfNotPayer && sameAddress(minterIfNotPayer, zeroAddress));
    if (!checklist.walletIndependent) reasons.push(reason('WALLET_BOUND_ARGUMENT', 'Observed calldata names a recipient wallet or proof-bound minter'));
    checklist.quantityWithinDrop = quantity !== undefined && Number.isSafeInteger(quantity) && quantity > 0;
    if (!checklist.quantityWithinDrop) reasons.push(reason('INVALID_QUANTITY', 'Observed quantity is not a positive safe integer'));
    else if (drop.maxTotalMintableByWallet > 0 && quantity! > drop.maxTotalMintableByWallet) {
      checklist.quantityWithinDrop = false;
      reasons.push(reason('QUANTITY_EXCEEDS_DROP_LIMIT', 'Observed quantity exceeds the drop per-wallet limit'));
    }
    checklist.valueMatches = quantity !== undefined && observed.value === drop.mintPrice * BigInt(quantity);
    if (!checklist.valueMatches) reasons.push(reason('VALUE_MISMATCH', 'Observed transaction value does not equal the drop price times quantity'));
  }

  const targets = checklist.selectorDecoded && reasons.length === 0
    ? uniqueTargets(input.targetWallets).filter(validAddress).map((wallet) => ({
      wallet,
      to: (drop.extra?.['seaDropAddress'] as Address | undefined) ?? SEADROP_V1_ADDRESS,
      value: drop.mintPrice * BigInt(quantity!),
      data: buildSeaDropPublicMintCalldata(drop.nftContract, drop.feePayer, quantity!),
      quantity: quantity!,
    }))
    : [];
  if (reasons.length === 0 && targets.length === 0) reasons.push(reason('NO_TARGET_WALLETS', 'No valid destination wallets were supplied'));

  return {
    version: 'replication-plan-v1',
    verdict: reasons.length === 0 ? 'replicable' : 'not_replicable',
    strategy: 'seadrop-v1-public',
    source,
    observed: {
      ...(nftContract ? { nftContract } : {}),
      ...(feeRecipient ? { feeRecipient } : {}),
      ...(minterIfNotPayer ? { minterIfNotPayer } : {}),
      ...(quantity !== undefined ? { quantity } : {}),
    },
    checklist,
    reasons,
    targets,
    operatorApprovalRequired: true,
    simulationRequired: true,
  };
}
