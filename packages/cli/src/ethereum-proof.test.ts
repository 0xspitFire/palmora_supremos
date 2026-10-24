import { describe, expect, it } from 'vitest';
import type { EthereumLiveMintProofInput } from '@mint-bot/database';
import { MINT_PUBLIC_SELECTOR, proofPhrase, runEthereumProof, verifyEthereumMint, type ProofChainReader } from './ethereum-proof.js';

/** T-062 (D-064): an imported Ethereum mint is accepted only after every transaction is checked on Ethereum. */
const SEADROP = '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5';
const NFT = 'a686fde3299d5451af22382240e0dff62f7b94db';
const hash = (n: number): string => `0x${n.toString(16).padStart(64, '0')}`;
const FROM = '0x1111111111111111111111111111111111111111';
const BLOCK_HASH = `0x${'ab'.repeat(32)}`;
const input = `${MINT_PUBLIC_SELECTOR}${'0'.repeat(24)}${NFT}${'0'.repeat(64 * 3)}`;

interface FakeTx { returnedHash?: string; returnedReceiptHash?: string; from?: string; to?: string | null; input?: string; blockNumber?: bigint | null; blockHash?: string | null; receiptStatus?: string; receiptTo?: string | null; receiptBlock?: bigint }
function reader(txs: Record<string, FakeTx>, options: { chainId?: number; finalized?: bigint | null } = {}): ProofChainReader {
  return {
    getChainId: async () => options.chainId ?? 1,
    getBlock: async () => ({ number: options.finalized === undefined ? 1_000n : options.finalized }),
    getTransaction: async ({ hash: h }) => { const t = txs[h]; if (!t) throw new Error('not found'); return { hash: t.returnedHash ?? h, from: t.from ?? FROM, to: t.to === undefined ? SEADROP : t.to, input: t.input ?? input, blockNumber: t.blockNumber === undefined ? 500n : t.blockNumber, blockHash: t.blockHash === undefined ? BLOCK_HASH : t.blockHash }; },
    getTransactionReceipt: async ({ hash: h }) => { const t = txs[h]; if (!t) throw new Error('not found'); return { transactionHash: t.returnedReceiptHash ?? h, status: t.receiptStatus ?? 'success', to: t.receiptTo === undefined ? SEADROP : t.receiptTo, blockNumber: t.receiptBlock ?? 500n, blockHash: BLOCK_HASH }; },
  };
}

function fakeStore() {
  const rows: EthereumLiveMintProofInput[] = [];
  return { rows, store: { ethereumLiveMintProven: () => rows.length > 0, ethereumLiveMintProofs: () => rows, recordEthereumLiveMintProofs: (more: EthereumLiveMintProofInput[]) => { rows.push(...more); } } };
}

const REFERENCE = 'Docs/phase3-first-live-evidence.md run 2026-10-19';
const run = (action: 'status' | 'record', txs: string | undefined, overrides: Partial<Parameters<typeof runEthereumProof>[0]> = {}) => {
  const { rows, store } = fakeStore();
  const call = (more: Partial<Parameters<typeof runEthereumProof>[0]> = {}) => runEthereumProof({ action, txHashes: txs, evidenceReference: REFERENCE, confirm: undefined, now: new Date('2026-10-24T12:00:00.000Z'), reader: reader({ [hash(1)]: {}, [hash(2)]: {} }), store, newId: () => `id_${rows.length}`, ...overrides, ...more });
  return { rows, call };
};

describe('checking one transaction on Ethereum', () => {
  it('accepts a successful, final SeaDrop v1 public mint and reads the NFT contract from it', async () => {
    await expect(verifyEthereumMint(reader({ [hash(1)]: {} }), hash(1), 1_000n)).resolves.toEqual({ txHash: hash(1), blockNumber: '500', blockHash: BLOCK_HASH, sender: FROM, nftContract: `0x${NFT}` });
  });

  it('refuses every other kind of transaction (fail closed)', async () => {
    const refuse = async (tx: FakeTx, code: string, finalized = 1_000n) => { await expect(verifyEthereumMint(reader({ [hash(1)]: tx }), hash(1), finalized, 0), code).rejects.toThrow(code); };
    await refuse({ receiptStatus: 'reverted' }, 'TX_NOT_SUCCESSFUL');
    await refuse({ returnedHash: hash(7) }, 'TX_MISMATCH');
    await refuse({ returnedReceiptHash: hash(7) }, 'TX_MISMATCH');
    await refuse({ from: '0x12' }, 'TX_MISMATCH');
    await refuse({ to: '0x1111111111111111111111111111111111111111' }, 'TX_NOT_SEADROP');
    await refuse({ receiptTo: '0x1111111111111111111111111111111111111111' }, 'TX_NOT_SEADROP');
    await refuse({ to: null }, 'TX_NOT_SEADROP');
    await refuse({ input: `0xdeadbeef${'0'.repeat(64)}` }, 'TX_NOT_PUBLIC_MINT');
    await refuse({ input: MINT_PUBLIC_SELECTOR }, 'TX_NOT_PUBLIC_MINT');
    await refuse({ input: `${MINT_PUBLIC_SELECTOR}${'f'.repeat(64)}` }, 'TX_NOT_PUBLIC_MINT');
    await refuse({ blockNumber: null }, 'TX_NOT_MINED');
    await refuse({ blockHash: `0x${'cd'.repeat(32)}` }, 'TX_NOT_MINED');
    await refuse({}, 'TX_NOT_FINAL', 499n);
    await expect(verifyEthereumMint(reader({}), hash(9), 1_000n, 0)).rejects.toThrow();
    for (const bad of ['0x12', '12'.repeat(32), `0x${'AB'.repeat(32)}`]) await expect(verifyEthereumMint(reader({ [hash(1)]: {} }), bad, 1_000n), bad).rejects.toThrow('TX_HASH_INVALID');
  });
});

describe('a provider that sometimes answers "not found"', () => {
  it('is asked again, and a transaction that never appears is still refused', async () => {
    const flaky = (failures: number): ProofChainReader => { let left = failures; const base = reader({ [hash(1)]: {} }); return { ...base, getTransactionReceipt: async (args) => { if (left-- > 0) throw new Error('receipt not found'); return base.getTransactionReceipt(args); } }; };
    await expect(verifyEthereumMint(flaky(2), hash(1), 1_000n, 0)).resolves.toMatchObject({ txHash: hash(1) });
    await expect(verifyEthereumMint(flaky(10), hash(1), 1_000n, 0)).rejects.toThrow('receipt not found');
  });
});

describe('ethereum-proof command', () => {
  it('status only reads: it prints the phrase and records nothing', async () => {
    const { rows, call } = run('status', `${hash(1)},${hash(2)}`);
    const result = await call();
    expect(result).toMatchObject({ state: 'ReadyToRecord', alreadyProven: false, senders: [FROM] });
    expect(String(result.copyThisToRecord)).toContain(proofPhrase([hash(1), hash(2)], REFERENCE));
    expect(rows).toEqual([]);
  });

  it('record writes one row per transaction, only with the exact phrase and a reference', async () => {
    const { rows, call } = run('record', `${hash(1)},${hash(2)}`);
    await expect(call()).rejects.toThrow('CONFIRMATION_PHRASE_MISMATCH');
    await expect(call({ confirm: proofPhrase([hash(1)], REFERENCE) })).rejects.toThrow('CONFIRMATION_PHRASE_MISMATCH');
    await expect(call({ confirm: proofPhrase([hash(1), hash(2)], REFERENCE), evidenceReference: 'x' })).rejects.toThrow('EVIDENCE_REFERENCE_REQUIRED');
    expect(rows).toEqual([]);
    const result = await call({ confirm: proofPhrase([hash(2), hash(1)], REFERENCE) });
    expect(result).toMatchObject({ state: 'Recorded', recorded: 2, alreadyProven: true });
    expect(rows.map((row) => row.txHash).sort()).toEqual([hash(1), hash(2)]);
    expect(rows[0]).toMatchObject({ sender: FROM, seadropAddress: SEADROP.toLowerCase(), callSelector: '0x161ac21f', nftContract: `0x${NFT}`, evidenceReference: 'Docs/phase3-first-live-evidence.md run 2026-10-19' });
    expect(rows[0]!.confirmationDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('one bad transaction records nothing at all (fail closed)', async () => {
    const { rows, call } = run('record', `${hash(1)},${hash(3)}`, { reader: reader({ [hash(1)]: {}, [hash(3)]: { receiptStatus: 'reverted' } }) });
    await expect(call({ confirm: proofPhrase([hash(1), hash(3)], REFERENCE) })).rejects.toThrow('TX_CHECK_FAILED');
    expect(rows).toEqual([]);
    expect(await call({ action: 'status' })).toMatchObject({ state: 'NotReady', verified: [{ txHash: hash(1) }], problems: [{ txHash: hash(3), problem: expect.stringContaining('TX_NOT_SUCCESSFUL') }] });
  });

  it('refuses another chain, a transaction not yet final, a repeated or recorded transaction, and bad input', async () => {
    await expect(run('status', hash(1), { reader: reader({ [hash(1)]: {} }, { chainId: 8453 }) }).call()).rejects.toThrow('RPC_CHAIN_MISMATCH');
    await expect(run('status', hash(1), { reader: reader({ [hash(1)]: {} }, { finalized: null }) }).call()).rejects.toThrow('FINALIZED_BLOCK_UNAVAILABLE');
    expect(await run('status', hash(1), { reader: reader({ [hash(1)]: {} }, { finalized: 10n }) }).call()).toMatchObject({ state: 'NotReady', problems: [{ problem: expect.stringContaining('TX_NOT_FINAL') }] });
    await expect(run('status', `${hash(1)},${hash(1)}`).call()).rejects.toThrow('TX_DUPLICATE');
    await expect(run('status', undefined).call()).rejects.toThrow('TX_REQUIRED');
    await expect(run('status', Array.from({ length: 11 }, (_, i) => hash(i + 1)).join(',')).call()).rejects.toThrow('TX_TOO_MANY');
    const { rows, call } = run('record', hash(1));
    await call({ confirm: proofPhrase([hash(1)], REFERENCE) });
    expect(rows).toHaveLength(1);
    await expect(call({ confirm: proofPhrase([hash(1)], REFERENCE) })).rejects.toThrow('ALREADY_RECORDED');
  });

  it('the phrase depends on exactly which transactions are named, in any order', () => {
    expect(proofPhrase([hash(1), hash(2)], REFERENCE)).toBe(proofPhrase([hash(2), hash(1)], REFERENCE));
    expect(proofPhrase([hash(1), hash(2)], REFERENCE)).not.toBe(proofPhrase([hash(1), hash(3)], REFERENCE));
    expect(proofPhrase([hash(1)], REFERENCE)).not.toBe(proofPhrase([hash(1)], 'another reference'));
    expect(proofPhrase([hash(1)], REFERENCE)).toMatch(/^IMPORT-ETHEREUM-PROOF 1-TX [0-9a-f]{8}$/);
  });
});
