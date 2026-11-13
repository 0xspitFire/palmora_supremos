# Reusable bounded free server-signed SeaDrop policy setup

Requires the reviewed T-115 release; installed 0.0.14 does not contain this flag. Do not run installation before merge/release. The owner approved engineering, but must separately review and install each provider policy and offline canonical record. This selector is 0x4b61cd6f, separate from public 0x161ac21f and Merkle 0x4300a4e6. Keep every still-valid existing policy in the catalog. No new fleet or approval key is needed, and no per-drop policy ceremony is needed within this family.

Complete one chain at a time: Ethereum (1) and Robinhood (4663), quantity 10; Base (8453), quantity 4. Fees remain max 0.2 gwei, tip 0.1 gwei, gas 500,000, transaction value and signed mint price zero. All lower campaign/fleet/spend limits still apply. The backend never creates provider policies. The approval key stays on the signing computer.

## Production host — prepare and snapshot the provider policy

```bash
sudo test -f /var/lib/mint-bot/killswitch && echo 'Kill switch engaged'
sudo systemctl stop mint-bot.service
bot() { sudo -u mintbot bash -c 'set -a; . /etc/mint-bot/mint-bot.env; set +a; cd /opt/mint-bot/current && exec /usr/bin/node packages/cli/dist/index.js "$@"' _ "$@"; }
rootbot() { sudo bash -c 'set -a; . /etc/mint-bot/mint-bot.env; set +a; cd /opt/mint-bot/current && exec /usr/bin/node packages/cli/dist/index.js "$@"' _ "$@"; }
CHAIN_ID=1
case "$CHAIN_ID" in 1|4663) QUANTITY=10;; 8453) QUANTITY=4;; *) echo 'Unsupported chain';; esac
renew_signed() {
  bot turnkey-policy-renew --free-signed-family --chain-id "$CHAIN_ID" \
    --quantity "$QUANTITY" --valid-hours 720 --gas-limit-max 500000 \
    --max-fee-gwei 0.2 --priority-fee-gwei 0.1 \
    --policy-output "/etc/mint-bot/Rets/free-signed-${CHAIN_ID}-ast.json" \
    --proposal-output "/etc/mint-bot/Rets/free-signed-${CHAIN_ID}-proposal.json" \
    --state-output "/etc/mint-bot/Rets/free-signed-${CHAIN_ID}-state.json" "$@"
}
renew_signed
```

Proceed only when the kill check printed engaged. Create the exact returned
effect, consensus and condition in the owner's Turnkey dashboard if the result
says provider-policy-required. Omit `time` when null. Do not widen the condition,
rename/change existing policies, or create a duplicate if the tool finds a match.
The runtime credential never administers policies.

```bash
read -r -p 'Matching signed Turnkey policy ID: ' POLICY_ID
renew_signed --policy-id "$POLICY_ID" --apply
```

Expect awaiting-offline-signature; verify the chosen chain, policy, fleet and
limits. Retain its mapConfirmation. Only the unsigned proposal was written.

## Signing computer — copy, review and sign

Set the same CHAIN_ID on this computer. Use a fresh directory for this signature.
The current installed bundle must be downloaded again after each chain install.

```bash
CHAIN_ID=1
printf 'CHAIN_ID=%s\n' "${CHAIN_ID:-NOT SET}"
umask 077
OFFLINE_ROOT=$(mktemp -d "$HOME/mintbot-signed-${CHAIN_ID}-XXXXXX")
CLI_PATH=/home/Junayd/W3/MintBot/packages/cli/dist/index.js
gcloud compute ssh palmora-bot-prod --project mintbot-508813 --zone us-east4-b --tunnel-through-iap --command="sudo cat /etc/mint-bot/Rets/free-signed-${CHAIN_ID}-proposal.json" > "$OFFLINE_ROOT/free-signed-${CHAIN_ID}-proposal.json"
gcloud compute ssh palmora-bot-prod --project mintbot-508813 --zone us-east4-b --tunnel-through-iap --command='sudo cat /etc/mint-bot/Rets/turnkey-policy-bundles/current.json' > "$OFFLINE_ROOT/existing-bundle.json"
jq -e . "$OFFLINE_ROOT/free-signed-${CHAIN_ID}-proposal.json" >/dev/null
jq -e . "$OFFLINE_ROOT/existing-bundle.json" >/dev/null
```

Stop if either transfer/JSON check failed. CLI_PATH must be the current reviewed
built CLI on the signing computer. Set the existing key's actual path outside
OFFLINE_ROOT; keep that private key off the production host:

```bash
APPROVAL_KEY='/actual/path/to/existing-approval-key'
chmod 600 -- "$APPROVAL_KEY"
sign_signed() {
  MINT_BOT_SECRET_ROOT="$OFFLINE_ROOT" node "$CLI_PATH" turnkey-policy-sign \
    --proposal "$OFFLINE_ROOT/free-signed-${CHAIN_ID}-proposal.json" \
    --private-key "$APPROVAL_KEY" --existing-bundle "$OFFLINE_ROOT/existing-bundle.json" \
    --record-output "$OFFLINE_ROOT/free-signed-${CHAIN_ID}-record.json" \
    --public-key-output "$OFFLINE_ROOT/free-signed-${CHAIN_ID}-approver.pub" \
    --catalog-output "$OFFLINE_ROOT/free-signed-${CHAIN_ID}-catalog.json" \
    --bundle-output "$OFFLINE_ROOT/free-signed-${CHAIN_ID}-bundle.json" "$@"
}
sign_signed --preview
```

Review the same fleet, newly selected chain/policy and exact displayed signature
confirmation. New output paths must be unused. Then:

```bash
read -r -p 'Exact SIGN-TURNKEY-POLICY confirmation: ' SIGN_CONFIRM
sign_signed --confirm "$SIGN_CONFIRM"
gcloud compute scp --project mintbot-508813 --zone us-east4-b --tunnel-through-iap "$OFFLINE_ROOT/free-signed-${CHAIN_ID}-bundle.json" "palmora-bot-prod:/tmp/free-signed-${CHAIN_ID}-bundle.json"
```

## Production host — install, regenerate, rehearse

Keep the same CHAIN_ID and POLICY_ID from the host preparation above.

```bash
sudo install -o root -g mintbot -m 640 "/tmp/free-signed-${CHAIN_ID}-bundle.json" "/etc/mint-bot/Rets/free-signed-${CHAIN_ID}-bundle.json"
rootbot turnkey-bundle-install --bundle "/etc/mint-bot/Rets/free-signed-${CHAIN_ID}-bundle.json"
read -r -p 'Exact INSTALL-TURNKEY-BUNDLE confirmation: ' INSTALL_CONFIRM
rootbot turnkey-bundle-install --bundle "/etc/mint-bot/Rets/free-signed-${CHAIN_ID}-bundle.json" --confirm "$INSTALL_CONFIRM"
read -r -p 'Exact REGENERATE-TURNKEY-MAP confirmation from proposal: ' MAP_CONFIRM
rootbot turnkey-wallet-map-regenerate --confirm "$MAP_CONFIRM"
bot turnkey-signing-rehearsal --policy-id "$POLICY_ID" --preview
read -r -p 'Exact REHEARSE-TURNKEY-SIGNING confirmation: ' REHEARSAL_CONFIRM
bot turnkey-signing-rehearsal --policy-id "$POLICY_ID" --confirm "$REHEARSAL_CONFIRM"
```

Stop at any error. A signed-family rehearsal checks the entire provider fleet
inventory and signs one deliberately non-broadcastable synthetic transaction
with the first wallet. Only the transaction hash/activity evidence is retained;
no broadcast or real-drop authority is claimed by that synthetic rehearsal.
Live signing separately verifies current free signed-drop authority and exact own-wallet authorization against two
distinct RPC hosts at a common recent block, then rechecks the canonical
reservation, kill switch, simulation and grant before provider signing.

Repeat for Base (CHAIN_ID=8453, QUANTITY=4), then Robinhood (CHAIN_ID=4663,
QUANTITY=10). Set the matching CHAIN_ID on BOTH computers each time and download
the latest current bundle. Do not reuse an older bundle that drops another
still-active policy. Existing provider ALLOW policies must remain covered by
current signed catalog records; renewal can reuse exact matching provider text.

After all three succeed, restart the service with the kill switch engaged.
Retain previous signed generations/rotation evidence. Refresh release-bound
D-017 artifacts and owner acceptance for the final reviewed release and changed
custody state; collect evidence once for the final combined setup, not once per
chain. Rehearse any other retained policy whose required evidence is stale.
Only then begin owner-controlled monitored commissioning as documented in
phase4-acceptance.md. No qualifying event means acceptance stays pending.

## Explicit signed chain baseline

The existing permanent public/free-allowlist baseline continues to cover those methods. It does not cover signed mints. Review actual signed-method protocol rehearsal evidence first; the synthetic custody-only rehearsal above is not protocol/eligibility evidence. Engineering must provide the independently reviewed rehearsal artifact before you approve the extension. Wallet eligibility and exact signature validity are freshly checked again for every mint.

For Ethereum, after reviewing the artifact, run a preview with an opaque reviewed-artifact reference (a sha256 digest or safe artifact ID, not credentials):

```bash
read -r -p 'Reviewed signed-method rehearsal reference: ' SIGNED_REHEARSAL_REF
bot chain-evidence status --validity permanent --include-free-signed --free-signed-rehearsal-reference "$SIGNED_REHEARSAL_REF"
```

Review the distinct printed signed-inclusive phrase, then use the returned accept command with that exact reference and `--confirm`. This is owner acceptance, not an engineering attestation.

For Base and Robinhood, preserve the completed original enablement evidence file and add a genuine `freeSignedRehearsal` step at its top level, using the same `{passed:true,checkedOn:<actual YYYY-MM-DD>,reference:<reviewed artifact>}` structure as the other steps. Do not manufacture a pass. Ask engineering to validate the exact file before recording. Then preview the applicable command:

```bash
bot base-enable status --evidence-file /actual/path/to/completed-base-evidence.json --include-free-signed
# OR, on Robinhood:
bot robinhood-enable status --evidence-file /actual/path/to/completed-robinhood-evidence.json --include-free-signed
```

Use only the exact record command and confirmation printed for the reviewed file/chain. Paid Base/Robinhood remain disabled. This extension is permanent until revoked; fresh per-mint source/signature/chain/custody/simulation checks remain mandatory.

After all intended custody and chain-scope changes, collect the final reviewed release's D-017 evidence once and request acceptance of the exact hashes. Start with the kill switch engaged; the owner decides whether to release it. A ready idle service is not authorization for an individual mint. Continue retained-history commissioning without forcing an NFT purchase.
