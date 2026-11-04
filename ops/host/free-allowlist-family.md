# Reusable free SeaDrop allowlist family

After T-098 has passed independent security review, been reviewed and merged,
and the resulting release is installed, an owner can approve one family per
existing enabled chain and fleet. An NFT contract is not needed for this setup.
Existing public-family policies are separate and must remain in the signed
catalog if they remain enabled in Turnkey.

On the host, engage the kill switch through the normal bot procedure and stop
the supervised service during the provider/catalog transition. Creating the new
provider policy before its owner-signed catalog is installed temporarily makes
the provider inventory differ from the installed bundle; a running service would
fail its drift check until the new bundle is installed. Stop it deliberately:

```sh
sudo systemctl stop mint-bot.service
```

Define
this shortcut in your host shell; it loads the existing service environment
without printing it and runs the CLI as `mintbot`:

```sh
bot() { sudo -u mintbot bash -c 'set -a; . /etc/mint-bot/mint-bot.env; set +a; cd /opt/mint-bot/current && exec /usr/bin/node packages/cli/dist/index.js "$@"' _ "$@"; }
```

Keep credentials in the existing secret store. The following read-only preview
uses the installed wallet map and prints the provider policy:

```sh
bot turnkey-policy-renew --free-allowlist-family --chain-id 4663 --quantity 4 --valid-hours 720 \
  --policy-output /etc/mint-bot/Rets/free-allowlist-4663-ast.json \
  --proposal-output /etc/mint-bot/Rets/free-allowlist-4663-proposal.json \
  --state-output /etc/mint-bot/Rets/free-allowlist-4663-renewal.json
```

Here `bot` is the service-account wrapper already used on this host. Choose the
intended enabled chain (`1`, `8453` or `4663`) and the owner's approved quantity;
Base is capped at four. The defaults pin gas to at most 500,000, max fee to
0.2 gwei and priority fee to 0.1 gwei. Verify these are appropriate for the
existing chain policy; the generator refuses bounds outside its conservative
chain fee and per-wallet ceilings. The full fleet and provider identity must
match the installed signed catalog. The family expires: 720 hours is the current
maximum owner-signed validity, not permanent authorization.

In the Turnkey owner/admin dashboard, create the exact returned `EFFECT_ALLOW`,
`consensus` and `condition`; omit `time` if the dashboard rejects JSON `null`.
Do not widen the condition or grant the service user policy-administration
permissions. Copy its public policy ID and run the same command with
`--policy-id <ID> --apply` appended to the same command. It checks the live provider inventory and writes an
unsigned proposal. The separate names above preserve earlier rotation records and proposals. Review its chain, fleet, quantity, fees and expiry.

Use the existing pinned approval key under owner control to run
`turnkey-policy-sign --preview`, then sign the exact confirmation it prints.
When preserving an installed multi-policy catalog, pass the protected existing
bundle path with `--existing-bundle /etc/mint-bot/Rets/turnkey-policy-bundles/current.json`
and provide distinct `--bundle-output`, `--record-output`, `--catalog-output` and
`--public-key-output` names. Do not overwrite `turnkey-policy-record.json`: it
may be the previous fleet record needed for rotation evidence.
On a separate offline machine, copy only the protected public signed bundle and
proposal there, and use the local paths under that machine's configured secret
root. Never copy an approval private key into the service's runtime secret root.
For example, on the offline computer, after placing the unsigned proposal and
copy of the current signed bundle into an owner-only work directory, set
`OFFLINE_ROOT` to that directory and `APPROVAL_KEY` to the existing private key
outside it. Run the built release's CLI there (replace `CLI_PATH` with its
absolute `packages/cli/dist/index.js` path):

```sh
MINT_BOT_SECRET_ROOT="$OFFLINE_ROOT" node "$CLI_PATH" turnkey-policy-sign \
  --proposal "$OFFLINE_ROOT/free-allowlist-4663-proposal.json" \
  --private-key "$APPROVAL_KEY" --existing-bundle "$OFFLINE_ROOT/existing-bundle.json" \
  --record-output "$OFFLINE_ROOT/free-allowlist-4663-record.json" \
  --public-key-output "$OFFLINE_ROOT/free-allowlist-4663-approver.pub" \
  --catalog-output "$OFFLINE_ROOT/free-allowlist-4663-catalog.json" \
  --bundle-output "$OFFLINE_ROOT/free-allowlist-4663-bundle.json" --preview
```

All output names must be unused. Review the preview and repeat the same command
with `--confirm "<exact phrase>"` in place of `--preview`. Copy the resulting
signed bundle to the host using the existing protected transfer process; the
private approval key stays offline. Review the catalog and retain all policies
that remain enabled. Install the resulting bundle using the existing
preview/confirmation sequence for
`turnkey-bundle-install`, then regenerate the map and run
`turnkey-signing-rehearsal --policy-id <ID> --preview` while the kill switch is
engaged. Repeat with its exact `--confirm` phrase in place of `--preview`.
Evidence is stored separately for each signed policy-record digest, so adding
this family does not overwrite the evidence for a retained public policy. A
legacy single-policy rehearsal file is still recognized when its digest matches.
Rehearse any retained signed policy that lacks current evidence by using its
policy ID and its own preview/confirmation. Then restart the service and verify
status and the compensating controls.
No new key or wallet rotation is implied by adding a policy.

For this family the no-broadcast rehearsal signs a synthetic zero-value,
zero-gas transaction with an impossible NFT address using the first wallet and
returns only its hash and provider activity evidence. The provider probe checks
the full signed fleet inventory. The transaction verifies provider authorization
and the signature boundary for that wallet; it does not claim that a real collection's Merkle proof or
RPC authority was checked. Live allowlist signing separately requires a fresh
own-wallet proof, two agreeing current RPCs, permitted fee recipient, valid
stage, campaign/simulation and all normal admission and spend checks.

The runtime never creates or administers Turnkey policies. Existing owner-signed
families are automatically selected for later eligible free drops until their
record expires or their scope changes. Paid mints are outside this family.
See `replication-automation.md` for discovery and final-release gates.

## Dashboard renames and installation ownership

A dashboard rename changes `policyName` and `updatedAt`. Live provider checks
allow those two metadata fields to differ from the historical signed snapshot;
the signed snapshot and its digest are not rewritten. Policy IDs, creation
timestamps, notes, effects, consensus, conditions and time restrictions remain
pinned. Every live ALLOW policy still needs an approved catalog entry (or must
be the exact new policy currently being proposed). Unknown policies and changes
to authority continue to block. This rename handling requires a release that
includes T-099; c9aab25 still rejects cosmetic drift.

When transferring a newly signed bundle to the host for `turnkey-bundle-install`,
stage it as `root:mintbot` with mode `0640` and run installation as root. A
service-owned `mintbot:mintbot` mode `0600` staging file is intentionally rejected
by the root verifier. Do not change ownership of an entire secret directory.
