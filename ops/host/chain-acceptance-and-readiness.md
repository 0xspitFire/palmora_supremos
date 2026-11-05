# Chain acceptance and idle readiness

This guide applies to the T-104 release containing `chain-evidence --validity`
and `--include-free-allowlist`. Installed 0.0.12 does not contain these changes.
The chain-acceptance flow is installed in 0.0.13. The policy-selection diagnostic
option below belongs to the T-105 follow-up and requires its later reviewed
release. Installing or building source does not accept evidence or release the
kill switch.

## What is permanent

Ethereum owner acceptance can now last until revoked. Base and Robinhood grants
already use that model. There is no weekly renewal of an accepted permanent
chain grant, and no per-collection chain acceptance ceremony.

This decision approves a known chain/strategy baseline. Each mint still needs
current own-wallet eligibility/proof, simulation, RPC/custody validation, fee and
funding limits, reserved worst-case exposure and finality/receipt reconciliation.
Unknown methods, changed policies and missing evidence cannot inherit permission.
Material changes still require their applicable validation and owner review.

Signed Turnkey records have their own expiry/renewal process. D-017 evidence has
its own tiered/event-driven expiry. In particular, backup/restore and recovery
checks remain periodic. Permanent chain acceptance does not change either one.
Old finite chain records keep their original expiry unless the owner explicitly
accepts a new permanent record. Revocation never revives an older grant.

## One host helper

Run on the production host. The helper uses the configured service environment
without printing it. Do not copy API credentials or approval private keys here.

```bash
mbcli() {
  sudo systemd-run --quiet --wait --pipe --collect \
    --property=User=mintbot --property=Group=mintbot \
    --property=NoNewPrivileges=yes --property=UMask=0077 \
    --property=WorkingDirectory=/opt/mint-bot/current \
    --property=EnvironmentFile=/etc/mint-bot/mint-bot.env \
    /usr/bin/node /opt/mint-bot/current/packages/cli/dist/index.js "$@"
}
mbcli rpc-health
```

## Ethereum

1. Review the genuine chain/strategy rehearsal evidence and its stated limits.
   `status` checks the RPC but does not rerun a fork rehearsal.
2. Preview permanent public authority, or explicitly include the approved free
   allowlist strategy if its evidence and installed custody family are reviewed:

   ```bash
   mbcli chain-evidence status --validity permanent --include-free-allowlist
   ```

3. Read the actual existing and requested scope. If `copyThisToAccept` is
   returned, run that exact command with `mbcli` prepended. Its confirmation
   names the permanent validity and, when selected, chain 1/public-plus-free-
   allowlist scope. This is an owner decision; engineering does not enter it.
4. Repeat the status command and verify the actual scope and permanent expiry.
   A public-only permanent grant is not an allowlist grant. Omit the flag if
   accepting public-only authority intentionally.

Seven-day legacy authority is available explicitly with `--validity 7-days`.
It is not automatically extended or recommended for the once-approved baseline.
To revoke, run `mbcli chain-evidence revoke`, review the returned ID-bound
`copyThisToRevoke`, and run it with `mbcli` prepended. Submitted transactions
still require reconciliation after revocation.

## Base

A recorded Base grant is already permanent. Inspect it without an evidence file:

```bash
mbcli base-enable status
```

For a new or materially changed grant, engineering must supply genuine complete
technical evidence first. At the 5 November T-104 assessment the strict local
Base settlement rehearsal still fails because Anvil omits required receipt L1
fee fields. Partial passing simulations and historical receipts do not close that
check. **No complete Base evidence file is available from that assessment.** Do
not edit dates, mark failed checks passed, or substitute owner acceptance for it.
This is an engineering/environment blocker, not a request for a live NFT
contract or an owner signature.

After engineering supplies and independently reviews a complete file, install
that exact file with service-readable protected permissions, then preview:

```bash
sudo install -o mintbot -g mintbot -m 0600 \
  /tmp/base-evidence-reviewed.json \
  /var/lib/mint-bot/evidence/base-enable-evidence.json
mbcli base-enable status \
  --evidence-file /var/lib/mint-bot/evidence/base-enable-evidence.json \
  --include-free-allowlist
```

Review all seven checks and `copyThisToRecord`. Run the returned command with
`mbcli` prepended only after approval, retaining its exact digest/scope phrase.
Do not add `--paid` for free-only activation. Then inspect `base-enable status`
without a file: the recorded decision lasts until revoked. Initial evidence-age
checks are requirements for making a new decision, not recurring grant expiry.

## Robinhood and explicit allowlist scope

Existing permanent public authority stays public-only. Installing a signed
allowlist family does not silently widen that chain decision. To approve public
plus free allowlist once, use the existing reviewed Robinhood evidence file:

```bash
mbcli robinhood-enable status \
  --evidence-file /path/to/the-reviewed-robinhood-evidence.json \
  --include-free-allowlist
```

Replace the example path with the actual file. If initial evidence is too old
or incomplete for this changed-scope decision, obtain the genuine required
checks; do not rewrite their dates. Run the returned `copyThisToRecord` with
`mbcli` prepended after reviewing it. The phrase explicitly names chain 4663 and
the added free-allowlist scope. This does not enable paid allowlist execution.
There is no repetition per mint or weekly renewal after permanent acceptance.

## Verify health and activate newly enabled discovery

The old idle `RUNTIME_PROBE_REQUIRED` result could occur with no live campaign,
job or unsettled exposure: no campaign had created a probe yet. The fix reports
current idle service health separately and says mint checks are refreshed during
preparation/arming. `Ready` is not mint permission. Active or queued live work,
unknown execution context and unresolved exposure still require fresh probes.
A general service report cannot independently assess a campaign-specific
compensating-custody policy without its trusted configuration. It reports that
authorization as `NotChecked`, explicitly, while validating observable health
and freshness. It never derives trusted policy or funding limits from the probe
itself. The execution coordinator supplies that trusted context and must complete
the full checks before arming/execution; an unassessed service report is not mint
permission.

1. After the reviewed release/authority changes, follow the normal controlled
   restart procedure. Startup requires the kill file: use private Telegram
   `/kill` and confirm before `sudo systemctl restart mint-bot.service`.
2. Verify `systemctl is-active mint-bot.service`, `/rpc`, `/enablement`, `/status`
   and `/health`. A new Base grant needs restart to initialize its discovery
   timer. A real engaged switch still reports Killed.
3. Verify D-017 with the supported checker. A new release can invalidate
   release-bound artifacts; refresh only what it actually invalidated and obtain
   the owner's acceptance of changed artifact hashes. Do not copy an old
   acceptance to a new release or change its dates.
4. Once the real blockers are resolved and the owner is ready, use private
   `/unlock` and `/release` with the bot's current confirmation. Never share an
   authenticator code. Engineering does not release the switch for this change.
5. If an idle service still reports a blocker, retain the exact codes. Do not
   prepare a dummy campaign, fabricate a runtime probe or bypass reconciliation.

Retained-history commissioning still needs genuine autonomous activity with
nonempty clean replication/execution audits, finality and ledger agreement, plus
the observed same-chain collection convergence example. Empty findings with
`no_samples` are not certification. Manual `/fire` does not substitute for an
autonomous sample.

## Inspect one exact custody policy (T-105 release)

The read-only diagnostic can assess an explicit policy from the locally verified
owner-signed catalog:

```bash
mbcli compensating-controls-status --chain-id 4663 --policy-id <signed-policy-id>
```

Use the actual provider policy ID already installed in the signed catalog. The
output identifies the actual chain, policy ID, family (or exact-policy scope) and
record digest before showing all six controls. Rehearsal and funding checks use
that same selected record and chain. A provider's observed policy list does not
authorize a new selection.

Omitting `--policy-id` retains the active-policy default only on its own chain.
For example, an active Base record with `--chain-id 4663` is refused before any
provider/RPC inspection; name the intended signed Robinhood policy instead.
Unknown, ambiguous and cross-chain selections are refused rather than falling
back to a different policy. This command does not create a policy, sign a
transaction, record chain authority, approve a mint or release the switch.

Installed 0.0.13 predates this selector: its diagnostic uses the global active
record even when a different chain is requested. That display limitation was
worked around during closeout using exact signed-record-scoped checks. The
production coordinator already selects and validates custody per campaign; its
authorization guards are unchanged. The diagnostic fix can accompany a later
planned release; it does not require another deployment or invalidate the
current release's five D-017 artifacts merely because it is prepared in source.
