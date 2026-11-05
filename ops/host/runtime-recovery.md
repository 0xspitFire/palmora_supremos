# Telegram and discovery recovery after T-103

Use the reviewed T-103 release after its PR is approved and merged. Installed
5c20321 / 0.0.10 does not contain these corrective changes. Owner public-family
setup and D-017 acceptance completed on that release remain valid until their
normal expiry or an invalidating change; they are not the cause of the overload.

## Install the reviewed correction

From the development checkout after merge:

```bash
bash ops/host/deploy-release.sh --project mintbot-508813 --zone us-east4-b --instance palmora-bot-prod
```

The helper pins merged main, checks the immutable artifact and native hashes,
keeps the kill switch engaged and retains rollback. Preserve the current fleet,
signed policies, catalog and database. No new provider policy, NFT contract,
wallet import or owner approval key is needed merely for this patch.

On the host:

```bash
readlink -f /opt/mint-bot/current
sudo grep -E '^(commit|version)=' /opt/mint-bot/current/RELEASE
systemctl show mint-bot.service --property=ActiveState --property=SubState --property=NRestarts
sudo test -f /var/lib/mint-bot/killswitch && echo 'Kill switch engaged'
curl --fail --silent --show-error http://127.0.0.1:8780/healthz
```

An active service with successful liveness may correctly report Blocked while
the switch is engaged. A new release invalidates release-bound D-017 acceptance;
refresh technical evidence and obtain owner acceptance after final configuration
is stable. Reuse unchanged custody scope and fleet; do not recreate them.
The approved treasury flags remain in the existing mint-bot.env. Do not restore
the disabled treasury systemd drop-in: the supervision collector requires none.

## Check recovery before commissioning

- Review `/status` and `/health`. Completed startup reconciliation must not be
  mislabeled as unfinished merely because the switch remains on. Missing fresh
  run-specific readiness is still a real gate, refreshed before live arm/execute.
- Check reply latency and removal of a freshly sent owner `/unlock` code. Do not
  paste codes into logs or chat. If Telegram refuses deletion, the new fixed
  diagnostic is `UNLOCK_MESSAGE_DELETE_FAILED`; delete the message manually and
  investigate the provider refusal. Stale codes remain refused.
- Observe backlog recovery across normal retry cycles. Telegram `retry_after`
  now defers the shared channel durably; retry batches prioritize critical/run
  notices. No failed notification is marked delivered without a real response.
  Persistent `NOTIFICATION_DELIVERY_DEGRADED` requires investigation; do not edit
  SQLite rows or suppress health to hide it.
- Gap summaries are limited to one per chain bucket per 15 minutes, including
  an explicit unknown bucket for legacy records. Original unread ranges remain
  in audit history. Repeated genuine gaps still mean discovery coverage is
  incomplete; inspect scan duration, cursor lag and RPC failures. Unit tests do
  not certify production speed or uninterrupted coverage. Do not stress-test
  production by deliberately generating hundreds of Telegram messages.

## Resolve the recognized wallet incident separately

After the correction and owner evidence acceptance, use the owner's private chat:

```text
/unlock <current authenticator code>
/watchaccept ethereum 0x9d8c15fb93b8e2469b1d3d79b569acfdc0022b5b
```

Review the fresh nonce/balance and on-chain outgoing transactions before the
normal confirmation. Nonces 7 and 8 are the previously recognized treasury-return
incident (observed next nonce 9); any later unknown change needs its own review.
Acceptance changes only that wallet's Ethereum baseline. It does not release
the switch. Check `/requests` and `/runs`, then the owner may use `/release` and
its confirmation when current funding, grants, custody, notifications and every
other gate are satisfied. No engineering script releases it silently.

Qualified free automatic activity still requires score >=70 plus a verified
watched self-mint and all normal gates. Paid mints retain final owner fire
approval. Review real autonomous history with `ops/host/phase4-acceptance.md`;
manual `/fire` is not an autonomous commissioning sample. No new fixed-duration
trial or forced mint-count quota is required.
