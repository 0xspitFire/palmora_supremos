# Turnkey Policy Boundary

The Phase 2 Turnkey boundary is a validation boundary only. This worktree does
not read, print, copy, import, or handle raw private keys during tests, and it
does not sign, broadcast, or enable Robinhood (`4663`) or paid mints.

## Canonical Policy

The approved policy is represented by an exact `TurnkeyPolicyAst`:

- `version: 1` and `effect: "allow"` are required.
- `scope` is exact: provider, environment, organization, API user, policy ID,
  and the unique key IDs.
- `transaction` is exact: Ethereum chain ID `1`, unique allowed `from`
  addresses, contract `to`, exact zero `valueWei`, canonical calldata bytes,
  gas and fee ceilings, and an empty access list.
- Extra keys, `or` branches, wildcards, regexes, deny/allow unions, and
  substring clauses are rejected.

The canonical JSON form is hashed with Keccak-256. The approved provider
binding must carry the same digest, organization, API user, environment, and
policy ID. Intent references use the exact form
`turnkey:<policy-id>:<policy-digest>`; a policy ID alone is not accepted.

## Provider And Key Inventory

`TurnkeySigner.probe()` requires synthetic/public metadata for:

- `getWhoami`: exact organization, API user, and environment;
- `getPolicies`: exact allow effect, canonical AST, digest, and provider
  binding;
- `getPrivateKeys`: exact restricted inventory, with one approved key ID and
  Ethereum address per wallet map entry.

The inventory is metadata only. Key material is never requested or compared.
Duplicate wallet addresses, duplicate `signWith` references, unknown key IDs,
wrong environment, wrong API user, and extra inventory entries fail closed.

## Transaction Checks

Before a provider call, the signer validates chain, wallet/from, contract/to,
exact value, canonical calldata bytes, gas limit, max fee, priority fee, empty
or exact access list, and the full policy reference. A returned signed
transaction is independently checked for the same fields and recovered
address before it can leave the boundary.

The CLI Turnkey import command requires an owner-only canonical policy AST and
matching digest before reading wallet import records. A map is persisted only
after `validateTurnkeyWalletMap` accepts its policy, provider, wallet, and key
scope. Existing maps that lack this metadata are rejected rather than upgraded
implicitly.

## Synthetic Negative Coverage

The engine fixtures cover:

- policy drift and digest mismatch;
- extra/broad AST branches;
- wrong provider, organization, API user, environment, key ID, and address;
- duplicate wallet-map address and `signWith` references;
- wrong chain, from, contract, value, calldata, gas, fee, access list, and
  policy reference.

Production provider metadata, raw credentials, key imports, signatures, and
broadcasts require separate Product Owner and infrastructure approval and are
not part of this validation boundary.
