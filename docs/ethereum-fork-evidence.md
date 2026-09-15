# Ethereum Fork Evidence

## Replay Record

| Field | Value |
| --- | --- |
| Worktree | `/home/Junayd/W3/MintBot/.kilo/worktrees/cto` |
| Launcher | `pnpm ops:ethereum-fork` |
| Archive source | `/home/Junayd/W3/Rets/eth-archive-rpc.env:ETHEREUM_ARCHIVE_RPC` by reference only |
| Fixture metadata | `Fixtures/ethereum-seadrop-fixture.env` |
| Fork block | `25981880` |
| Local Anvil endpoint | `http://127.0.0.1:8546` |
| Local chain ID | `1` |
| Wallets exercised | `3` independent unlocked Anvil wallets |
| Probe coverage | `PASS; positive mint, price drift, insufficient funds, and allocation-sized sold-out probes` |
| Test result | `PASS; 4 tests` |
| Strict wrapper | `PASS; no skipped tests` |
| Raw archive URL or credentials | `none recorded` |

The archive value is read only by the launcher and passed only to Anvil. The
fork test receives the local Anvil endpoint and non-secret fixture metadata.
This record is not live execution approval; Robinhood remains separately gated.
