# CTO WSL Source Of Truth

> **Live document:** this is the durable operating handoff for the single CTO role in the native WSL workspace. Update it when architecture, branch ownership, validation evidence, session continuity, or release gates change. Do not expand CTO authority into Product Owner decisions or specialist implementation ownership without recording the decision.

## Authority and operating mode

- Product Owner: final authority for product scope, spend, credentials, release approval, and destructive cleanup.
- Founding Product Manager: authoritative team lead for product alignment and cross-agent coordination.
- CTO: technical architecture, security, cross-stack contracts, integration sequencing, and go/no-go recommendation.
- Active development filesystem: `/home/Junayd/W3/MintBot`.
- CTO worktree: `/home/Junayd/W3/MintBot/.kilo/worktrees/cto`.
- CTO branch: `cto-wsl`.
- `main` is now clean and synchronized; the earlier conflict snapshot remains preserved for recovery and audit.

## Current canonical state

- `cto-wsl` is the latest clean integrated technical branch and currently matches published `origin/main` at `550e4b7`.
- Published integration includes the earlier Backend, Database, Blockchain, DevOps, Product Design, lifecycle, policy, recovery, and Ethereum replay waves.
- The prior local `main` conflict at `dc3a2a2` was reconstructed to the validated `550e4b7` tree. Its 119-path, 255-entry conflict snapshot remains under `/home/Junayd/W3/recovery-input/main-conflict/`.
- Do not delete the conflict snapshot or use force history operations on future recovery states.

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
| Product Design | Product Designer | `product-design-wsl` contract work | Preserve the Phase 1 CLI boundary and guide future UX |
| Engineering integration | Engineering Lead | Closure commits and resolved conflict snapshot | Maintain clean candidate/release review discipline |
| Database | Database Engineer | `84552a5`, `c4406ce`, `4be1659` | Maintain migration 015 and wallet-scoped reservation identity |
| Backend | Backend Engineer | `3c9399d` plus prior CLI/lifecycle commits | Maintain the normalized reservation and lifecycle path |
| Blockchain | Blockchain Engineer | `5eae6e4`, `010bbb79`, and replay closure | Maintain chain/fork/finality correctness and live gate |
| DevOps | DevOps Engineer | `9e49077` and integrated CI/health gates | Maintain native WSL, CI, branch protection, health, and recovery evidence |
| Frontend | Frontend Engineer | `72805cd` contract-only handoff | Keep web UI deferred; consume future Backend read models |

Integration order is Database -> Backend -> Blockchain -> DevOps, with Engineering Lead review between each stage. Product Design and Frontend remain contract-only for Phase 1.

## Validation evidence

- Native WSL Node `20.19.1`, pnpm `9.15.4`, Foundry/Anvil `1.8.1` are installed.
- Standard native suite passes install, clean-checkout, lint, typecheck, build, secret-boundary, policy, negative-case, recovery, and 151 unit tests.
- Robinhood direct fork tests pass with six scenarios using the approved reference path `~/W3/Rets/archive-rpc.env` without a Robinhood `MINT_BOT_SECRETS_ROOT` variable.
- Ethereum strict archive replay has passed using the approved fixture inputs and Anvil chain ID 1.
- `forge test --root ~/W3/seadrop-test` passes two fixture tests.
- The strict Robinhood wrapper passes six tests with the archive reference read only by the launcher; `MINT_BOT_SECRETS_ROOT` is not required for Robinhood.
- Passing unit/fork tests do not authorize live execution. Health, signer, backup/restore, reconciliation, branch-protection, and live-fire evidence remain separate gates.

## Recovery and session continuity

- Recovery bundle: `/home/Junayd/W3-rsync-recovery.bundle`.
- Imported recovery refs: `refs/recovery/*` in the native clone.
- Approved historical artifacts: `/home/Junayd/W3/recovery-input/`.
- Intentional operational material is kept outside the active clone. Do not commit `Rets/`, wallet files, fixture credentials, or secret values.
- The original CTO transcript `ses_f600b89ebffezDMOSqHvMM5o3h`, earlier replacement `ses_f5be4701bffevDgXIPD3h8qcCp`, and current reconstruction history are recoverable through local session history. They are historical context, not live authorization.
- Agent Manager now has one WSL-native CTO session attached to `cto-wsl`. Future specialist worktree requests must be verified through the Manager overview before being considered created.

## Current CTO session handoff

- Preferred live session: the single WSL-native CTO session attached to worktree ID `wt-1789387471282-2`.
- Existing older reconstruction records must not be treated as a reason to create another worktree.
- The CTO session must begin by reading this file, `CTO_SKILLS.md`, `RECOVERY_INVENTORY.md`, `PRODUCT_SPEC.md`, `PRODUCT_DESIGN_SPEC.md`, `CTO_Brief.md`, `ENGINEERING_REVIEW.md`, and the current specialist closure documents. The seven future-phase specialists are not yet Manager-created and must not be assumed to exist.
- It must report the exact branch/worktree, current origin tip, specialist commit matrix, validation evidence, unresolved blockers, and Product Owner decisions required before coding.
- It must not modify `main`, touch secrets, merge unreviewed branches, or push release changes without Product Owner approval.

## Immediate CTO priorities

1. Keep the resolved main conflict snapshot and recovery bundle intact.
2. Maintain the clean `main`/`cto-wsl` synchronization and review future specialist branches from main.
3. Maintain the Blockchain Robinhood wrapper/environment contract and no-live-execution gate.
4. Coordinate future-phase specialist worktrees only after Agent Manager registration is verified.
5. Maintain the Phase 1 no-go recommendation for live capital until safety, recovery, fork, and operational evidence is complete.
