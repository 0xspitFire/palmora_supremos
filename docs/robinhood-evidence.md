# Robinhood Evidence Register

This register is documentation only. It is not an execution approval, wallet
fixture, or substitute for the accepted characterization gate.

## Current status

- Chain: Robinhood mainnet, chain ID `4663`.
- Sequencer: `https://sequencer.mainnet.chain.robinhood.com`.
- Feed: `wss://feed.mainnet.chain.robinhood.com`.
- Execution: disabled until characterization, safety, reconciliation, and
  Product Owner acceptance gates pass.
- Archive RPC: referenced only by the `ANVIL_FORK_RPC` key in the read-only
  `Rets/MINT_BOT_SECRETS.env` store. The endpoint value is never recorded here.

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
3. Run an archive-backed Anvil fork fixture using `ANVIL_FORK_RPC` by secret
   reference only.
4. Confirm FREE mint value exposure is capped at two times the configured
   priority-fee component. Reserve L2 execution gas and L1 data gas separately
   as independent worst-case exposures; do not aggregate them into the value
   cap. A zero priority fee is valid when value exposure is zero.
5. Keep paid mints blocked until a separate Product Owner policy is accepted.
6. Complete restart, replacement, reorg, kill-switch, backup/restore, and
   durable reconciliation drills before any live arm operation.
