import type { Address, Hash } from 'viem';

/** Authoritative FREE fixture independently verified against the approved archive fork. */
export const ROBINHOOD_SEADROP_POSITIVE_FIXTURE = {
  chainId: 4663 as const,
  txHash: '0x790edf4d04c66e3d3ea1e6ed9c2a81466962824159f247a95f1b3503c30ac158' as Hash,
  seaDropAddress: '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5' as Address,
  nftContract: '0x8572DC3c69Eb735C6Dccc1E89d087820e51361Af' as Address,
  wallet: '0xecc7bc61bf2eac93fd62d9e6bf7f57f3b497c58f' as Address,
  tokenId: 517n,
  quantity: 1,
  blockNumber: 0x3cc90a5n,
  mintAmountWei: 0n,
  transactionType: 'mintSigned' as const,
  signatureHexLength: 132,
  receiptStatus: 'success' as const,
  source: 'Product Owner supplied authoritative FREE archive transaction evidence' as const,
  provenance: 'Approved archive fork -> SeaDrop v1 signed FREE mint -> Robinhood 4663 receipt' as const,
} as const;

/** External failed transaction hashes are documentation/revert references only. */
export const ROBINHOOD_EXTERNAL_FAILED_HASHES_ARE_FLEET_EVIDENCE = false as const;
