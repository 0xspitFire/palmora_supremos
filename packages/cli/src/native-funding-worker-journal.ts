import { constants } from 'node:fs';
import { chmod, lstat, open } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { keccak256, type Hex } from 'viem';
import { openFundingWorkerJournal, initializeFundingWorkerJournal, type FundingWorkerJournal, type NativeFundingPolicy, type NativeFundingPreparation, type NativeFundingReceiptObservation, type NativeFundingRecord, type NativeFundingCanonicalBlockObservation, type NativeFundingAuthority } from '@mint-bot/database';
import { verifyFundingAdmission, fundingWireIntent, type FundingAdmission } from './native-funding-ipc.js';
import { assertSignedMatchesIntent, type TransactionIntent } from '@mint-bot/engine';

export async function assertPrivateFundingJournalPath(path: string, workerUid: number): Promise<void> {
  if (!isAbsolute(path) || resolve(path) !== path || workerUid <= 0 || process.geteuid?.() !== workerUid) throw new Error('NATIVE_FUNDING_JOURNAL_PERMISSIONS_REQUIRED');
  let current = dirname(path); const direct = current;
  for (;;) {
    const info = await lstat(current);
    const stickyRoot = info.uid === 0 && (info.mode & 0o1000) !== 0;
    if (!info.isDirectory() || info.isSymbolicLink() || ![0, workerUid].includes(info.uid) || !stickyRoot && (info.mode & 0o022) !== 0 || current === direct && (info.uid !== workerUid || (info.mode & 0o7777) !== 0o700)) throw new Error('NATIVE_FUNDING_JOURNAL_PERMISSIONS_REQUIRED');
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
  for (const suffix of ['', '-wal', '-shm']) {
    const file = await lstat(path + suffix).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? undefined : Promise.reject(error));
    if (file && (!file.isFile() || file.isSymbolicLink() || file.uid !== workerUid || (file.mode & 0o7777) !== 0o600 || file.nlink !== 1)) throw new Error('NATIVE_FUNDING_JOURNAL_PERMISSIONS_REQUIRED');
  }
}
/** Creates only a worker-owned private file, never canonical DB migrations. */
export async function createPrivateFundingJournal(path: string, workerUid: number, authority: Parameters<typeof openFundingWorkerJournal>[1], journalId: string, initialize?: { profileDigest: string }): Promise<FundingWorkerJournal> {
  await assertPrivateFundingJournalPath(path, workerUid);
  if (initialize) { const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); await file.close(); }
  const journal = initialize ? initializeFundingWorkerJournal(path, authority, journalId, initialize.profileDigest) : openFundingWorkerJournal(path, authority, journalId);
  try {
    for (const suffix of ['', '-wal', '-shm']) await chmod(path + suffix, 0o600).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    await assertPrivateFundingJournalPath(path, workerUid); return journal;
  } catch (error) { journal.close(); throw error; }
}
const encode = (value: unknown) => JSON.stringify(value, (_key, entry: unknown) => typeof entry === 'bigint' ? entry.toString() : entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.fromEntries(Object.entries(entry).sort(([left], [right]) => left.localeCompare(right))) : entry);
export interface WorkerFundingContext { admission: FundingAdmission; intent: TransactionIntent; policy: NativeFundingPolicy; preparation: NativeFundingPreparation; }
export interface FundingBudgetJournal {
  sign(context: WorkerFundingContext, signer: (assertCurrent: () => Promise<void>) => Promise<Hex>, assertCurrent: () => Promise<void>): Promise<Hex>;
  reconcile(): Promise<void>; close(): Promise<void>;
}
/** Broker permits identify a request; this journal alone owns its rolling-cap admission and single signing claim. */
export async function createFundingBudgetJournal(options: {
  openJournal(authority: NativeFundingAuthority): FundingWorkerJournal | Promise<FundingWorkerJournal>; brokerPublicKey: string;
  currentPolicy(recordDigest: string): NativeFundingPolicy;
  receipts(record: NativeFundingRecord): Promise<readonly NativeFundingReceiptObservation[]>;
  canonicalBlocks(record: NativeFundingRecord): Promise<readonly NativeFundingCanonicalBlockObservation[]>;
  now?: () => Date; maxReconcile?: number;
}): Promise<FundingBudgetJournal> {
  const now = options.now ?? (() => new Date()); const limit = options.maxReconcile ?? 8;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32) throw new Error('NATIVE_FUNDING_JOURNAL_CONFIG_INVALID');
  let cursor = 0; let oldCursor = 0; let reconciling: Promise<void> | undefined; let closed = false;
  const leases = new Map<string, WorkerFundingContext>();
  const journal = await options.openJournal({ assertCurrent(request, policy, preparation) {
    const lease = leases.get(request.id);
    if (!lease) throw new Error('NATIVE_FUNDING_JOURNAL_PERMIT_REQUIRED');
    const { admission, intent } = lease;
    verifyFundingAdmission(admission, admission.payload.challenge, options.brokerPublicKey, now());
    if (encode(options.currentPolicy(policy.recordDigest)) !== encode(policy) || encode(lease.policy) !== encode(policy) || encode(lease.preparation) !== encode(preparation) || request.id !== admission.payload.requestId || request.idempotencyKey !== admission.payload.requestId || request.parentHoldId !== admission.payload.parentHoldId || request.parentRunId !== admission.payload.parentHoldId || request.parentHoldDigest !== admission.payload.parentHoldDigest || request.chainId !== intent.chainId || request.recipient.toLowerCase() !== intent.to.toLowerCase() || request.requiredBalanceWei !== preparation.recipientBalanceWei + intent.value || request.expiresAt !== admission.payload.expiresAt || preparation.hub.toLowerCase() !== intent.from.toLowerCase() || preparation.valueWei !== intent.value || preparation.nonce !== intent.nonce || preparation.gasLimit !== intent.gasLimit || preparation.maxFeePerGas !== intent.maxFeePerGas || preparation.maxPriorityFeePerGas !== intent.maxPriorityFeePerGas) throw new Error('NATIVE_FUNDING_JOURNAL_BINDING_INVALID');
  } });
  const repository = journal.repository;
  return {
    async sign(context, signer, assertCurrent) {
      if (closed) throw new Error('NATIVE_FUNDING_JOURNAL_CLOSED');
      const { admission, intent, preparation, policy } = structuredClone(context);
      verifyFundingAdmission(admission, admission.payload.challenge, options.brokerPublicKey, now());
      if (encode(options.currentPolicy(policy.recordDigest)) !== encode(policy)) throw new Error('NATIVE_FUNDING_JOURNAL_POLICY_CHANGED');
      const permitIntent = verifyFundingAdmission(admission, admission.payload.challenge, options.brokerPublicKey, now());
      if (encode(fundingWireIntent(permitIntent)) !== encode(fundingWireIntent(intent))) throw new Error('NATIVE_FUNDING_JOURNAL_INTENT_MISMATCH');
      await assertCurrent();
      // Repeated IDs/nonces fail closed across socket reconnects and process restarts; signed bytes are never regenerated.
      if (repository.get(admission.payload.requestId)) throw new Error('NATIVE_FUNDING_JOURNAL_ALREADY_CLAIMED');
      const request = { id: admission.payload.requestId, idempotencyKey: admission.payload.requestId, parentRunId: admission.payload.parentHoldId, parentHoldId: admission.payload.parentHoldId, parentHoldDigest: admission.payload.parentHoldDigest, chainId: intent.chainId, recipient: intent.to, requiredBalanceWei: preparation.recipientBalanceWei + intent.value, expiresAt: admission.payload.expiresAt };
      if (leases.has(request.id)) throw new Error('NATIVE_FUNDING_JOURNAL_ALREADY_CLAIMED');
      leases.set(request.id, { admission, intent, preparation, policy });
      try { repository.admit(request, preparation, policy, now()); repository.claimForSigning(request.id, now()); }
      catch (error) { if (repository.get(request.id)?.state === 'reserved') repository.releaseUnstarted(request.id, now()); leases.delete(request.id); throw error; }
      const reconfirm = async () => {
        await assertCurrent(); verifyFundingAdmission(admission, admission.payload.challenge, options.brokerPublicKey, now());
        if (encode(options.currentPolicy(policy.recordDigest)) !== encode(policy)) throw new Error('NATIVE_FUNDING_JOURNAL_POLICY_CHANGED');
        repository.reconfirm(request.id, now());
      };
      try {
        await reconfirm(); const raw = await signer(reconfirm);
        assertSignedMatchesIntent(raw, intent);
        // No delivery inference: persist a known hash as ambiguous BEFORE IPC can return any usable bytes.
        repository.markSigned(request.id, keccak256(raw), now()); repository.markBroadcasting(request.id, now());
        await reconfirm(); return raw;
      } catch (error) { const row = repository.get(request.id); if (row && ['signing', 'signed', 'submitted', 'unknown'].includes(row.state)) repository.retainUnknown(request.id, now()); throw error; }
      finally { leases.delete(request.id); }
    },
    async reconcile() {
      if (closed || reconciling) return reconciling;
      reconciling = (async () => {
        const all = journal.records().filter(row => row.state === 'settled' && row.receipt || !!row.transactionHash);
        const records = all.filter(row => row.state !== 'settled' || Date.parse(row.settledAt ?? row.createdAt) >= now().getTime() - 86_400_000);
        const older = all.filter(row => row.state === 'settled' && Date.parse(row.settledAt ?? row.createdAt) < now().getTime() - 86_400_000);
        if (!records.length && !older.length) return;
        const currentLimit = Math.max(1, limit - (older.length && limit > 1 ? 1 : 0));
        const chosen = [...records.slice(cursor), ...records.slice(0, cursor)].slice(0, currentLimit); cursor = (cursor + chosen.length) % Math.max(1, records.length);
        if (older.length && chosen.length < limit) chosen.push(older[oldCursor++ % older.length]!);
        for (const original of chosen) {
          if (closed) break;
          let row = repository.get(original.request.id)!;
          if (row.state === 'settled') {
            const blocks = await options.canonicalBlocks(row);
            if (blocks.length === 2 && blocks.every(block => block.blockHash.toLowerCase() !== row.receipt!.blockHash.toLowerCase())) { try { row = repository.reopenAfterReorg(row.request.id, blocks, now()); } catch { continue; } }
            else continue;
          }
          try { const receipts = await options.receipts(row); if (receipts.length === 2) repository.settle(row.request.id, receipts, now()); } catch { /* unknown stays fully charged; absence never releases */ }
        }
      })();
      try { await reconciling; } finally { reconciling = undefined; }
    },
    async close() { closed = true; await reconciling; journal.close(); },
  };
}
