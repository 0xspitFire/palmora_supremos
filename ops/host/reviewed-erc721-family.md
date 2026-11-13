# Reusable reviewed ERC721 families — D-095

This workflow belongs to the new reviewed development release. It is not installed on0.0.16. It authorizes only free `mint(uint256)` transactions matching independently reviewed immutable deployment/factory templates. Existing SeaDrop policies and chain grants do not cover it. No arbitrary calldata, paid value or private-key export is introduced.

Engineering first reviews a concrete template's code, ABI and factory provenance and prepares its public descriptor/registry draft plus protocol evidence. The synthetic contracts in `ops/fixtures/reviewed-erc721` are test fixtures, not production template approvals. The owner reviews a template once; future collections matching that exact template/factory can be resolved dynamically during discovery/preparation. Unknown code or provenance remains blocked.

## Offline registry approval

On the signing computer, use the built reviewed CLI and existing pinned public approval key. Keep the private approval key there.

```bash
node "$CLI_PATH" reviewed-protocol-custody registry-preview \
  --input "$PUBLIC_REGISTRY_DRAFT" \
  --approver-public-key "$APPROVER_PUBLIC_KEY"
```

Review chain, template/code hashes, factory/deployment, permitted getter ABI, quantity, references and finite dates. Use the exact preview phrase locally:

```bash
node "$CLI_PATH" reviewed-protocol-custody registry-sign \
  --input "$PUBLIC_REGISTRY_DRAFT" \
  --approver-public-key "$APPROVER_PUBLIC_KEY" \
  --owner-key "$OFFLINE_APPROVAL_KEY" \
  --output "$SIGNED_PUBLIC_REGISTRY" \
  --confirm "$EXACT_REGISTRY_CONFIRMATION"
```

The command writes a new exclusive mode0600 public signed registry. The private key is never returned. Each chain has its own signature; a public catalog can retain up to three independently signed chain registries. Do not replace the other chains' entries.

## Exact provider policy and canonical record

Engineering supplies a protected public wallet draft naming the intended existing mint organization/user, chain, ten-wallet public references, actual policy ID (or initial placeholder) and optional lower gas/fee limits. Generate the policy preview:

```bash
node "$CLI_PATH" reviewed-protocol-custody policy-preview \
  --registry "$SIGNED_PUBLIC_REGISTRY" \
  --wallet-draft "$PUBLIC_WALLET_DRAFT" \
  --approver-public-key "$APPROVER_PUBLIC_KEY" > "$PUBLIC_POLICY_PREVIEW"
```

The JSON separates `enforcementPolicy` and `providerPolicy`. Only the provider policy's effect/consensus/condition go into the dashboard condition fields; a name/notes are descriptive. No nullable time field is emitted. Its exact full-calldata membership bounds quantity and prevents extra trailing arguments.

During an owner-approved stopped/kill-engaged custody maintenance window, create this exact provider policy using the owner/admin dashboard. Set its actual ID in the public wallet draft and regenerate the preview. Keep existing SeaDrop policies unchanged. Installing a new ALLOW policy before its signed catalog entry exists can intentionally stop runtime provider checks; complete custody changes sequentially.

Extract the AST into a protected public file:

```bash
umask 077
jq '.enforcementPolicy' "$PUBLIC_POLICY_PREVIEW" > "$REVIEWED_POLICY_AST"
node "$CLI_PATH" turnkey-policy-propose \
  --policy-ast "$REVIEWED_POLICY_AST" \
  --wallet-artifact "$PUBLIC_WALLET_ARTIFACT" \
  --output "$UNSIGNED_CANONICAL_PROPOSAL"
```

The canonical proposal verifies the actual provider response and the union of the existing signed catalog plus this explicitly proposed policy. It does not silently trust other ALLOWs. Copy only the unsigned public proposal and existing public bundle to the signing computer. Follow `free-signed-family.md` for the shared canonical offline `turnkey-policy-sign`, protected public bundle install and signed map regeneration; preserve all other catalog entries. The private owner key stays offline.

Engineering installs the protected signed registry/catalog path as `TURNKEY_REVIEWED_PROTOCOL_REGISTRY_PATH` alongside those public custody artifacts. This registers a code-checking strategy, not a chain grant.

## New inert no-broadcast rehearsal

Use the new command, not the older SeaDrop-only rehearsal command:

```bash
node "$CLI_PATH" reviewed-protocol-rehearsal \
  --policy-id "$REVIEWED_POLICY_ID" \
  --contract "$EXISTING_REVIEWED_DEPLOYMENT" --preview
```

A factory template needs an existing matching deployment for this one-time setup exercise. It need not currently be minting: the inert path checks code/factory provenance separately from live eligibility. Review and repeat with the exact returned `--confirm` phrase. Keep the kill switch engaged. Only policy/wallet/lockfile-bound public metadata and a signed hash are retained; gas/value/fees are zero and nonce is MAX_SAFE_INTEGER. Those bytes cannot execute and are never broadcast or returned. This is not a live eligibility simulation.

## Explicit chain baseline and activation

Engineering assembles genuine template-specific protocol, failure, reconciliation and chain finality evidence. A synthetic local test is not an archive fork or production approval. Preview the separate baseline:

```bash
node "$CLI_PATH" reviewed-protocol-baseline accept --chain "$CHAIN_ID" \
  --evidence-file "$REVIEWED_BASELINE_EVIDENCE"
```

Only after reviewing the real evidence, rerun with its exact `--confirm` phrase. This accepts the reviewed protocol only; it never switches a globally disabled chain on. Existing Ethereum/Base/Robinhood operational enablement, lower custody/cap rules, D-017 evidence and per-mint simulation remain mandatory. Base/Robinhood paid execution stays disabled.

Changed release/configuration/custody requires current infrastructure evidence and owner acceptance. After activation, `/prepare`/qualified discovery resolve matching templates dynamically; they do not create a new provider policy per collection. A changed template or changed wallet/chain authority needs a new explicit owner-signed scope. Registry renewal can reuse an unchanged exact provider policy, but requires renewed offline records; no expired record is extended automatically.
