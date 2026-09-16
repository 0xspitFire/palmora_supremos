# Robinhood Evidence Register

This register is documentation only. It is not an execution approval, wallet
fixture, or substitute for the accepted characterization gate.

## Current status

- Chain: Robinhood mainnet, chain ID `4663`.
- Sequencer: `https://sequencer.mainnet.chain.robinhood.com`.
- Feed: `wss://feed.mainnet.chain.robinhood.com`.
- Execution: disabled until characterization, safety, reconciliation, and
  Product Owner acceptance gates pass.
- Authoritative FREE characterization: transaction `0x790edf4d04c66e3d3ea1e6ed9c2a81466962824159f247a95f1b3503c30ac158`, decoded as
  `mintSigned`, with zero transaction value, NFT `0x8572DC3c69Eb735C6Dccc1E89d087820e51361Af`, and token ID `517`.
- Archive RPC: referenced only by the `ROBINHOOD_ARCHIVE_RPC` key in the read-only
  `~/W3/Rets/archive-rpc.env` store. The endpoint value is never recorded here
  or passed to Vitest.

## Strict replay inputs

The strict local-Anvil wrapper reads these non-secret fixture inputs from
`Fixtures/robinhood-testmint-fixture.env` when they are not explicitly set:

- `ROBINHOOD_FORK_BLOCK`: decimal archive fork block at or after the approved positive fixture block.
- `ANVIL_ROBINHOOD_RPC_URL`: loopback HTTP URL for the local Anvil instance; it defaults to `http://127.0.0.1:8545`.
- `ROBINHOOD_SEADROP_NFT`: approved positive-fixture NFT contract address.
- `ROBINHOOD_SEADROP_FEE_RECIPIENT`: fee recipient encoded in the approved positive fixture.
- `ROBINHOOD_SEADROP_MINT_VALUE_WEI`: positive-fixture mint value in wei.

The launcher additionally requires an archive reference key named
`ROBINHOOD_ARCHIVE_RPC` in `~/W3/Rets/archive-rpc.env`. The key value is read
only by the launcher to start local Anvil; it is not logged or placed in the
Vitest child environment. `MINT_BOT_FORK_REPLAY=true` is set internally for the
local child run. `ANVIL_BIN` is optional and defaults to `anvil`. Strict replay
must run the six Robinhood scenarios with zero skipped or todo tests.

The wrapper has been exercised with the authoritative non-secret fixture and
passed all six scenarios on local Anvil with zero skipped or todo tests. The
approved unattended runner must retain equivalent release evidence; missing or
conflicting values fail closed before archive evidence is accepted.

The approved transaction hash, wallet, SeaDrop singleton, and fixture block are
code-owned evidence constants, so they are not additional environment inputs.
The replay performs only local Anvil reads and local test-wallet mechanics; it
never submits an external transaction.

## Latest Strict Replay

- Date: `2026-09-15`.
- Fixture metadata: `Fixtures/robinhood-testmint-fixture.env`.
- Local Anvil: `http://127.0.0.1:8545`, chain ID `4663`.
- Result: `PASS`; 6 tests passed, 0 skipped.
- Coverage: historical positive receipt, invalid-value revert, duplicate-call
  revert, same-nonce replacement, receipt disappearance after reorg, and staged
  finality labeling.
- Archive credentials and resolved endpoint: not recorded.

This is local archive-fork evidence only. It does not enable Robinhood execution,
replace remote CI evidence, or authorize live capital.

## Failed hashes

The Product Owner identified five failed transaction hashes belonging to other
wallets. Their values are intentionally not copied into this repository. They
must not be used as test-wallet evidence, fixture inputs, success/failure
baselines, or signer validation. If an audit requires them, retain them in the
approved external evidence system with wallet ownership and provenance, not in
source, CI artifacts, logs, or this register.

## Required evidence before enablement

1. Verify chain ID `4663` through the configured RPC and sequencer endpoints.
2. Verify feed reachability and decode/reconciliation behavior without relying
   on the five external-wallet failures.
3. Run an archive-backed Anvil fork fixture using `ROBINHOOD_ARCHIVE_RPC` by secret
   reference only.
4. Confirm FREE mint value exposure is capped at two times the configured
   priority-fee component. Reserve L2 execution gas and L1 data gas separately
   as independent worst-case exposures; do not aggregate them into the value
   cap. A zero priority fee is valid when value exposure is zero.
5. Keep paid mints blocked until a separate Product Owner policy is accepted.
6. Complete restart, replacement, reorg, kill-switch, backup/restore, and
   durable reconciliation drills before any live arm operation.
