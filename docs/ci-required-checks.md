# Required Remote Checks

The protected integration branch must require these exact GitHub Actions check
names from `.github/workflows/ci.yml`:

- `verify`
- `anvil`

The manual `archive-fork-replay` job is evidence-gated and should be required
for a Robinhood release candidate only after an approved self-hosted runner is
available. It reads only the `ROBINHOOD_ARCHIVE_RPC` reference from the approved
Rets store and starts local Anvil before replaying against the local endpoint.
Branch protection must require pull requests, prohibit force pushes, and require
the branch to be up to date before merge. Configure those settings through
repository branch protection; no token or credential is stored here.
