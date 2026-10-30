# D-017 evidence expiry and Telegram reminders

MintBot uses the `tiered-v1` evidence profile for unattended-operation gates:

| Evidence | Maximum age |
| --- | ---: |
| Recovery drill | 7 days |
| Backup/restore drill | 7 days |
| Wallet rotation/revocation | 30 days, and immediately invalidated by a custody or wallet-generation change |
| Heap/core-dump policy | 30 days |
| Service supervision | 30 days |
| Approved infrastructure design | 90 days |

The owner acceptance record may be valid for up to 30 days, but it cannot extend an artifact past its own maximum age. Release and host identity changes remain bound to the artifacts and invalidate the acceptance. A deployment or custody workflow can force immediate invalidation by changing the 64-hex `MINT_BOT_OPS_EVIDENCE_EVENT_DIGEST` value in the service environment and then obtaining a new owner acceptance.

When Telegram is enabled in host mode, the orchestrator checks the evidence state hourly by default. The administrator receives a durable status alert when evidence is missing or stale, a reminder three days before an artifact or acceptance expires, and an expiry-day alert. Every message names the affected item and the next action. Set `MINT_BOT_OPS_EVIDENCE_REMINDER_INTERVAL_MS` to a value of at least 60000 to change the check interval.

To accept a fresh set of artifacts, use the existing owner command. It creates the tiered record and binds it to the current release, host, artifact digests, and event digest:

```sh
sudo node scripts/ops-evidence-accept.mjs \
  --design-sha256 <approved-design-sha256> \
  --witness "<owner and witness time>"
```

Run the printed command again with its `--confirm` phrase. No reminder or runtime check can create or accept evidence on behalf of the owner.
