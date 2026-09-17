# Production Health Configuration

This is a non-secret DevOps handoff for the Phase 1 health gate. It defines the
configuration shape, safe defaults, human-owned values, and verification order.
It does not contain credentials or secret values.

## Native runtime

Run only from `/home/Junayd/W3/MintBot` or a managed worktree below it.

```text
Node.js: 20.19.1
pnpm: 9.15.4
Foundry/Anvil: 1.8.1
```

The process must start with the kill switch engaged and dry-run selected. A
failed or unknown health check blocks live admission.

## Required common variables

The host secret manager or service manager must inject these references without
printing their values:

```text
SECRET_STORE_PATH=/home/Junayd/W3/Rets/MINT_BOT_SECRETS.env
RPC_SECRET_NAMES=ETHEREUM_RPC_URL
STORE_PATH=/var/lib/mint-bot/mintbot.sqlite
KILL_SWITCH_PATH=/var/lib/mint-bot/kill-switch
RUNTIME_PROBE_TTL_MS=120000
SIGNER_HEALTH_URL=http://127.0.0.1:8787/health
```

`STORE_PATH` must point to an existing canonical normalized SQLite database
(schema version 15 or newer) with integrity, backup, and reconciliation
evidence. `KILL_SWITCH_PATH` must be managed by the service owner. The health
probe treats an engaged kill switch as not ready, so the service may only
disarm it after all other checks pass.
The probe reads normalized runtime and evidence tables; a legacy
`backend_state` table is not a valid live store.

`SIGNER_HEALTH_URL` is a required service boundary. A local encrypted signer
without a health endpoint is not sufficient for unattended production use.
KMS, HSM, or an explicitly approved host signer must own the final custody
decision.

## Turnkey signer profile

Turnkey is the approved remote-signer provider for the initial production
integration. It is accepted as HSM-equivalent secure-enclave custody for this
profile. The API private key is a secret and must be injected only by the host
secret manager. The organization, user, and wallet map are public metadata but
must still remain outside git.

```text
MINT_BOT_CUSTODY=turnkey
MINT_BOT_SECRET_ROOT=/home/Junayd/W3/Rets
TURNKEY_ORGANIZATION_ID=<host-configured>
TURNKEY_API_PUBLIC_KEY=<host-configured>
TURNKEY_API_PRIVATE_KEY=<secret-manager-only>
TURNKEY_USER_ID=<host-configured>
TURNKEY_WALLET_MAP_PATH=/home/Junayd/W3/Rets/turnkey-wallet-map.json
# Optional until Turnkey Verifiable Cloud waitlist access is granted.
TURNKEY_APP_NAME=<turnkey-verified-enclave-app-uuid>
TURNKEY_ATTESTATION_PATH=/home/Junayd/W3/Rets/turnkey-attestation.json
SIGNER_HEALTH_URL=http://127.0.0.1:8787/health
```

Start the supervised local signer health boundary only after the Turnkey
organization, policy, and wallet map exist:

```text
pnpm build
pnpm ops:turnkey-health
```

The wrapper checks Turnkey authentication and organization identity and returns
only public readiness metadata. It does not return private keys or sign a
transaction during health checks.

The Product Owner has temporarily waived cryptographic Boot/App Proof evidence
while Turnkey Verifiable Cloud access is pending. After Turnkey Verified is
enabled and `TURNKEY_APP_NAME` is configured, retrieve and verify the latest
Boot Proof against a completed signing activity:

```text
pnpm build
pnpm ops:turnkey-attestation
```

The resulting proof bundle is stored outside git with owner-only permissions.
The reference verifier checks the proof pair and does not by itself pin
Turnkey's PCR measurements; a stricter PCR/QOS acceptance policy remains a
Product Owner decision. The waiver is conditional and does not represent full
production attestation completion.
The current waiver record is retained outside git at
`/home/Junayd/W3/Rets/turnkey-attestation-waiver.json` with owner-only
permissions. It explicitly does not authorize live broadcasting.

## Local wallet import

For local dry-run testing only, existing `WALLET_ADD` and `ACC_KEY` env files can
be converted into the encrypted CLI keystore without putting key material in
the JSON metadata:

```text
node packages/cli/dist/index.js wallet import \
  --input-dir /home/Junayd/W3/Rets/wallets \
  --files w1.env,w2.env,w3.env \
  --output ./Rets/wallets/wallets.json
```

The command requires a hidden interactive passphrase, validates each derived
address, writes the AES-256-GCM file with owner-only permissions, and never
prints the private keys. The selected file order becomes wallet indices
`0..N-1`. This local keystore is not a substitute for KMS/HSM custody and must
not be used to claim production readiness.

The local testing waiver applies only to non-broadcast simulations. It does not
authorize live signing, broadcasting, or a production Phase 1 exit.

To migrate existing burner keys into Turnkey after the Product Owner has
created the organization, API key, and importing user, use the explicit
confirmation command below. The command sends only Turnkey-encrypted bundles;
it writes a public address/key-reference map and never writes plaintext keys.

```text
node packages/cli/dist/index.js wallet import-turnkey \
  --input-dir /home/Junayd/W3/Rets/wallets \
  --files w1.env,w2.env,w3.env \
  --policy-id <approved-turnkey-policy-id> \
  --confirm
```

The command is intentionally not run automatically. Importing a key into a
third-party signer is a custody change and cannot be rolled back by deleting
the local source files.

## Phase 1 Ethereum profile

Use this profile for the initial production health check. The secret file must
contain the approved Ethereum RPC name referenced by `RPC_SECRET_NAMES`.

```text
OPS_HEALTH_MODE=phase1
EXPECTED_CHAIN_ID=0x1
CHECK_ROBINHOOD=false
CHECK_FORK=false
```

Phase 1 remains dry-run until the Product Owner accepts the signer, reserve,
reconciliation, backup, and live-rehearsal evidence.

## Robinhood characterization profile

This profile is for chain and archive characterization only. It does not enable
Robinhood execution.

```text
OPS_HEALTH_MODE=robinhood
SECRET_STORE_PATH=/home/Junayd/W3/Rets/archive-rpc.env
RPC_SECRET_NAMES=ROBINHOOD_ARCHIVE_RPC
EXPECTED_CHAIN_ID=0x1237
CHECK_ROBINHOOD=true
CHECK_FORK=true
ARCHIVE_FORK_SECRET_NAME=ROBINHOOD_ARCHIVE_RPC
```

The archive RPC is read by reference from
`/home/Junayd/W3/Rets/archive-rpc.env`. Robinhood does not use a
`MINT_BOT_SECRETS_ROOT` variable. Fork launchers pass only loopback Anvil RPC
and non-secret fixture metadata to tests.

## Robinhood fixture inputs

The strict local replay requires these non-secret fixture values:

```text
ROBINHOOD_FORK_BLOCK
ANVIL_ROBINHOOD_RPC_URL
ROBINHOOD_SEADROP_NFT
ROBINHOOD_SEADROP_FEE_RECIPIENT
ROBINHOOD_SEADROP_MINT_VALUE_WEI
```

The launcher may also require `MINT_BOT_FIXTURE_ROOT` to point at the approved
fixture directory and `ANVIL_BIN` when the Foundry binary is not on PATH. These
are path/configuration references, not secrets.

## Human-owned decisions

- Choose the production secret-store file and approved RPC secret names.
- Choose the production SQLite and backup locations.
- Choose and approve the signer/KMS/HSM health endpoint and custody policy.
- For Turnkey, create the dedicated organization, API key, user, and restricted signing policy.
- Define kill-switch ownership, startup, disarm, incident, and rotation procedure.
- Approve confirmation depth, reconciliation freshness, spend caps, burner funding, and live-fire limits.
- Approve the Robinhood characterization fixture and archive block.
- Provide separate Ethereum and Robinhood RPC references through the secret mechanism.
- Approve the host account, service manager, backup retention, and restore owner.

## Verification order

Run from a clean native WSL checkout:

```bash
pnpm ops:environment
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm build
pnpm ops:secret-boundary
pnpm ops:negative-cases
pnpm ops:recovery-drill
```

For a configured host, run:

```bash
pnpm ops:health
```

For archive characterization, run the strict fork wrapper only after the
approved archive reference and non-secret fixture metadata are available:

```bash
pnpm ops:fork-replay
```

Record only redacted statuses, reason codes, schema versions, chain IDs,
fixture identifiers, and timestamps. Never record endpoint values, tokens,
private keys, passphrases, raw calldata, or raw transactions.

## Readiness rule

`ops:health` must return `status: ok` for the selected mode. Any failed or
unknown process, secret-store, RPC, migration, store, backup, kill-switch,
chain-verification, reconciliation, signer, finality, sequencer, feed, or fork
check blocks live admission. Health success still requires a separate Product
Owner approval for live spending and does not authorize paid Robinhood mints.
