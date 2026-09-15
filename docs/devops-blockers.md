# DevOps Blocker Checklist

This checklist contains no credentials, wallet material, transaction hashes, or
secret-store contents.

## Wave 0 evidence - 2026-09-14

- [x] `pnpm ops:environment` is a secret-free native-WSL preflight. It hard-fails
      Windows, `/mnt/c`, and toolchain drift, and reports only path/version
      status.
- [x] CI and archive jobs invoke the environment preflight before install,
      tests, builds, forks, or operational checks.
- [x] Fork launchers isolate the archive reference at the Anvil boundary and
      reject skipped or todo tests in strict mode.
- [x] CI Foundry/Anvil setup is pinned to `1.8.1`; the `anvil` check runs the
      strict archive replay rather than vanilla Anvil reachability.
- [x] Health/runbook names are aligned around `SECRET_STORE_PATH`,
      `RPC_SECRET_NAMES`, `STORE_PATH`, `KILL_SWITCH_PATH`, and service health
      probe URLs.
- [x] Backup/restore, service supervision, and branch-protection evidence
      requirements are documented without secret values.
- [ ] Approved unattended native-WSL runner, archive reference, and Ethereum
      fixture are provisioned; no remote fork evidence is claimed by this
      slice.
- [ ] Remote branch-protection settings are verified by a repository admin.

## Resolved

- [x] CI uses pinned Node and pnpm versions with frozen-lockfile installation.
- [x] CI runs the integrated 48-test Vitest suite from the repository root.
- [x] CI builds engine, database, backend, and CLI packages.
- [x] CI runs source hygiene, policy, secret-boundary, and Gitleaks checks.
- [x] Root typecheck resolves the pinned compiler through pnpm on the approved
      native-WSL execution path.
- [x] `Rets/`, wallet storage, environment files, and secret-store filenames are
      excluded from Git and rejected if tracked.
- [x] Health checks fail closed for missing RPC, store, kill switch, signer,
      verification, and reconciliation configuration; notification is required
      outside the Phase 1 mode.
- [x] Backup and restore checks require checksums and an engaged kill switch.
- [x] Backup snapshots are encrypted with AES-256-GCM and restored into a
      temporary database for SQLite integrity validation; the recovery drill uses
      only temporary non-production paths and an ephemeral key.
- [x] Log redaction covers private material, credentials, passphrases, calldata,
      raw transactions, and authorization values.
- [x] Deterministic negative-case harness rejects paid mints, value-cap
      violations, and insufficient independent L2/L1 reserves.
- [x] Archive replay entrypoint fails closed without an injected archive
      endpoint or an actual `*.fork.test.ts` fixture.
- [x] The runnable CLI no longer calls the engine directly; its mint convenience
      command creates a Backend-admitted run.
- [x] CLI runtime uses the SQLite-backed Backend state store with cross-process
      atomic transactions and durable reservations.
- [x] Ethereum receipts are observed through the finality observer; submitted
      transactions retain reservations after timeout for reconciliation.
- [x] Passphrases are requested through hidden interactive input; environment
      passphrases are not accepted by the wallet command.

## Robinhood evidence gates still required

- [x] Accept chain ID `4663`, sequencer/feed behavior, propagation, fee
      semantics, confirmation, and reorg characterization at the evidence level;
      execution remains disabled pending integrated proof.
- [x] Historical evidence records six archive-backed Robinhood scenarios using
      only the `ROBINHOOD_ARCHIVE_RPC` reference from
      `Rets/MINT_BOT_SECRETS.env`; no endpoint value is copied here.
- [ ] Run the strict archive launcher on the approved unattended native-WSL CI
      runner and retain its release evidence.
- [x] Record a successful SeaDrop v1 public-drop test from an approved test
      wallet with provenance and reconciliation evidence at the evidence level.
- [x] Demonstrate FREE mint value exposure `<= 2x` the configured priority-fee
      component, with independent worst-case L2 and L1 gas reserves in unit and
      database policy tests.
- [ ] Complete restart, replacement, reorg, kill-switch, backup/restore, and
      durable reconciliation drills, including a service-supervision restart.
- [ ] Obtain Product Owner acceptance of the complete integrated evidence package
      before changing the execution gate.

Robinhood auto-execution approval in principle does not satisfy these evidence
gates. Failed hashes belonging to external wallets remain documentation-only
references and are not fleet evidence.

## Product Owner decisions

- [x] Paid mints remain blocked; a separate value/exposure policy is required
      before any paid execution.
- [x] Use conservative defaults while requiring explicit configured production
      spend, gas, burner-funding, and confirmation limits before live admission.
- [x] Product Owner owns production backup/recovery approval; encrypted backups
      retain 30-day retention.

## Phase 1 Scope / Blockers

- Base remains supported in the product model but is not an execution target for
  the current Ethereum-first Phase 1 gate; Base RPC/sequencer validation is
  deferred until Ethereum and Robinhood are operational.
- Telegram, dashboard, discovery, replication, and analytics are later-phase
  work and do not block the CLI Execution Foundation.
- Historical evidence records six Robinhood archive-fork scenarios against a
   local Anvil fork. The unattended strict launcher still requires an approved
   native-WSL runner with the archive reference and must be retained as release
   evidence.
- Historical remote CI evidence records a production image build and a
   no-configuration container health probe that fails closed. The updated
   workflow requires a native-WSL runner; it has not been rerun in this slice.
- The required Ethereum three-wallet SeaDrop fork test and strict runner are
  present and pass with the approved archive reference and fixture configuration;
  the default deterministic suite remains an external skip when those inputs are
  not injected.
- Remote branch protection is an authenticated repository-admin operation. The
   branch and workflow can be pushed, but protection is not represented as code;
   the required-check mapping and redacted verification template are in
   `docs/branch-protection-evidence.md` and must be verified remotely after
   push.
