# Bounded automatic funding — activation after source review

This guide describes the D-092 development workflow. It does not activate a funding hub. Do not use a cold-treasury key or the mint-runtime credential for this role. The currently installed release does not contain this work until its reviewed PR is merged and installed.

The owner approves a reusable per-chain funding profile once. After activation, the backend computes an approved run's exact shortfall automatically, holds its mint exposure, funds only the signed fleet, waits for final arrival and repeats current qualification/simulation before arming. It never refills idle wallets, sweeps assets, bridges, pays an NFT price without the exact approved paid intent, or repeats an ambiguous funding signature.

## 1. Choose the operational hub

Create a small standalone Turnkey operational key in a separate funding organization. Keep owner/admin policy authority outside both service credentials. One operational address can be used on multiple EVM chains only when each chain has its own signed record and budget; this does not bridge its funds. The existing ten mint wallets remain recipients. Do not export their keys.

Provide only the public organization/user/key identities, hub address and intended chains to engineering. Do not paste API private keys or an approval private key in support chat. The runtime credential can sign only the generated native-transfer policy. It cannot administer policies or sign arbitrary calldata.

Approved maximums per chain: rolling24h principal0.0085ETH, funding fees0.0002ETH, each transfer all-in fee0.00002ETH, hub balance0.0087ETH. Existing lower mint and fleet balance limits still apply. Ethereum/Base native gas bound21000; Robinhood can require Nitro L1-inclusive gas, bounded at100000 and always within the same all-in fee ceiling. Fund the operational float manually; no cold-treasury auto-refill is implemented.

## 2. Prepare the public record and exact provider policy

Engineering prepares an owner-readable public JSON record for each chain with the chosen identities, recipient set, approved bounds, finite issue/expiry dates and actual provider policy ID. The CLI computes canonical wallet-set and budget-profile digests. A placeholder provider ID may be used for the first policy preview, but replace it with the real dashboard policy ID before signing.

On the signing computer, set `CLI_PATH` to the built, reviewed CLI entrypoint. Preview the record:

```bash
node "$CLI_PATH" funding-policy preview \
  --input "$PUBLIC_FUNDING_RECORD" \
  --approver-public-key "$APPROVER_PUBLIC_KEY"
```

Create exactly the printed `providerPolicy` in the funding organization's owner/admin dashboard, then enter its actual ID into the public record and preview again. Repeat once for each intended chain. Keep existing mint policies unchanged. Public JSON omits `time`; never add `time:null` in the dashboard.

## 3. Offline owner signature

Review the hub, chain, complete recipient list, expiry and every bound. Run the sign preview first:

```bash
node "$CLI_PATH" funding-policy sign \
  --input "$PUBLIC_FUNDING_RECORD" \
  --approver-public-key "$APPROVER_PUBLIC_KEY"
```

Use the exact returned confirmation locally:

```bash
node "$CLI_PATH" funding-policy sign \
  --input "$PUBLIC_FUNDING_RECORD" \
  --approver-public-key "$APPROVER_PUBLIC_KEY" \
  --approval-key "$OFFLINE_APPROVAL_KEY" \
  --output "$SIGNED_PUBLIC_FUNDING_RECORD" \
  --write --confirm "$EXACT_CONFIRMATION"

node "$CLI_PATH" funding-policy verify \
  --input "$SIGNED_PUBLIC_FUNDING_RECORD" \
  --approver-public-key "$APPROVER_PUBLIC_KEY"
```

The output is a signed public record, not a private key. Existing output files are never overwritten. Transfer only public signed records/public verification keys to the host. Keep the offline approval private key off the host.

## 4. Install separate signing and broker profiles

Engineering configures the concrete, independently reviewed profile paths and service identities. A root-owned worker profile binds distinct nonroot worker and broker UIDs, a unique journal ID and private journal path, socket identity/group, broker public key, owner public key, signed catalog, funding-only credential and two HTTPS reader hosts per chain. The worker receives no main database or mint secret-root path. Its private journal reserves principal and fees before signing and carries ambiguous exposure across date resets and restarts.

The mint broker receives only the socket, public policy catalog, public verification keys and a separate short-lived admission-signing key. This admission key is not the owner's offline approval key. Root-owned broker configuration is selected by `MINT_BOT_FUNDING_PROFILE_PATH`; absence keeps funding disabled. The funding credential is an explicit protected `turnkey-funding.env`, never a fallback to `turnkey.env`.

The separate worker is launched from its reviewed `native-funding-worker.js` entrypoint with a root-owned profile path. Service supervision, Unix permissions, readable chain configuration, private journal backup and witness/restore checks must be validated before operational activation. Do not give the funding worker the `mintbot` group to make permission errors disappear.

## 5. Commission and accept

After source/security review, verify live provider identity and exact complete policy inventory, current whole-fleet digests and finite owner records. Run the independently reviewed no-broadcast rehearsal, then obtain the owner's explicit bounded transfer/arrival commissioning authority. A local Anvil exercise is not this commissioning.

Validate actual final arrival and both ledgers without creating a mint automatically as a test. Refresh release/configuration-bound infrastructure evidence and obtain exact owner acceptance before activation. The owner decides when the new funding profile becomes live. T-098 genuine autonomous mint commissioning remains separate.

Funding waits for the existing independent finality requirements, including the underlying settlement checks on L2s. A fast mint can close or its watched-source authority can expire before a top-up becomes final. The service then stops mint preparation; it does not weaken finality or sign from a stale opportunity. Already funded eligible wallets take the direct preparation path without an unnecessary funding transaction. Automatic funding improves availability, but does not guarantee arrival inside a short mint window.

## Paid Ethereum funding is a separate approval

Once a funding profile is commissioned, an unlocked owner can use `/fundpaid` in the bot's private chat to preview a paid Ethereum campaign's exact funding needs. The preview supplies an exact `/fundpaid confirm … FUNDING-ONLY` command. Check the campaign, quantity, price, recipients, fee ceiling, shortfalls and expiry before confirming. This authorizes funding only, lasts at most 15 minutes and remains bound to the current unlocked owner session and unchanged stage/custody. Paid Base and Robinhood remain disabled.

The host waits for final funding arrival, runs fresh simulations and sends a prepared notification. A subsequent normal `/fire` approval is still required to mint. A revoked/expired session, changed campaign, larger shortfall or ambiguous transfer stops further funding; already signed exposure stays reserved and reconciled. The equivalent owner CLI is `paid-funding preview|confirm|status`; it writes the public approval queue and never opens the hub credential or executes transfers itself.

The exact private-journal initialization, backup and deliberately blocked-restore procedure is in [native-funding-journal.md](native-funding-journal.md). A normal worker start never creates an empty replacement journal. Missing, corrupt or restored-unreconciled history keeps funding disabled; neither a date reset nor a file replacement proves previous signed exposure absent.

Both funding ledgers revisit settled transfers through bounded durable history rotation. If two readers positively prove a replacement canonical block, the original exposure reopens. The canonical ledger stops dependent minting and immediately makes affected funding costs and adaptive outcome lineage untrusted. A missing receipt alone is not reorg proof and never releases funds. Reconciliation can continue after signing authority or the owner session expires. After verified reinclusion, review the funding history before the normal explicit safety release; an invalidated model is not silently restored from its old cached acquisition cost.
