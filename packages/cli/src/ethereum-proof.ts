import { createHash } from 'node:crypto';
import type { EthereumLiveMintProofInput } from '@mint-bot/database';
import { SEADROP_V1_ADDRESS } from '@mint-bot/engine';

/**
 * T-062 (D-064, owner-approved 2026-10-24): `ethereum-proof`. Robinhood may only be switched on after one live Ethereum mint
 * worked (D-040 item 6), judged from the database the service uses. A host database that never ran an Ethereum mint itself can
 * instead hold the transactions of an earlier one, accepted only after this command has read EACH of them from Ethereum and
 * found it succeeded, finalized, and a SeaDrop v1 `mintPublic` call. The owner's typed confirmation then records them. This
 * proves a real Ethereum mint happened; it cannot prove the owner's own bot sent it, and says so. It enables nothing by itself.
 */
export const MINT_PUBLIC_SELECTOR = '0x161ac21f';
export const MAX_PROOF_TRANSACTIONS = 10;
const TX_HASH = /^0x[0-9a-f]{64}$/;

export interface ProofChainReader {
  getChainId(): Promise<number>;
  getTransaction(args: { hash: `0x${string}` }): Promise<{ to: string | null; input: string; blockNumber: bigint | null; blockHash: string | null }>;
  getTransactionReceipt(args: { hash: `0x${string}` }): Promise<{ status: string; to: string | null; blockNumber: bigint; blockHash: string }>;
  getBlock(args: { blockTag: 'finalized' }): Promise<{ number: bigint | null }>;
}

export interface VerifiedMint { txHash: string; blockNumber: string; blockHash: string; nftContract: string }

/** Reads one transaction from Ethereum and throws a plain error unless it is a successful, finalized SeaDrop v1 `mintPublic` call. */
export async function verifyEthereumMint(reader: ProofChainReader, hash: string, finalizedBlock: bigint): Promise<VerifiedMint> {
  if (!TX_HASH.test(hash)) throw new Error('TX_HASH_INVALID: a transaction hash is 0x and 64 letters or digits');
  const [tx, receipt] = await Promise.all([reader.getTransaction({ hash: hash as `0x${string}` }), reader.getTransactionReceipt({ hash: hash as `0x${string}` })]);
  if (receipt.status !== 'success') throw new Error('TX_NOT_SUCCESSFUL: that transaction failed on Ethereum');
  const seadrop = SEADROP_V1_ADDRESS.toLowerCase();
  if ((tx.to ?? '').toLowerCase() !== seadrop || (receipt.to ?? '').toLowerCase() !== seadrop) throw new Error('TX_NOT_SEADROP: that transaction was not sent to SeaDrop v1');
  const input = tx.input.toLowerCase();
  if (!input.startsWith(MINT_PUBLIC_SELECTOR) || input.length < 10 + 64) throw new Error('TX_NOT_PUBLIC_MINT: that transaction is not a SeaDrop public mint');
  const firstWord = input.slice(10, 74);
  if (!/^0{24}[0-9a-f]{40}$/.test(firstWord)) throw new Error('TX_NOT_PUBLIC_MINT: the NFT contract in that transaction is malformed');
  if (tx.blockNumber === null || tx.blockHash === null || tx.blockNumber !== receipt.blockNumber || tx.blockHash.toLowerCase() !== receipt.blockHash.toLowerCase()) throw new Error('TX_NOT_MINED: that transaction is not in a block yet');
  if (receipt.blockNumber > finalizedBlock) throw new Error('TX_NOT_FINAL: that transaction is not final yet; wait about 15 minutes and try again');
  return { txHash: hash, blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash.toLowerCase(), nftContract: `0x${firstWord.slice(24)}` };
}

const sorted = (hashes: readonly string[]): string[] => [...hashes].sort();

/** The phrase names how many transactions and which ones, so a phrase copied from another set does not match. */
export function proofPhrase(hashes: readonly string[]): string {
  return `IMPORT-ETHEREUM-PROOF ${hashes.length}-TX ${createHash('sha256').update(sorted(hashes).join(','), 'utf8').digest('hex').slice(0, 8)}`;
}

export function proofConfirmationDigest(phrase: string, hashes: readonly string[], evidenceReference: string): string {
  return createHash('sha256').update(`${phrase}\n${sorted(hashes).join(',')}\n${evidenceReference}`, 'utf8').digest('hex');
}

export interface EthereumProofStore {
  ethereumLiveMintProven(): boolean;
  ethereumLiveMintProofs(): EthereumLiveMintProofInput[];
  recordEthereumLiveMintProofs(rows: EthereumLiveMintProofInput[]): void;
}

function parseHashes(text: string | undefined): string[] {
  const hashes = (text ?? '').split(',').map((item) => item.trim().toLowerCase()).filter((item) => item.length > 0);
  if (hashes.length === 0) throw new Error('TX_REQUIRED: pass --tx 0x...,0x... (the transactions of the Ethereum mint)');
  if (hashes.length > MAX_PROOF_TRANSACTIONS) throw new Error(`TX_TOO_MANY: use at most ${MAX_PROOF_TRANSACTIONS} transactions`);
  if (new Set(hashes).size !== hashes.length) throw new Error('TX_DUPLICATE: give each transaction once');
  return hashes;
}

/** The whole `ethereum-proof` command after the chain reader and store exist. `status` only reads; `record` writes once, after every check. */
export async function runEthereumProof(input: {
  action: 'status' | 'record';
  txHashes: string | undefined;
  evidenceReference: string | undefined;
  confirm: string | undefined;
  now: Date;
  reader: ProofChainReader;
  store: EthereumProofStore;
  newId(): string;
}): Promise<Record<string, unknown>> {
  const hashes = parseHashes(input.txHashes);
  if ((await input.reader.getChainId()) !== 1) throw new Error('RPC_CHAIN_MISMATCH: that RPC is not Ethereum');
  const finalized = (await input.reader.getBlock({ blockTag: 'finalized' })).number;
  if (finalized === null) throw new Error('FINALIZED_BLOCK_UNAVAILABLE: Ethereum did not report a finalized block');
  const verified: VerifiedMint[] = [];
  const problems: Array<{ txHash: string; problem: string }> = [];
  for (const hash of hashes) {
    try { verified.push(await verifyEthereumMint(input.reader, hash, finalized)); }
    catch (error) { problems.push({ txHash: hash, problem: error instanceof Error ? error.message.split('\n')[0]!.slice(0, 200) : 'TX_CHECK_FAILED' }); }
  }
  const known = new Set(input.store.ethereumLiveMintProofs().map((row) => row.txHash));
  const already = hashes.filter((hash) => known.has(hash));
  const phrase = proofPhrase(hashes);
  const reference = input.evidenceReference?.trim();
  const referenceOk = reference !== undefined && reference.length >= 5 && reference.length <= 300;
  const ready = problems.length === 0 && already.length === 0 && referenceOk;
  if (input.action === 'status') {
    return {
      state: ready ? 'ReadyToRecord' : 'NotReady',
      message: ready ? 'Every transaction was read from Ethereum: successful, final, and a SeaDrop public mint. Recording stores them as the proof D-040 item 6 asks for. It cannot show that your own bot sent them; that is your statement. It enables nothing by itself.' : 'Not ready yet. Fix the items below.',
      alreadyProven: input.store.ethereumLiveMintProven(),
      verified: verified.map((item) => ({ txHash: item.txHash, block: item.blockNumber, nftContract: item.nftContract })),
      problems: [...problems, ...already.map((txHash) => ({ txHash, problem: 'ALREADY_RECORDED' })), ...(referenceOk ? [] : [{ txHash: '', problem: 'EVIDENCE_REFERENCE_REQUIRED: pass --evidence-reference "<where the evidence is, 5 to 300 characters>"' }])],
      ...(ready ? { copyThisToRecord: `ethereum-proof record --tx ${hashes.join(',')} --evidence-reference "${reference}" --confirm "${phrase}"` } : {}),
    };
  }
  if (problems.length > 0) throw new Error(`TX_CHECK_FAILED: ${problems[0]!.txHash.slice(0, 10)}…: ${problems[0]!.problem}`);
  if (already.length > 0) throw new Error('ALREADY_RECORDED: one of these transactions is already recorded');
  if (!referenceOk) throw new Error('EVIDENCE_REFERENCE_REQUIRED: pass --evidence-reference "<where the evidence is, 5 to 300 characters>"');
  if (input.confirm !== phrase) throw new Error('CONFIRMATION_PHRASE_MISMATCH: run ethereum-proof status and copy the phrase it prints exactly');
  const digest = proofConfirmationDigest(phrase, hashes, reference!);
  const approvedAt = input.now.toISOString();
  input.store.recordEthereumLiveMintProofs(verified.map((item) => ({ id: input.newId(), txHash: item.txHash, blockNumber: item.blockNumber, blockHash: item.blockHash, seadropAddress: SEADROP_V1_ADDRESS.toLowerCase(), nftContract: item.nftContract, callSelector: MINT_PUBLIC_SELECTOR, evidenceReference: reference!, approvedAt, confirmationDigest: digest })));
  return { state: 'Recorded', message: `${verified.length} Ethereum mint transaction(s) are recorded as the proof. Robinhood can now be recorded with robinhood-enable (it still needs its own evidence file and typed confirmation).`, recorded: verified.length, alreadyProven: input.store.ethereumLiveMintProven() };
}
