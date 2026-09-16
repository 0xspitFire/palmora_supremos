import { describe, expect, it } from 'vitest';
import { ROBINHOOD_EXTERNAL_FAILED_HASHES_ARE_FLEET_EVIDENCE, ROBINHOOD_SEADROP_POSITIVE_FIXTURE } from './robinhood-evidence.js';

describe('Robinhood positive SeaDrop evidence', () => {
  it('keeps the Product Owner supplied successful mint as a positive fixture', () => {
    expect(ROBINHOOD_SEADROP_POSITIVE_FIXTURE.chainId).toBe(4663);
    expect(ROBINHOOD_SEADROP_POSITIVE_FIXTURE.receiptStatus).toBe('success');
    expect(ROBINHOOD_SEADROP_POSITIVE_FIXTURE.tokenId).toBe(517n);
    expect(ROBINHOOD_SEADROP_POSITIVE_FIXTURE.quantity).toBe(1);
    expect(ROBINHOOD_SEADROP_POSITIVE_FIXTURE.transactionType).toBe('mintSigned');
    expect(ROBINHOOD_SEADROP_POSITIVE_FIXTURE.mintAmountWei).toBe(0n);
    expect(ROBINHOOD_SEADROP_POSITIVE_FIXTURE.source).toContain('Product Owner');
    expect(ROBINHOOD_SEADROP_POSITIVE_FIXTURE.provenance).toContain('Robinhood 4663');
  });

  it('does not treat external failed hashes as fleet evidence', () => {
    expect(ROBINHOOD_EXTERNAL_FAILED_HASHES_ARE_FLEET_EVIDENCE).toBe(false);
  });
});
