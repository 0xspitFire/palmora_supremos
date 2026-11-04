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

Existing public-mint Turnkey families authorize only `mintPublic`. A separate
owner-approved `seadrop-free-allowlist-v1` family can authorize future free
`mintAllowList` calls for its signed chain, fleet, quantity and fee envelope.
The runtime selects only a matching installed signed record; it never creates
or administers provider policies. Exact allowlist records remain supported. A
signed family can group eligible free wallets into one fleet campaign. Exact
policy preparations remain wallet-specific. Paid mints require separate custody
authorization and the final operator approval; this family does not grant it. See
`free-allowlist-family.md` for the one-time setup and expiry/renewal boundary.

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

## Dynamic OpenSea resolution (T-097)

The host reuses its existing named `OPENSEA_API` secret to resolve discovered
contracts through the official contract-metadata endpoint and request mint data
for each fleet wallet through `/api/v2/drops/{slug}/mint`. No per-project manifest
or public full allowlist is required for this path, and no wallet login/JWT or
message-signing authority is added. Existing on-chain discovery/scoring supplies
the changing chain and collection; the adapter does not auto-enable a chain.

The response must identify the requested chain, SeaDrop target, NFT collection,
zero sponsored minter, quantity one and exact mint value. Only canonical
`mintAllowList` calldata is decoded; own-wallet proofs are independently verified
against two agreeing RPCs at a common recent block. Locally reconstructed calls
then pass the existing simulation, signed custody, admission and execution gates.
The builder requests one NFT to retrieve eligibility; final quantity remains
bounded by the verified allocation and existing mint limits.

Fixed API origin, no redirects, bounded streamed bodies, ten-second timeout,
serialized two-request-per-second pacing, in-flight deduplication and fifteen-
second bounded successful-response caching protect the read path. Chain authority
is always fresh. Rate limits/transient unavailability respect bounded Retry-After
without automatic request retries. API credentials and raw provider errors are
never persisted or printed.

An explicitly absent/unsupported OpenSea drop or public-stage response permits
the existing independent public-chain read. Authentication failures, unknown API
failures, invalid proofs and contradictory chain evidence never silently downgrade
an allowlist campaign. Explicit pinned project sources take precedence; they
remain a fallback for supported project-published proof formats.

Coverage: the documented mint-builder API supports ERC-721 SeaDrop V1, not every
NFT platform or contract. Robinhood API coverage is determined by actual API
responses, not inferred from the configured chain slug. The builder requires an
active stage and may refuse unfunded wallets; unavailable future-stage proofs
remain unavailable, not invented. Other platforms require documented adapters.

Public-only families cannot authorize allowlist calls. The owner approved the
separate bounded free-allowlist family (D-085). It takes effect only after its
reviewed release, provider policy, owner-signed record and bundle are installed.
Until then, already signed exact allowlist records remain mandatory.

Official contracts:
- https://docs.opensea.io/reference/build_drop_mint_transaction
- https://docs.opensea.io/reference/get_contract
- https://docs.opensea.io/docs/mint-from-a-drop

## Owner inputs still required

1. At final deployment verify that the existing OPENSEA_API entry permits Drops
   requests on the intended platform/chain. Do not send its value in chat. No
   fixed collection list is required. For platforms without a supported adapter,
   engineering needs their official API documentation; private credentials remain
   in named host-secret entries. Individual manual manifests are optional.
2. Review/create the bounded free-allowlist provider policy and owner-sign/install
   its canonical record once per enabled chain/fleet, following
   `free-allowlist-family.md`. Exact allowlist policies remain an option. No
   public-only policy is widened automatically.
3. At final production, install the reviewed release, collect/accept the new
   D-017 artifacts and complete release activation. Recollection stays deferred
   until that point.

## Optional D-081 fire lanes

The default remains simultaneous execution of the selected fleet. A trusted host
operator may optionally set `MINT_BOT_FIRE_LANES` to a JSON plan in the existing
service environment, then deploy/restart through the normal reviewed-release
procedure. Do not configure it from collection metadata or opportunity input.
For a ten-position fleet, an example is:

```json
{"version":1,"lanes":[{"positions":[0,2,4,6,8],"startOffsetMs":0},{"positions":[1,3,5,7,9],"startOffsetMs":100}]}
```

Positions are zero-based within each run's canonical selected wallet list, not
persistent wallet identities or absolute signer indexes. A smaller selected fleet
(for example, two paid wallets) uses only its covered positions; empty lanes are
omitted. The plan must cover a dense unique position range beginning at zero, up
to 100 positions. A run selecting more wallets than the plan covers is blocked.
Offsets must be whole milliseconds, nondecreasing between lanes, from zero to
30,000. Unknown fields, duplicate/sparse positions and transport overrides fail
closed. Every lane inherits the job's existing broadcast mode and fee limits.

The trusted adapter callback `fireLanesFor(campaignId, selection, mode)` may supply
a campaign-specific plan instead; the same exact fleet coverage validation applies.
Plans are copied per job. Preflight-skipped wallets are never added back. Delays
start before the existing per-wallet kill/chain/drop/simulation/reservation and
signing checks. Offsets schedule preparation starts, not guaranteed inclusion
blocks or exact broadcast timestamps. No setting was changed on production and
no new Telegram configuration screen is included.
