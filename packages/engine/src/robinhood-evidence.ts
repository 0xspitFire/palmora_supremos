import type { Address, Hash } from 'viem';

/** Positive fixture supplied by the Product Owner; external failed hashes are excluded. */
export const ROBINHOOD_SEADROP_POSITIVE_FIXTURE = {
  chainId: 4663 as const,
  txHash: '0xf24e0c85f6f4fa71d012b6ffbfbc871b901fb1e949635799d1821716013d891e' as Hash,
  nftContract: '0x45ce024f314a2f74c63a8a51743677df97a8d99e' as Address,
  wallet: '0x81c104DcB898416FD4f81eAd091DbA5b8f46F37A' as Address,
  tokenId: 3477n,
  quantity: 1,
  receiptStatus: 'success' as const,
  source: 'Product Owner supplied live transaction evidence' as const,
  provenance: 'Approved wallet -> SeaDrop v1 public mint -> Robinhood 4663 receipt' as const,
} as const;

/** External failed transaction hashes are documentation/revert references only. */
export const ROBINHOOD_EXTERNAL_FAILED_HASHES_ARE_FLEET_EVIDENCE = false as const;
