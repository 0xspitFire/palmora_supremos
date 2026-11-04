# Qualified free replication and project-published allowlists

Implemented in T-096. Installation does not grant a live release. D-017 evidence
recollection/acceptance is deferred until final production at the owner's request.
Existing evidence, custody, chain, funding, watcher, simulation, kill-switch,
rolling-cap and canonical reservation gates remain required for every live run.

## Runtime policy

The host discovers, qualifies, simulates and prepares a known SeaDrop strategy.
For a free mint it may submit an unattended request only when the latest
opportunity score is at least 70 and a configured watched wallet has actually
paid for its own successful mint in that collection. A Transfer to the watched
wallet is insufficient. Source receipts must match their canonical block, be at
least two blocks deep and no older than fifteen minutes. Signal/receipt validity
is checked again immediately before arm and execute. The old 0.8 score-confidence
threshold and proposed 30-day/100-sample graduation rule are superseded by the
owner's 2026-11-04 decision. Confidence is still reported by scoring.

Paid replications are prepared and simulated, then notify the owner with the
campaign ID and `/fire` as the next action. They never auto-fire. Scheduling a
paid replication cannot bypass that final approval.

Claims are durable and made before preparation. One automatic campaign per
chain/collection prevents repeated whale transactions, retries and process
restarts from creating duplicate spends. A crash or blocked preparation requires
operator inspection of `/requests` and `/runs`; it is never blindly retried.
Migration 038 binds automated requests to a free preparation event, its wallet
subset and fee ceiling, and keeps them unattended through restart.

## Final-production settings

Do not enable during development or install an unaccepted release for live use.
After the final release and owner acceptance, the service environment can use:

```text
MINT_BOT_REPLICATION_AUTOMATION=true
MINT_BOT_REPLICATION_MAX_FEE_GWEI=<existing approved fee ceiling>
MINT_BOT_REPLICATION_MAX_QUANTITY=1
MINT_BOT_ALLOWLIST_SOURCES_PATH=/etc/mint-bot/allowlist-sources.json
```

Host mode, enabled discovery, Telegram commands/alerts and the existing
production custody profile are required. Ethereum uses the connected discovery
service. Base/Robinhood get separate discovery workers only when their existing
chain evidence already permits execution. This never enables a chain. Fee and
quantity settings can only narrow existing chain/custody/spend limits. Default
quantity is one; the active fleet, drop and policy can reduce it further.

## Two independent sources of authority

1. A project-published artifact supplies each owner's wallet-specific proof and
   mint parameters. HTTPS origins must be explicitly approved; immutable IPFS or
   Arweave content is supported through its approved HTTPS gateway. The exact
   content is SHA-256 pinned. Never obtain another user's proof from copied calldata.
2. Two configured RPC endpoints must agree on the contract's Merkle root, fee
   recipient and block hash at a common settled block. A root outage,
   disagreement or stale block blocks proof qualification. Each wallet leaf is
   recomputed and verified against that root. Before sending, the known strategy
   reconstructs calldata for that wallet and simulates it.

Example **public, non-secret** source manifest (replace every placeholder):

```json
{
  "version": 1,
  "sources": [{
    "id": "project-stage-1",
    "chainId": 4663,
    "nftContract": "<NFT contract address>",
    "stageIndex": "1",
    "uri": "https://<project-public-host>/published-proofs.json",
    "approvedOrigin": "https://<project-public-host>",
    "contentDigest": "sha256:<SHA-256 of the exact published file>"
  }]
}
```

The artifact contains `entries` or a JSON array of entries, each with `address`,
`mintParams` and optional `proof` (32-byte hex nodes). Mint parameters are
`mintPrice`, `maxTotalMintableByWallet`, `startTime`, `endTime`, `dropStageIndex`,
`maxTokenSupplyForStage`, `feeBps` and boolean `restrictFeeRecipients`. Integers
should be decimal strings. A complete published list can rebuild the Merkle
tree; a partial artifact needs an explicit proof per included wallet. Different
price/stage parameters in one selected fleet are rejected; prepare separate
campaigns rather than silently assuming common eligibility.

Keep the manifest root-owned and service-readable on the host, without group or
world write permission. It is bounded to 1 MiB. Artifacts are bounded to 4 MiB;
redirects, URL credentials/query tokens and private/reserved network addresses
are rejected. DNS is pinned to the checked public IPv4 address for the HTTPS
request. Validated immutable bytes are cached; chain authority is always fresh.

An authenticated endpoint may name `credentialName` in the manifest. Its bearer
token belongs in the existing `SECRET_STORE_PATH` host store and never in the
manifest or chat. A provider that needs another authentication protocol or a
different response schema requires a reviewed adapter. There is no universal
third-party allowlist API or mandatory new subscription in this implementation.

## Allowlist execution and scheduling

An approved manifest installs `seadrop-v1-allowlist`. Guided preparation selects
the configured stage, checks owned-wallet eligibility, and keeps that strategy
on the campaign. Upcoming allowlist campaigns can be scheduled using `/schedule`;
the scheduler waits for opening and records fresh own-wallet simulations before
requesting execution. Free discovered replications use the same score/watched
rule as public FCFS. Owner-scheduled exact campaigns retain their explicit
advance authorization. Paid replication still requires final `/fire`.

Existing public-mint Turnkey families authorize only `mintPublic`; they do not
authorize `mintAllowList`. The owner must install a signed canonical policy
catalog record that authorizes the actual wallet-specific allowlist calldata
and existing fee envelope. The resolver only selects already signed matching
records and stops on no match or ambiguity. Because different wallets normally
have different proof bytes, a single exact public policy cannot authorize an
entire allowlist fleet. This integration step requires the chosen collection
and owned-wallet proofs; the runtime never administers Turnkey policies.

Server-signed and token-gated SeaDrop methods remain unsupported, with no blind
replay fallback. Contract-standard Merkle allowlists and public FCFS are the
implemented methods.

## Replay validation

```sh
corepack pnpm exec vitest run packages/engine/src/replication-replay.test.ts
corepack pnpm ops:ethereum-fork packages/engine/src/replication.fork.test.ts
```

The first command covers thirteen deterministic positive/negative fixtures,
including wallet binding, unsupported signed/Merkle source calldata, contract,
fee, value, quantity and fleet mismatches. Rejection of copied Merkle calldata
is intentional: own-wallet allowlist proofs take the separate verified path.
The second starts loopback Anvil at the existing pinned Ethereum archive fixture
and simulates three reconstructed wallet calls with `eth_call`. On 2026-11-04 it
passed with zero skips and zero broadcasts. These are regression/fork evidence,
not a live allowlist mint, profitability evidence or final D-017 certification.

## Owner inputs still required

1. Supply the chosen chain, NFT contract, stage and official project proof/list
   URL or published API documentation. Engineering then creates the exact
   manifest and obtains/pins its digest. A private API credential, if needed,
   is stored by the owner under its named host-secret entry.
2. Review the generated exact allowlist custody policy with the verified own
   proofs; approve its provider policy and sign/install the canonical record.
   No public-only policy is widened automatically.
3. At final production, install the reviewed release, collect/accept the new
   D-017 artifacts and complete release activation. Recollection stays deferred
   until that point.
