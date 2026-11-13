# Wallet administration: separate trusted Linux worker

This is a deployment proposal for the T122/T127 source. Nothing here is installed automatically. Keep the current production service/configuration unchanged until independent review, source deployment and the owner's concrete policy/profile acceptance. The owner approval private key stays offline.

The worker is trusted to write the canonical database. This is the same integrity boundary as an owner operating the local CLI, with a separate create/import-only Turnkey credential. It has no transaction signing/export/policy-administration authority, and newly created/imported keys never enter the signed mint fleet automatically. Existing chain baselines, mint caps, funding limits and D019 reservation admission remain in their existing coordinator path.

SQLite cannot apply an operating-system ACL to selected tables or rows. A worker with database write access can alter every canonical record; directory write access also permits SQLite sidecar creation. Do not describe this deployment as a sandbox against a compromised worker. The named-user ACL below limits the files it can access, not the database statements it can execute. The mint service must not be able to read the worker credential, execute as its UID, modify its installed code, or edit its root-owned isolation profile.

A provider-only IPC helper would isolate database access from the credential process, but would not authenticate approvals held in a database writable by the mint service. Under the selected owner-trusted-worker boundary it adds a second protocol without removing this trust assumption. If protection against a compromised canonical DB writer issuing create/import requests becomes required, use owner-signed bounded request envelopes verified in a separate credential worker, independent replay storage, and a broker that only projects public results. The current database queue is not that cryptographic boundary. Do not expose this worker as a network/Telegram credential endpoint.

## Identities and paths

Use an existing independently selected nonroot mint identity (`mintbot` below) and a NEW nonroot `mintwalletadmin` identity with a private primary group and no supplementary groups. Never add it to the mint service group, root group, Docker group, or a group that can read mint/funding credentials. The examples use these reviewed paths; substitute the exact existing canonical DB and kill-file paths before making the profile. Do not move a live DB by copying it while open.

| Path | Access |
| --- | --- |
| `/opt/mintbot/releases/<reviewed-release>` | root owned, worker read/execute only; shared source contains no credentials |
| `/etc/mintbot-wallet-admin/isolation.json` | root owned,0644, root-owned0755 ancestry; public identity/path pin |
| `/var/lib/mintbot-wallet-admin/private` | admin UID owned,0700; no named ACL or group grants |
| `private/turnkey-wallet-admin.env` | admin UID owned,0400 or0600, one hard link; SDK credential only here |
| `private/*.json`, `private/approver.pub` | protected local copies of PUBLIC signed mint bundle, admin record and pinned owner public key |
| `/var/lib/mintbot-state/backend.sqlite` and `-wal`/`-shm` | existing canonical owner plus named admin UID read/write ACL only |
| `/var/lib/mintbot-control/killswitch` | existing owner, admin read-only; shared directory traversable, no worker writes |

Add a root-owned mint-service systemd drop-in with `InaccessiblePaths=/var/lib/mintbot-wallet-admin/private` as an additional mount-namespace barrier. The mint service reads its own PUBLIC copy of the non-signing record/catalog; it never reads the admin private directory. This guide does not install that drop-in or restart the production service.

The worker's secret root is its own private directory. Do not point it at the mint service secret root, grant general access to that root, copy a mint/funding API credential, or copy an owner private approval key. Its public mint catalog must stay consistent with the installed canonical catalog. Catalog changes still require the established offline enrollment/revoke/install process.

Root setup, to be reviewed and run by the owner after source approval (examples, not automatic installation):

```sh
useradd --system --user-group --home-dir /var/lib/mintbot-wallet-admin --shell /usr/sbin/nologin mintwalletadmin
install -d -o root -g root -m 0755 /etc/mintbot-wallet-admin
install -d -o mintwalletadmin -g mintwalletadmin -m 0700 /var/lib/mintbot-wallet-admin
install -d -o mintwalletadmin -g mintwalletadmin -m 0700 /var/lib/mintbot-wallet-admin/private
```

Install the actual admin SDK credential through the owner's existing protected secret delivery process; do not type it into CLI arguments, shell history, chat, or this guide. Use `TURNKEY_SECRET_FILE=/var/lib/mintbot-wallet-admin/private/turnkey-wallet-admin.env` and `MINT_BOT_SECRET_ROOT=/var/lib/mintbot-wallet-admin/private`. The basename is mandatory. The profile-template command emits the exact credential field names and non-signing provider DSL; it omits provider `time` entirely. Install only the owner-signed finite same-organization non-signing record and the pinned PUBLIC approver key referenced in that file. Live provider validation checks the distinct admin user/nonroot quorum and exact policy immediately before mutations.

Create `/etc/mintbot-wallet-admin/isolation.json` as root using the actual UIDs and ALL current mint groups (`id -u mintbot`, `id -G mintbot`, `id -u mintwalletadmin`). Numeric IDs below are placeholders and must be replaced; do not silently reuse them:

```json
{
  "version": 1,
  "kind": "wallet-admin-linux-isolation-v1",
  "ownerId": "OWNER_TELEGRAM_ID",
  "adminUid": 2002,
  "mintServiceUid": 2001,
  "mintServiceGids": [2001],
  "credentialRoot": "/var/lib/mintbot-wallet-admin/private",
  "credentialPath": "/var/lib/mintbot-wallet-admin/private/turnkey-wallet-admin.env",
  "databasePath": "/var/lib/mintbot-state/backend.sqlite",
  "killSwitchPath": "/var/lib/mintbot-control/killswitch"
}
```

The runtime rejects a missing/mutable/nonroot-owned/symlinked profile before opening the database or credential; root/shared/wrong process UIDs; membership in pinned mint groups; mismatched owner/path; insecure credential ancestry; private root permissions other than0700; credential permissions other than0400/0600; credential hard links; symlinked DB/kill ancestry or world-writable DB locations. It rechecks the isolation profile before provider mutations. The profile's group list is an installation assertion, not an OS account-directory lookup: root must update/review it whenever mint group membership changes. Run the worker via this root-owned service definition, not from a mint-writable wrapper.

## Canonical database ACL

Use a dedicated canonical DB directory, separate from credentials, backups, source and the kill file. The worker needs read/write on the DB, existing WAL/SHM and permission to create replacement sidecars. Give the named admin UID access to this directory only; do not grant its user a broad service group. Preserve the existing DB owner's rights. Stop the worker during schema migrations and backups/restores that replace the DB or sidecars. Existing mint migrations remain owned by the mint deployment process; deploying this worker against an older source/schema is forbidden.

Example ACL plan, applied only after substituting/reviewing exact paths and backing up current ACLs:

```sh
getfacl -p /var/lib/mintbot-state /var/lib/mintbot-state/backend.sqlite
setfacl -m u:mintwalletadmin:rwx /var/lib/mintbot-state
setfacl -m d:u:mintwalletadmin:rwX /var/lib/mintbot-state
setfacl -m u:mintwalletadmin:rw /var/lib/mintbot-state/backend.sqlite
# Apply the same named-user rw grant to EXISTING backend.sqlite-wal/-shm, if present.
# Default ACL inheritance must be checked on freshly recreated sidecars too.
```

An inherited ACL is limited by a file's creation mode/mask. Check actual `getfacl` effective permissions after WAL/SHM recreation; do not “fix” failures with `chmod777` or recursive group access. Directory write permission is whole-directory authority; keep unrelated state files out of this directory. SQLite deletion/checkpoint ownership constraints and sidecar recreation must be tested under both UIDs on a staging COPY before enabling the worker. If the existing deployment cannot provide this narrow directory/sidecar layout, leave the worker off and use an owner-attended local process with explicitly reviewed filesystem authority; do not broaden permissions as a shortcut.

Grant only traversal/read on the exact kill path and its containing directories, never write. The worker uses the same path as the mint service so a session-ending kill cannot be missed. Do not create a second private kill file.

## Attended one-request service

Prefer a root-owned systemd TEMPLATE oneshot started by the owner for one reviewed public request ID. Inventory/queue views do not expose credentials; sealed imports require an explicit owner-side HPKE file bound to that request and must not be placed in the canonical DB. The owner compares request kind, chains, count/expected public addresses and approval expiry before starting. A request ID selects a queue entry; it does not make an untrusted database tamper-proof.

Example `/etc/systemd/system/mintbot-wallet-admin@.service` (replace release and owner ID; this is not an installed unit):

```ini
[Unit]
Description=Attended MintBot wallet enrollment request %i
After=network-online.target

[Service]
Type=oneshot
User=mintwalletadmin
Group=mintwalletadmin
SupplementaryGroups=
WorkingDirectory=/opt/mintbot/releases/REVIEWED_RELEASE
Environment=MINT_BOT_SECRET_ROOT=/var/lib/mintbot-wallet-admin/private
Environment=TURNKEY_SECRET_FILE=/var/lib/mintbot-wallet-admin/private/turnkey-wallet-admin.env
Environment=MINT_BOT_WALLET_ADMIN_ISOLATION_PROFILE_PATH=/etc/mintbot-wallet-admin/isolation.json
Environment=MINT_BOT_STATE_PATH=/var/lib/mintbot-state/backend.sqlite
Environment=KILL_SWITCH_PATH=/var/lib/mintbot-control/killswitch
ExecStart=/usr/bin/node /opt/mintbot/releases/REVIEWED_RELEASE/packages/cli/dist/index.js wallet-admin worker --once --request-id %i --owner-id OWNER_TELEGRAM_ID
UMask=0077
NoNewPrivileges=yes
CapabilityBoundingSet=
AmbientCapabilities=
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectProc=invisible
ProcSubset=pid
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
ReadOnlyPaths=/etc/mintbot-wallet-admin /var/lib/mintbot-wallet-admin/private /var/lib/mintbot-control
ReadWritePaths=/var/lib/mintbot-state
InaccessiblePaths=-/etc/mintbot/secrets -/var/lib/mintbot-funding
TimeoutStartSec=180
```

Do not enable this as an unattended always-on unit merely because source registration exists. A long-running worker trusts the canonical queue and current owner-session records; that is a separate operational decision. The provider policy still cannot sign/export/administer, but it can create/import keys in the selected mint organization. For sealed imports use a separately reviewed oneshot invocation with the exact owner-only file; do not embed encrypted bundles or plaintext in the unit/arguments/environment.

## Review and activation evidence

On a staging copy, use synthetic credentials and a fake provider: show the mint UID cannot read/traverse the admin directory/file, the admin UID cannot read mint/funding credentials or modify installed source/profile, the admin UID has only the intended DB/WAL/SHM filesystem access, and both UIDs can use/recreate SQLite sidecars without permissive fallback. Verify with `sudo -u <identity> test -r <path>` / `test -w <path>` and inspect `getfacl`; never `cat` credentials for this check. Confirm process identity/group list against the installed profile. Negative same-UID/group/mode/path tests must fail before credential/provider/database access.

After owner approval and source deployment, install the precise root-owned profile and finite offline-signed non-signing record; validate real public provider inventory without issuing create/import. The worker remains off until these checks pass. A deliberate attended owner request may then create/import; retain request/result IDs and ambiguity/reconciliation evidence, never secret bundles. Ambiguous responses reconcile by labels/inventory and never blindly retry creation. Fleet enrollment remains a separate offline signed install/rehearsal step. To remove this role, revoke its provider ALLOW first; removing the public record while the ALLOW remains makes strict mint inventory validation fail closed.
