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

`STORE_PATH` must point to an existing migrated SQLite database with integrity,
backup, and reconciliation evidence. `KILL_SWITCH_PATH` must be managed by the
service owner. The health probe treats an engaged kill switch as not ready, so
the service may only disarm it after all other checks pass.

`SIGNER_HEALTH_URL` is a required service boundary. A local encrypted signer
without a health endpoint is not sufficient for unattended production use.
KMS, HSM, or an explicitly approved host signer must own the final custody
decision.

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
