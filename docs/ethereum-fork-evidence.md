# Ethereum Fork Evidence

The strict Ethereum replay is a local-Anvil characterization run. It starts a
fresh unlocked wallet set on `127.0.0.1:8546` with chain ID `1`, filters all
selected senders through `eth_getCode === 0x`, and submits no transaction to
the archive endpoint.

## Launcher Inputs

The launcher accepts only the approved archive reference
`/home/Junayd/W3/Rets/eth-archive-rpc.env:ETHEREUM_ARCHIVE_RPC`. The archive
value is used internally by Anvil and is never logged, committed, or passed to
the Vitest child environment.

Fixture metadata is read from `Fixtures/ethereum-seadrop-fixture.env` and must
provide or be overridden by these non-secret values:

- `ETHEREUM_FORK_BLOCK`
- `ETHEREUM_SEADROP_NFT`
- `ETHEREUM_SEADROP_FEE_RECIPIENT`
- `ETHEREUM_SEADROP_MINT_VALUE_WEI`

`ANVIL_ETHEREUM_RPC_URL` is restricted to loopback port `8546` and
`MINT_BOT_FORK_REPLAY=true` is set internally. `ANVIL_BIN` is optional.

## Probes

The four strict probes are the three-wallet public SeaDrop happy path, a
price-drift revert, an insufficient-funds estimate, and an allocation-sized
sold-out/revert probe. The negative probes use `eth_call` or
`eth_estimateGas`; they do not broadcast.

The clean native-WSL candidate replay was run from the scheduled fixture
metadata on 2026-09-16 and passed all four probes with zero skips.

Passing strict output is required to contain zero skipped or todo tests. A
missing archive reference or fixture metadata is a setup blocker, not passing
fork evidence.
