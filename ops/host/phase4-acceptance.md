# Phase 4 retained-history review

After building/installing the reviewed release, run the report against an existing
service database or an isolated restored copy. Replace the example database path
with the actual configured SQLite path:

```sh
node scripts/phase4-acceptance.mjs --database /absolute/path/to/state.sqlite
```

The helper opens the file read-only, never migrates it, and reads all tables in one
SQLite snapshot. It makes no network calls, signs nothing and submits nothing.
It does not load host credentials. The report contains public wallet/collection
addresses and transaction/event identifiers; retain it as operational evidence.

The report provides:

- Chain-scoped mint history for wallets observed paying for their own mint.
- A replay of distinct-wallet convergence using the recorded observation times,
  with duplicate transaction observations excluded. The default is two distinct
  wallets within six hours. Chain block timestamps are not reconstructed here.
- A structural audit of autonomous replication requests: retained source identity,
  campaign chain/collection, newest linked score and expiry, free-mint authority,
  exact wallet/fee bounds and passing per-wallet simulations at request creation.
- A structural audit of retained transaction attempts on replication campaigns:
  request/run/result linkage, scope, approval, source/latest score freshness at
  attempt time, simulation and admitted campaign digest, and a matching reservation
  created before the attempt with enough exposure for mint value plus fee budget.

`replicationAudit.result: clean` means these request-level checks found no
problems. `findings` identifies missing, inconsistent or stale evidence.
`no_samples` means no corresponding autonomous request/transaction-attempt sample
was available to review; this is not a successful acceptance sample. The separate
`executionAudit` section reports attempt findings. Either audit returning
`findings` or `no_samples` results in exit code 1.
A clean request audit with no convergence matches also does not demonstrate the
historical convergence acceptance criterion.

A clean execution audit means no structural violations were found among retained
attempts associated with replication campaigns; signed attempts are included even
if their submission was later ambiguous. Missing result/run linkage is a finding,
including a crash that prevented the result event from being recorded. Attempts
positively linked to an attended request on the same run and campaign are excluded
from this autonomous audit; unidentified free replication attempts remain findings. The tool
does not decode raw signed transactions, reconstruct the remote provider's
historical policy state, prove historical reservation status transitions or final
settlement, or recover pruned evidence. It cannot establish those stronger claims
from an empty sample or missing history. Final-release acceptance must review the
report together with lifecycle/finality and custody evidence.
Normal simulation, admission, custody, spend, chain and D-017 gates remain the
execution authorities. Final production evidence collection remains deferred
until the owner-approved release stage.
