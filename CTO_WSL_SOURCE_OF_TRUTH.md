# CTO WSL Source Of Truth

> **Live document:** this is the durable operating handoff for the single CTO role in the native WSL workspace. Update it when architecture, branch ownership, validation evidence, session continuity, or release gates change. Do not expand CTO authority into Product Owner decisions or specialist implementation ownership without recording the decision.

## Authority and operating mode

- Product Owner: final authority for product scope, spend, credentials, release approval, and destructive cleanup.
- Founding Product Manager: authoritative team lead for product alignment and cross-agent coordination.
- CTO: technical architecture, security, cross-stack contracts, integration sequencing, and go/no-go recommendation.
- Active development filesystem: `/home/Junayd/W3/MintBot`.
- CTO worktree: `/home/Junayd/W3/MintBot/.kilo/worktrees/cto`.
- CTO branch: `cto-wsl`.
- Do not edit the local `main` worktree directly while its conflict snapshot is unresolved.

## Current canonical state

- `cto-wsl` is the latest clean integrated technical branch and currently matches published `origin/main` at `b3907c6`.
- Published integration includes the earlier Backend, Database, Blockchain, DevOps, Product Design, lifecycle, policy, recovery, and Ethereum replay waves.
- The local `main` worktree is a separate unsafe recovery state at `dc3a2a2`, with 119 unresolved paths and 255 unmerged index entries. It has no active merge/cherry-pick/rebase marker. Its staged/unstaged patches, index, unmerged-path list, fixture, and all-ref bundle are preserved under `/home/Junayd/W3/recovery-input/main-conflict/`.
- Never use `git reset --hard`, `git clean`, force checkout, or blind conflict resolution on local `main`. Reconstruct it from a clean candidate only after the snapshot is verified and the Product Owner approves.

## Product and architecture invariants

- Product is a personal-first NFT intelligence and controlled mint execution platform. Signal quality comes before speed and automation volume.
- Phase 1 is the CLI execution foundation. Discovery, scoring, dashboard, Telegram intelligence, and broad frontend work are later phases.
- TypeScript, viem, pnpm, Vitest, Foundry, and Anvil are the current stack.
- SeaDrop v1 public mint is the first `MintStrategy`. Do not add contract-specific logic outside strategy boundaries.
- Discovery recommends. Backend admission authorizes. The signer signs. Blockchain code defines chain truth. The UI never invents execution success.
- Simulation failure is a hard block. Kill switch, spend limits, durable reservations, audit history, restart reconciliation, and finality are mandatory safety controls.
- Ethereum uses private orderflow where approved. L2s use chain-specific sequencer routing.
- Robinhood Chain `4663` remains disabled for unattended live execution until all evidence and Product Owner gates pass. Success requires the staged path through Ethereum finality.
- Never use shared mnemonic custody, value-bearing vanity keys, unaudited sponsored executors, or browser-exposed secrets.

## Specialist ownership and integration order

| Area | Owner | Current evidence | CTO action |
| --- | --- | --- | --- |
| Product requirements | Product Manager | Canonical specs and roadmap | Keep scope and acceptance authoritative |
| Product Design | Product Designer | `product-design-wsl` contract work | Integrate only design-owned docs and preserve Phase 1 CLI boundary |
| Engineering integration | Engineering Lead | Closure commits and conflict snapshot | Build clean candidate; do not replay ancestor commits |
| Database | Database Engineer | `84552a5`, `c4406ce`, `4be1659` | Integrate migration 015 and wallet-scoped reservation identity together |
| Backend | Backend Engineer | `3c9399d` plus prior CLI/lifecycle commits | Revalidate against Database 015 before integration |
| Blockchain | Blockchain Engineer | `5eae6e4` and current wrapper/fork diff | Resolve Robinhood strict-wrapper environment contract and prove fork behavior |
| DevOps | DevOps Engineer | `9e49077` and integrated CI/health gates | Verify native WSL, CI, branch protection, health, and recovery evidence |
| Frontend | Frontend Engineer | `72805cd` contract-only handoff | Keep web UI deferred; consume future Backend read models |

Integration order is Database -> Backend -> Blockchain -> DevOps, with Engineering Lead review between each stage. Product Design and Frontend remain contract-only for Phase 1.

## Validation evidence

- Native WSL Node `20.19.1`, pnpm `9.15.4`, Foundry/Anvil `1.8.1` are installed.
- Standard native suite previously passed install, clean-checkout, lint, typecheck, build, secret-boundary, policy, negative-case, recovery, and 139 unit tests.
- Robinhood direct fork tests pass with six scenarios using the approved reference path `~/W3/Rets/archive-rpc.env` without a Robinhood `MINT_BOT_SECRETS_ROOT` variable.
- Ethereum strict archive replay has passed using the approved fixture inputs and Anvil chain ID 1.
- `forge test --root ~/W3/seadrop-test` passes two fixture tests.
- The Robinhood strict wrapper must be retested after its environment-path correction. A strict wrapper must pass the archive-reference path to the test process without printing or copying the RPC value.
- Passing unit/fork tests do not authorize live execution. Health, signer, backup/restore, reconciliation, branch-protection, and live-fire evidence remain separate gates.

## Recovery and session continuity

- Recovery bundle: `/home/Junayd/W3-rsync-recovery.bundle`.
- Imported recovery refs: `refs/recovery/*` in the native clone.
- Approved historical artifacts: `/home/Junayd/W3/recovery-input/`.
- Intentional operational material is kept outside the active clone. Do not commit `Rets/`, wallet files, fixture credentials, or secret values.
- The original CTO transcript `ses_f600b89ebffezDMOSqHvMM5o3h`, earlier replacement `ses_f5be4701bffevDgXIPD3h8qcCp`, and current reconstruction history are recoverable through local session history. They are historical context, not live authorization.
- Agent Manager may show duplicate CTO session records because session workspace identity and Git worktree identity were recovered separately. Keep one WSL-native CTO session attached to `cto-wsl`; retire only records that are proven redundant after this document and transcript references are preserved.

## Current CTO session handoff

- Preferred live session: the newest WSL-native CTO session attached to worktree ID `wt-1789387471282-2`.
- Existing older reconstruction records must not be treated as a reason to create another worktree.
- The CTO session must begin by reading this file, `CTO_SKILLS.md`, `RECOVERY_INVENTORY.md`, `PRODUCT_SPEC.md`, `PRODUCT_DESIGN_SPEC.md`, `CTO_Brief.md`, `ENGINEERING_REVIEW.md`, and the current specialist closure documents.
- It must report the exact branch/worktree, current origin tip, specialist commit matrix, validation evidence, unresolved blockers, and Product Owner decisions required before coding.
- It must not modify `main`, touch secrets, merge unreviewed branches, or push release changes without Product Owner approval.

## Immediate CTO priorities

1. Keep the local main conflict snapshot intact.
2. Inspect the Database 015 and Backend 3c9399d commits for clean integration into a fresh candidate from current `origin/main`.
3. Resolve and test the Blockchain Robinhood wrapper/environment contract.
4. Collect final DevOps and Engineering Lead checklists.
5. Build a clean integration candidate from current `origin/main`, run the full WSL validation matrix, and request Product Owner approval before updating `main`.
6. Maintain a no-go recommendation until all safety, recovery, fork, and operational gates are evidenced.
