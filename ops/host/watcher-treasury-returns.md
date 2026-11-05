# Verified treasury returns and repeated watcher alerts

Use a reviewed release containing T-101 and T-102. The watcher is independent on
Ethereum, Base and Robinhood: an account's transaction on one chain never changes
its nonce on another chain. Wrong-chain RPC readings are rejected. Attempts and
reservations without a known chain cannot explain activity on a different chain.
This does not change spend accounting or release pending reservations.

## Enable the approved destinations

Keep the kill switch engaged while installing/configuring the reviewed release.
Edit the existing service environment as the host administrator:

```sh
sudoedit /etc/mint-bot/mint-bot.env
```

Preserve the existing `MINT_BOT_TREASURY_ADDRESS` and add/update these settings
without duplicate definitions:

```ini
MINT_BOT_WATCH_TRUSTED_TREASURY_RETURNS=true
MINT_BOT_WATCH_TREASURY_DESTINATIONS='["0x365952EB1E8209Bf2BCc2db5ED213111a87D061e"]'
```

The existing configured treasury is automatically included. These are global
trusted destinations across the integrated chains, not a new chain grant. When a
future chain is integrated, reuse this list, but explicitly implement/test its
receipt and fee semantics before enabling its verifier. No per-mint policy is
created and no third-party account or credentials are added for this feature.

Restart using the normal supervised deployment procedure. Check `/status`,
`/health` and the service journal. Restart requires the kill switch engaged under
the existing service pre-start rule; this guide does not release it.

## What the exemption proves

Only a complete interval of successful plain positive native-currency returns to
approved EOA destinations qualifies: empty calldata, no approvals, delegated-code,
blob or authorization transactions, no self-transfer. Two distinct HTTPS RPC hostnames
must agree on the actual chain, recent common block, transactions, successful
receipts, balances and complete fees. The recent common block is two blocks behind
the lower head; it is corroboration, not a new finality certification.

The historical search is limited to eight unexplained nonces and 65,536 blocks,
with a 20-second verification budget and five-second per-request timeout. Aggregate
fees must fit the existing per-wallet idle balance ceiling; all balance loss must
be explained. No exemption is allowed while a run is armed/active or this wallet
has unresolved reservation exposure. Unknown-chain pending exposure also blocks.
Proof and baseline are stored atomically with a fresh execution-exposure check.
A proven return advances only that wallet's baseline on that chain and records
`fleet_watch_treasury_return_verified`; it never releases an existing kill switch,
changes caps or disables watching. Subsequent unexplained movements still stop
execution. Balance ceilings and excess-balance reminders remain active.

Pruned history, stale/common-block mismatch, missing L2 fee fields, unavailable
providers or disagreement retain the normal watcher stop/review behavior. Base
requires explicit L1 and operator fee evidence; Robinhood requires explicit L1 fee
evidence. A configured treasury address alone is never sufficient. Token/NFT
transfers and contract interactions are not whitelisted by this setting.

## Resolve an existing stop

Releasing the switch without reviewing an unresolved baseline allows the next
watcher check to stop execution again. A 12-hour unlocked session is a maximum
lifetime, not an exemption from safety stops.

For the already recognized Ethereum incident, in the owner's private Telegram
chat:

1. `/unlock <current authenticator code>`
2. `/watchaccept ethereum 0x9d8c15fb93b8e2469b1d3d79b569acfdc0022b5b`
3. Review the *current* nonce, balance and on-chain outgoing transactions, then
   use the flow's confirmation. Only nonces 7 and 8 were recognized in the prior
   incident; investigate any later unknown activity before accepting it.
4. Check `/status` and `/health`; release the kill switch separately only when
   ready under the normal owner procedure.

The second occurrence of an identical stopping finding offers **Review / I took
action**. It opens the same fresh owner/private-chat/authenticated review and
confirmation. It does not acknowledge activity with one blind tap. Once confirmed,
the baseline changes for that chain/wallet and the old finding stops; a later
unexplained change creates a new alert. Repeat reminders are deduplicated after
the first review reminder, and can reappear on a new safety-stop episode or day.
Persisted findings survive service restarts.
