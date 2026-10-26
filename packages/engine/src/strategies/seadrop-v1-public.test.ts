import { describe, expect, it, vi } from 'vitest';
import { OPENSEA_FEE_COLLECTOR } from '../chains.js';
import { buildSeaDropPublicMintCalldata, resolveSeaDropFeeRecipient } from './seadrop-v1-public.js';

const NFT = '0x1111111111111111111111111111111111111111' as const;
const RECIPIENT = '0x2222222222222222222222222222222222222222' as const;

describe('SeaDrop policy preparation primitives', () => {
  it('uses the public drop restriction and first on-chain allowed recipient', async () => {
    const readContract = vi.fn().mockResolvedValueOnce({ restrictFeeRecipients: true }).mockResolvedValueOnce([RECIPIENT]);
    await expect(resolveSeaDropFeeRecipient({ readContract } as never, NFT)).resolves.toBe(RECIPIENT);
    expect(readContract).toHaveBeenCalledTimes(2);
  });

  it('uses the canonical collector without reading the allow-list for unrestricted drops', async () => {
    const readContract = vi.fn().mockResolvedValue({ restrictFeeRecipients: false });
    await expect(resolveSeaDropFeeRecipient({ readContract } as never, NFT)).resolves.toBe(OPENSEA_FEE_COLLECTOR);
    expect(readContract).toHaveBeenCalledTimes(1);
  });

  it('builds stable calldata and rejects an invalid quantity', () => {
    expect(buildSeaDropPublicMintCalldata(NFT, RECIPIENT, 1)).toMatch(/^0x[0-9a-f]+$/);
    expect(() => buildSeaDropPublicMintCalldata(NFT, RECIPIENT, 0)).toThrow('INVALID_QUANTITY');
  });
});
