# DevOps Blocker Checklist

This checklist contains no credentials, wallet material, transaction hashes, or
secret-store contents.

## Resolved

- [x] CI uses pinned Node and pnpm versions with frozen-lockfile installation.
- [x] CI runs the integrated 48-test Vitest suite from the repository root.
- [x] CI builds engine, database, backend, and CLI packages.
- [x] CI runs source hygiene, policy, secret-boundary, and Gitleaks checks.
- [x] Root typecheck resolves the pinned compiler through pnpm on Windows and CI.
- [x] `Rets/`, wallet storage, environment files, and secret-store filenames are
      excluded from Git and rejected if tracked.
- [x] Health checks fail closed for missing RPC, store, kill switch, signer,
      verification, notification, and reconciliation configuration.
- [x] Backup and restore checks require checksums and an engaged kill switch.
- [x] Log redaction covers private material, credentials, passphrases, calldata,
      raw transactions, and authorization values.
- [x] Deterministic negative-case harness rejects paid mints, value-cap
      violations, and insufficient independent L2/L1 reserves.
- [x] Archive replay entrypoint fails closed without an injected archive
      endpoint or an actual `*.fork.test.ts` fixture.

## Robinhood evidence gates still required

- [ ] Accept chain ID `4663`, sequencer/feed behavior, propagation, fee
      semantics, confirmation, and reorg characterization.
- [ ] Run the archive-backed fork fixture using only the `ANVIL_FORK_RPC`
      reference from `Rets/MINT_BOT_SECRETS.env`; never copy the endpoint value.
- [ ] Record a successful SeaDrop v1 public-drop test from an approved test
      wallet with provenance and reconciliation evidence.
- [ ] Demonstrate FREE mint value exposure `<= 2x` the configured priority-fee
      component, with independent worst-case L2 and L1 gas reserves.
- [ ] Complete restart, replacement, reorg, kill-switch, backup/restore, and
      durable reconciliation drills.
- [ ] Obtain Product Owner acceptance of the evidence package before changing
      the execution gate.

Robinhood auto-execution approval in principle does not satisfy these evidence
gates. Failed hashes belonging to external wallets remain documentation-only
references and are not fleet evidence.

## Product Owner decisions

- [ ] Approve a separate paid-mint value/exposure policy before paid execution.
- [ ] Approve numeric production spend, gas, burner-funding, and confirmation
      limits before live admission.
- [ ] Confirm the operator and retention owners for production backups and
      recovery drills.
