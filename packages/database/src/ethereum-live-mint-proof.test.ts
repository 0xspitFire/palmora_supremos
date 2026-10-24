import { describe, expect, it } from 'vitest';
import { openDatabase } from './database.js';
import { DurableRepository, type EthereumLiveMintProofInput } from './repositories.js';

/** T-062 (D-064): the imported Ethereum mint proof is complete, exactly shaped, and can never change. */
const row = (overrides: Partial<EthereumLiveMintProofInput> = {}): EthereumLiveMintProofInput => ({
  id: 'proof-1',
  txHash: `0x${'1'.repeat(64)}`,
  blockNumber: '26227572',
  blockHash: `0x${'ab'.repeat(32)}`,
  seadropAddress: '0x00005ea00ac477b1030ce78506496e8c2de24bf5',
  nftContract: '0xa686fde3299d5451af22382240e0dff62f7b94db',
  callSelector: '0x161ac21f',
  evidenceReference: 'Docs/phase3-first-live-evidence.md',
  approvedAt: '2026-10-24T12:00:00.000Z',
  confirmationDigest: 'c'.repeat(64),
  ...overrides,
});

describe('Ethereum live mint proof rows (migration 034)', () => {
  it('records rows together, lists them, and says a proof exists', () => {
    const repository = new DurableRepository(openDatabase());
    expect(repository.hasEthereumLiveMintProof()).toBe(false);
    repository.recordEthereumLiveMintProofs([row(), row({ id: 'proof-2', txHash: `0x${'2'.repeat(64)}` })]);
    expect(repository.hasEthereumLiveMintProof()).toBe(true);
    expect(repository.ethereumLiveMintProofs().map((item) => item.id)).toEqual(['proof-1', 'proof-2']);
  });

  it('refuses anything incomplete or differently shaped, and a failed batch writes nothing (fail closed)', () => {
    const repository = new DurableRepository(openDatabase());
    for (const bad of [
      row({ txHash: '0x12' }), row({ txHash: `0x${'G'.repeat(64)}` }), row({ txHash: `0x${'A'.repeat(64)}` }),
      row({ blockNumber: '0' }), row({ blockNumber: '12x' }), row({ blockHash: '0x12' }),
      row({ seadropAddress: '0x1111111111111111111111111111111111111111' }), row({ callSelector: '0xdeadbeef' }),
      row({ nftContract: '0x12' }), row({ evidenceReference: 'x' }), row({ evidenceReference: 'x'.repeat(301) }),
      row({ approvedAt: 'not a date' }), row({ confirmationDigest: 'z'.repeat(64) }), row({ confirmationDigest: 'a'.repeat(63) }),
    ]) expect(() => repository.recordEthereumLiveMintProofs([bad]), JSON.stringify(bad)).toThrow();
    expect(() => repository.recordEthereumLiveMintProofs([])).toThrow('ETHEREUM_PROOF_EMPTY');
    expect(() => repository.recordEthereumLiveMintProofs([row(), row({ id: 'proof-2', callSelector: '0xdeadbeef' })])).toThrow();
    expect(repository.hasEthereumLiveMintProof()).toBe(false);
  });

  it('the same transaction cannot be recorded twice, and rows can never be changed or deleted', () => {
    const db = openDatabase();
    const repository = new DurableRepository(db);
    repository.recordEthereumLiveMintProofs([row()]);
    expect(() => repository.recordEthereumLiveMintProofs([row({ id: 'proof-9' })])).toThrow();
    expect(() => db.prepare("UPDATE ethereum_live_mint_proof SET evidence_reference = 'something else'").run()).toThrow(/immutable/);
    expect(() => db.prepare('DELETE FROM ethereum_live_mint_proof').run()).toThrow(/immutable/);
    expect(repository.ethereumLiveMintProofs()).toHaveLength(1);
  });
});
