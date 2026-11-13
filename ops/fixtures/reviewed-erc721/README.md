# Synthetic reviewed ERC721 local rehearsal

This immutable collection and factory exist only for the T126 development rehearsal. They are not owner-approved production registry entries.

The fixture pins Solidity **0.8.36+commit.8a079791**, Cancun and optimizer settings in `foundry.toml`. The helper uses the existing compiler at `~/.local/share/svm/0.8.36/solc-0.8.36` and invokes Forge offline. Compilation outputs live in a temporary directory.

After building the database, backend and engine packages, run:

```sh
MINT_BOT_REVIEWED_LOCAL_REHEARSAL=1 MINT_BOT_REVIEWED_LOCAL_WRITE_RESULT=1 pnpm exec vitest run packages/cli/src/reviewed-protocol.local.test.ts
```

The opt-in test starts a new Anvil process bound only to `127.0.0.1` on an ephemeral port, with chain ID 1 and zero managed accounts. It creates temporary accounts in memory and assigns synthetic balances through Anvil. It deploys the compiled factory and collection, verifies runtime bytecode equivalence and factory registration, executes a watched mint, and qualifies it through two local HTTP clients. The own-wallet mint then passes through the actual `MintEngine`, reservation boundary, `TurnkeySigner`, EIP-1559 serialization/recovery, broadcast and receipt handling. The provider SDK is an injected in-memory signing adapter; no Turnkey credentials or provider API is used.

The same run then closes the synthetic public stage. Live eligibility fails, while the distinct inert rehearsal verifies only immutable code/factory provenance with the kill file engaged. It signs canonical mint(1) using gas/value/fees zero and nonce Number.MAX_SAFE_INTEGER, returns only a transaction hash, and verifies that the node nonce and token balance stay unchanged. The inert transaction is never submitted to the node.

The test exercises the actual reviewed-baseline guard using explicitly synthetic in-memory campaign/evidence records. Those records are not persisted as owner acceptance. Reservation and lifecycle persistence are test doubles; separate SQLite regression tests cover baseline persistence and revocation. Gas, fee, code and revoked-baseline refusals are checked before another provider signature.

The local result is written to `Docs/Live/evidence/2026-11-13-roadmap-closeout/reviewed-protocol-local-result.json` only when the second environment flag is set. The test stops Anvil and removes its temporary artifacts in `finally`.

Both clients reach the same Anvil node through `127.0.0.1` and `localhost`. This proves local protocol composition, not independent external RPC agreement. The run has no archive fork, real provider installation, production finality, production owner acceptance or commissioning claim. Production activation still needs the separately reviewed real-protocol evidence and the owner's offline registry/family signatures and explicit chain baseline.

Primary tool references: [Solidity compiler installation](https://docs.soliditylang.org/en/latest/installing-solidity.html), [Foundry configuration](https://getfoundry.sh/config/overview/).

The same offline fixture helper supports the separate native-funding EVM exercise:

```sh
MINT_BOT_LOCAL_PROTOCOL_REHEARSAL=true pnpm exec vitest run packages/cli/src/native-funding-loopback.test.ts
```

It seeds only synthetic hub ETH, computes the exact recipient shortfall, signs a native EIP-1559 transfer through the dedicated funding signer with an ephemeral SDK adapter, checks the pre-sign and pre-broadcast journal-hook order, broadcasts to the local node and verifies recipient value and exact gas conservation. A second funding preparation fails closed after arrival. These hooks are test doubles; canonical hold/reservation and private worker-journal tests separately exercise SQLite. This is not a live funding-hub authorization, provider-independence check or production transfer.
