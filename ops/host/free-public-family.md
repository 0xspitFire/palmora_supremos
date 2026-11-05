# Reusable bounded free public SeaDrop policy setup

Requires the reviewed T-100 release. Release 86e3a87 does not support the new
`--free-public-family` flag. Deploy the merged reviewed release first, keeping
the kill switch engaged. New release/host-bound evidence must be current before
commissioning. This guide never deletes the preserved exact Robinhood policy or
the existing allowlist families. No new wallet fleet or approval key is needed.

Do one chain completely before the next. Use Ethereum 1, Base 8453, Robinhood
4663. Approved maximum quantity is 10 on Ethereum/Robinhood, 4 on Base. Public
and allowlist policies are separate; both can remain in the signed catalog.

## Production host — prepare and snapshot the provider policy

```bash
sudo test -f /var/lib/mint-bot/killswitch && echo 'Kill switch engaged'
sudo systemctl stop mint-bot.service
bot() { sudo -u mintbot bash -c 'set -a; . /etc/mint-bot/mint-bot.env; set +a; cd /opt/mint-bot/current && exec /usr/bin/node packages/cli/dist/index.js "$@"' _ "$@"; }
rootbot() { sudo bash -c 'set -a; . /etc/mint-bot/mint-bot.env; set +a; cd /opt/mint-bot/current && exec /usr/bin/node packages/cli/dist/index.js "$@"' _ "$@"; }
CHAIN_ID=1
case "$CHAIN_ID" in 1|4663) QUANTITY=10;; 8453) QUANTITY=4;; *) echo 'Unsupported chain';; esac
renew_public() {
  bot turnkey-policy-renew --free-public-family --chain-id "$CHAIN_ID" \
    --quantity "$QUANTITY" --valid-hours 720 --gas-limit-max 500000 \
    --max-fee-gwei 0.2 --priority-fee-gwei 0.1 \
    --policy-output "/etc/mint-bot/Rets/free-public-${CHAIN_ID}-ast.json" \
    --proposal-output "/etc/mint-bot/Rets/free-public-${CHAIN_ID}-proposal.json" \
    --state-output "/etc/mint-bot/Rets/free-public-${CHAIN_ID}-state.json" "$@"
}
renew_public
```

Proceed only when the kill check printed engaged. Create the exact returned
effect, consensus and condition in the owner's Turnkey dashboard if the result
says provider-policy-required. Omit `time` when null. Do not widen the condition,
rename/change existing policies, or create a duplicate if the tool finds a match.
The runtime credential never administers policies.

```bash
read -r -p 'Matching public Turnkey policy ID: ' POLICY_ID
renew_public --policy-id "$POLICY_ID" --apply
```

Expect awaiting-offline-signature; verify the chosen chain, policy, fleet and
limits. Retain its mapConfirmation. Only the unsigned proposal was written.

## Signing computer — copy, review and sign

Set the same CHAIN_ID on this computer. Use a fresh directory for this signature.
The current installed bundle must be downloaded again after each chain install.

```bash
CHAIN_ID=1
umask 077
OFFLINE_ROOT=$(mktemp -d "$HOME/mintbot-public-${CHAIN_ID}-XXXXXX")
CLI_PATH=/home/Junayd/W3/MintBot/packages/cli/dist/index.js
gcloud compute ssh palmora-bot-prod --project mintbot-508813 --zone us-east4-b --tunnel-through-iap --command="sudo cat /etc/mint-bot/Rets/free-public-${CHAIN_ID}-proposal.json" > "$OFFLINE_ROOT/free-public-${CHAIN_ID}-proposal.json"
gcloud compute ssh palmora-bot-prod --project mintbot-508813 --zone us-east4-b --tunnel-through-iap --command='sudo cat /etc/mint-bot/Rets/turnkey-policy-bundles/current.json' > "$OFFLINE_ROOT/existing-bundle.json"
jq -e . "$OFFLINE_ROOT/free-public-${CHAIN_ID}-proposal.json" >/dev/null
jq -e . "$OFFLINE_ROOT/existing-bundle.json" >/dev/null
```

Stop if either transfer/JSON check failed. CLI_PATH must be the current reviewed
built CLI on the signing computer. Set the existing key's actual path outside
OFFLINE_ROOT; keep that private key off the production host:

```bash
APPROVAL_KEY='/actual/path/to/existing-approval-key'
chmod 600 -- "$APPROVAL_KEY"
sign_public() {
  MINT_BOT_SECRET_ROOT="$OFFLINE_ROOT" node "$CLI_PATH" turnkey-policy-sign \
    --proposal "$OFFLINE_ROOT/free-public-${CHAIN_ID}-proposal.json" \
    --private-key "$APPROVAL_KEY" --existing-bundle "$OFFLINE_ROOT/existing-bundle.json" \
    --record-output "$OFFLINE_ROOT/free-public-${CHAIN_ID}-record.json" \
    --public-key-output "$OFFLINE_ROOT/free-public-${CHAIN_ID}-approver.pub" \
    --catalog-output "$OFFLINE_ROOT/free-public-${CHAIN_ID}-catalog.json" \
    --bundle-output "$OFFLINE_ROOT/free-public-${CHAIN_ID}-bundle.json" "$@"
}
sign_public --preview
```

Review the same fleet, newly selected chain/policy and exact displayed signature
confirmation. New output paths must be unused. Then:

```bash
read -r -p 'Exact SIGN-TURNKEY-POLICY confirmation: ' SIGN_CONFIRM
sign_public --confirm "$SIGN_CONFIRM"
gcloud compute scp --project mintbot-508813 --zone us-east4-b --tunnel-through-iap "$OFFLINE_ROOT/free-public-${CHAIN_ID}-bundle.json" "palmora-bot-prod:/tmp/free-public-${CHAIN_ID}-bundle.json"
```

## Production host — install, regenerate, rehearse

Keep the same CHAIN_ID and POLICY_ID from the host preparation above.

```bash
sudo install -o root -g mintbot -m 640 "/tmp/free-public-${CHAIN_ID}-bundle.json" "/etc/mint-bot/Rets/free-public-${CHAIN_ID}-bundle.json"
rootbot turnkey-bundle-install --bundle "/etc/mint-bot/Rets/free-public-${CHAIN_ID}-bundle.json"
read -r -p 'Exact INSTALL-TURNKEY-BUNDLE confirmation: ' INSTALL_CONFIRM
rootbot turnkey-bundle-install --bundle "/etc/mint-bot/Rets/free-public-${CHAIN_ID}-bundle.json" --confirm "$INSTALL_CONFIRM"
read -r -p 'Exact REGENERATE-TURNKEY-MAP confirmation from proposal: ' MAP_CONFIRM
rootbot turnkey-wallet-map-regenerate --confirm "$MAP_CONFIRM"
bot turnkey-signing-rehearsal --policy-id "$POLICY_ID" --preview
read -r -p 'Exact REHEARSE-TURNKEY-SIGNING confirmation: ' REHEARSAL_CONFIRM
bot turnkey-signing-rehearsal --policy-id "$POLICY_ID" --confirm "$REHEARSAL_CONFIRM"
```

Stop at any error. A public-family rehearsal checks the entire provider fleet
inventory and signs one deliberately non-broadcastable synthetic transaction
with the first wallet. Only the transaction hash/activity evidence is retained;
no broadcast or real-drop authority is claimed by that synthetic rehearsal.
Live signing separately verifies current free public-drop facts against two
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
