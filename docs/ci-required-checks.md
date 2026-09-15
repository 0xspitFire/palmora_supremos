# Required Remote Checks

The protected integration branch must require these exact GitHub Actions check
names from `.github/workflows/ci.yml`:

- `environment`
- `verify`
- `anvil`
- `docker`

`environment` is the native-WSL prerequisite. `anvil` is the strict archive
fork gate, not a vanilla Anvil reachability check; it starts local Anvil from
the approved `ROBINHOOD_ARCHIVE_RPC` reference and rejects skipped tests. The
current fixture is the Engine-owned replay surface; Backend/Database
integration remains a specialist dependency and is not claimed by this
workflow change.
The separate `ethereum-fork-replay` job is required for an Ethereum release
candidate after its approved fixture is provisioned and also rejects skips.

The manual `archive-fork-replay` job is retained for an explicit Robinhood
release-evidence rerun. It is evidence-gated and should become a required
release check only after an approved unattended native-WSL runner is
available. The runner must check out below `/home/Junayd/W3/`, provide Foundry
and Anvil `1.8.1`, and expose only the secret-store reference to the launcher.
Vitest receives only the local Anvil URL and non-secret fixture metadata.

Branch protection evidence must show, for the protected integration branch:

- Pull requests are required before merge.
- `environment`, `verify`, `anvil`, and `docker` are required and must pass.
- The branch must be up to date before merge.
- Force pushes and branch deletion are prohibited.
- No bypass is granted to ordinary actors.

Configure and verify those settings through repository branch protection; no
token, credential, resolved endpoint, or secret value is stored here. The
remote-admin verification is pending until the Lead supplies the repository
administration window.
