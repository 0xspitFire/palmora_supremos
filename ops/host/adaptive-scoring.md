# Bounded adaptive scoring — D-093

The development framework is separate from the installed static scoring model. It does not enable live adaptation merely because analytics reports exist. A new source release and an eligible first-model report require review before activation.

## Approved envelope

Each chain needs at least50 verified, fully costed realized outcomes across10 collections. Actual retained pre-outcome replication decisions supply the original factors; a historical trade is not rescored after its result is known. Latest20% (at least10 samples) is held out chronologically; training outcomes must be known before held-out decisions. Candidate validation must have positive net PnL and be no worse than the static baseline.

Weights cannot move more than20%, opportunity scores cannot move more than10 points, and model epochs expire within90days. Unknown costs, synthetic cases, reorged/conflicting facts and incomplete decision joins do not train a live model. Unchanged history does not renew an epoch. Missing/expired/revoked governance or invalid lineage uses static scoring; stale adaptive decisions cannot carry their uplift into funding or fire.

Score>=70, verified watched self-mint, free-only autonomous fire, current source/eligibility/simulation, custody, chain scope, caps and kill checks remain independent. Paid mints still require final owner fire approval. A profitable model cannot increase those limits.

## Initial profile and owner report

Engineering prepares a root-owned, nonservice-writable public JSON file selected by `MINT_BOT_ADAPTIVE_POLICY_PATH`. Its exact wrapper is `{ "version": "adaptive-policy-profile-v1", "policies": [...] }`. Each chain's `adaptive-governance-v1` record identifies D-093 and the owner approval digest, issue/expiry dates and the approved numeric envelope. The first concrete report must identify its profile digest and real sample lineage. Do not invent samples or install a profile with relaxed values to make a candidate eligible.

With the reviewed CLI and that profile installed, inspect the actual state:

```bash
node "$CLI_PATH" adaptive-model status --chain 1
```

Use chain8453 or4663 separately. The command reports the number of eligible measured decision samples, candidates and any active model. A no-samples/static result is valid and must not be described as production feedback certification.

The background worker proposes at most once daily when eligible history changes. It cannot supply the initial owner acceptance. An owner may also request a candidate explicitly:

```bash
node "$CLI_PATH" adaptive-model propose --chain 1
node "$CLI_PATH" adaptive-model propose --chain 1 --write
```

The first command is a preview. The second persists a validated candidate, not an active model. Review the chronological holdout, collection coverage, exact lineage, cost completeness, weights and baseline/candidate PnL.

## Accept and promote the first eligible model

Preview the exact candidate supplied by the report:

```bash
node "$CLI_PATH" adaptive-model accept --chain 1 --candidate-id "$CANDIDATE_ID"
```

Only after owner acceptance, use its exact returned phrase:

```bash
node "$CLI_PATH" adaptive-model accept --chain 1 --candidate-id "$CANDIDATE_ID" \
  --write --confirm "$EXACT_ACCEPTANCE"

node "$CLI_PATH" adaptive-model promote --chain 1 --candidate-id "$CANDIDATE_ID"
```

Review the promotion preview and use its exact confirmation with `--write`. Acceptance does not itself mutate weights. Later eligible candidates may promote automatically within that same approved governance profile. A changed governance profile requires its own initial owner acceptance. An insufficient or failed holdout remains static rather than weakening thresholds.

## Rollback

```bash
node "$CLI_PATH" adaptive-model rollback --chain 1
```

The preview prints a chain-specific rollback phrase. Confirm it with `--write --confirm` to append a durable rollback record. Reorg/invalid lineage also disables affected active epochs. Reports and accounting remain read-only; live decision authority resides in the separately governed model controller and ordinary coordinator/signing gates.
