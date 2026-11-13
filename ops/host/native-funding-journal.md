# Funding worker private budget journal (T130)

Source proposal only; no production profile, journal, provider policy, hub, backup job or service is installed by this task. Keep funding off until the owner accepts the concrete separate hub, offline-signed funding record, Linux identities, budget profile and backup/recovery process after independent source review.

The broker's signed20-second IPC permit is insufficient to spend. The funding worker independently validates the current owner-signed policy and two-reader preparation, then uses its own SQLite journal to atomically reserve rolling24h principal AND worst-case fees, enforce chain/hub nonce uniqueness, and claim signing once. This database is not the canonical mint DB and runs no canonical migrations. A compromised broker admission key cannot edit this UID-private state or bypass its rolling caps. The worker UID itself remains trusted with its own journal and restricted provider credential.

## Root-owned profile and private paths

The root-owned public `funding-worker` profile adds three mandatory fields:

```json
{
  "workerUid": 2002,
  "brokerUid": 2001,
  "journalId": "OWNER_SELECTED_STABLE_UUID",
  "journalPath": "/var/lib/mintbot-funding/private/budget.sqlite"
}
```

These numeric IDs are placeholders, not selected treasury/account identities. Use the actual distinct nonroot worker and mint/broker UIDs; same/root identities fail. Use a dedicated IPC group, not the mint service secret group. The immediate journal directory must be worker-owned0700; the DB, WAL and SHM must be worker-owned0600 with one hard link and no symlink traversal. Ancestors must not be writable by another identity; a root-owned sticky directory is accepted as a safe temporary test ancestry. Prefer root-owned `/var/lib` ancestors in production. The mint/broker UID must neither traverse this private directory nor read or write these files. Add a mint-service `InaccessiblePaths=/var/lib/mintbot-funding/private` namespace barrier too. The isolated worker has no main DB path or shared canonical state mount.

Root creates the private directory, delivers the reviewed root-owned PUBLIC profile and owner-signed records, and installs the separate restricted SDK credential through the existing protected secret process. No credential value belongs in argv, chat, logs or this guide. `journalId` identifies one continuing budget history across source/policy upgrades. Do not change it to escape pending exposure. Preserve the old journal across hub/profile changes; per-chain rolling reservations remain counted.

## Explicit first installation and normal executable

Normal worker execution is now real and closed: only `--profile /absolute/root-owned/public-profile.json` is accepted, or no args with `MINT_BOT_FUNDING_WORKER_PROFILE_PATH` set. All other arguments fail with a fixed redacted code. The entry installs SIGINT/SIGTERM handling, stops the IPC server, drains active signing/persistence and bounded reconciliation, then closes SQLite. The future service unit must execute this actual entry as the separate worker UID:

```sh
node /opt/mintbot/releases/REVIEWED_RELEASE/packages/cli/dist/native-funding-worker.js --profile /etc/mintbot-funding/worker.json
```

A missing, empty, corrupt, wrong-identity or recovery-blocked journal makes NORMAL startup fail. It never auto-creates a new rolling window. First installation requires a separate explicit command and the SHA256 digest of the exact installed PUBLIC profile bytes:

```sh
node /opt/mintbot/releases/REVIEWED_RELEASE/packages/cli/dist/native-funding-worker.js --profile /etc/mintbot-funding/worker.json --initialize-journal --confirm 'INITIALIZE FUNDING JOURNAL sha256:ACTUAL_PROFILE_DIGEST'
```

Run that only for a genuinely new never-used hub/journal after the owner reviews the profile and accepts activation. The command exclusively creates a new file, stores the journal ID and initial profile digest, and performs no credential read, RPC, signing or transfer. It refuses an existing pathname/schema. It is not recovery: never delete a used journal and rerun initialization after loss, corruption or an ambiguous SDK response.

## Durable signing and reconciliation

The worker reserves and claims before calling the SDK. It validates the returned signed transaction against the exact intent, persists its hash, and marks it unknown before any bytes leave IPC. A lost response, expired permit or restart never frees a signing claim. Exact repeated IDs and reused chain/hub nonces cannot sign again. A failure after a signing claim retains the full reservation even if a transaction hash is unavailable. Only a provably unstarted reservation may be released.

All pending/ambiguous principal and worst-case fees count across midnight and rolling windows; stale pending exposure blocks further admission. Settled transactions count actual principal and chain fees for24h from settlement, conservatively covering delayed finality. A final reverted receipt charges its real fees and zero transferred principal. Two configured HTTPS readers must agree on the exact transaction/receipt/source hash and chain-specific finality. The portable observer reconfirms the source hash after awaited finality. Receipt absence, an unavailable provider or a pending tag never settles or releases anything.

The completion-driven reconciler runs every30seconds without overlap and examines at most8 records per pass, with20-second per-record receipt deadlines. It rotates through pending/recent settled records and samples older settled inclusions. Proved two-reader canonical-hash changes reopen the original reservation as unknown. This is bounded observation, not an assertion that every historical block is continuously monitored. Shutdown prevents new work and drains the current bounded observation and durable writes before SQLite closes. Source tests use only synthetic signatures, SQLite and fake readers.

## Consistent encrypted backup and blocked restore

Back up this journal separately from the canonical DB. A live-file copy without its WAL is not a backup. The database package provides these journal-specific APIs; they never open canonical migrations or secret files:

- `snapshotFundingWorkerJournal(source, destination, journalId)` uses SQLite's consistent backup API, verifies the private schema/ID and refuses an existing destination. Output starts0600; create it only in a worker-private0700 staging directory.
- `verifyFundingWorkerJournal(snapshot, journalId)` checks SQLite integrity, the exact private schema/marker and decoding of durable records using a READ-ONLY connection.
- `restoreFundingWorkerJournal(snapshot, freshDestination, journalId)` verifies the snapshot, installs without overwriting an existing destination, and ALWAYS marks the result `recovery-required`. Normal worker startup refuses it.

Use an owner-reviewed exporter running under the isolated worker/backup identity: take a consistent snapshot into that private staging directory, encrypt/authenticate it to the OWNER'S backup recipient with the existing approved off-host backup tooling, upload only ciphertext, then remove plaintext staging. Keep the decryption key offline. Record public journal ID, snapshot time, file digest and encrypted object/version reference. Test decryption and `verifyFundingWorkerJournal` on an isolated staging copy. Never give the mint service UID access merely to reuse its backup job. This task does not configure or claim a working off-host journal schedule; the owner must install and prove one before activation.

The canonical restore checker does not understand this four-table private journal; use the journal verifier. Stop the funding worker and keep signing disabled before restoring. Decrypt into an isolated0700 recovery directory, verify authenticated backup provenance and expected journal ID, use a NEW destination, and retain original/corrupt files as evidence. Do not overwrite an active DB or carry active WAL/SHM files into the destination.

Restoring an older snapshot does not establish that newer signed requests never existed. The restored state stays blocked: reconcile the complete intervening provider signing activity and independently verified chain receipts, preserve every unknown nonce/signature claim, and have the owner review the resulting full history before any separately reviewed recovery activation. Absence of receipts and elapsed24h are insufficient proof. The current helpers intentionally offer no “clear all”, “reset budget”, or automatic recovery activation. If complete recovery evidence cannot be obtained, funding remains off; do not reinitialize the same hub's accounting history.
