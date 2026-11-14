# T-141: private read-only dashboard on Vercel

This is an implementation and operator handoff, not a deployed site. Engineering and security review are required before the gateway is installed on the bot host. The requested project name is `palmorabot` (giving `https://palmorabot.vercel.app` only if available); the owner signs into Vercel themselves using their owner-approved account email. No custom domain is required or implied to be owned.

## Boundaries and lifetime

The browser receives the existing script-free `@mint-bot/web` dashboard rendered by `packages/dashboard-vercel/api/index.js`. It requires HTTPS Basic Auth on every request. Only that server function knows the HTTPS origin and its bearer token. The independent Node gateway `packages/dashboard-vercel/src/gateway.js` listens exclusively on `127.0.0.1:8781`; its only upstream is `127.0.0.1:8780`, with that backend Host header. The bot listener stays on loopback.

The SSR function makes one batched GET to `/api/v1/read-model/dashboard`, with optional `?readiness=<id>`, so all five surfaces use one backend snapshot. Other allowed upstream GET routes are `/api/v1/read-model/{home,calendar,alerts,health,analytics}` and `/api/v1/read-model/campaigns/<id>/readiness`, with IDs limited to 1–100 ASCII letters, digits, underscores, hyphens and colons. Colons may use their exact `%3A` escape, allowing real `calendar:1:0x...` readiness IDs; encoded separators/dots/double encoding remain refused. Apart from the validated batch readiness/page queries, no query strings, arbitrary URLs, control routes, metrics, mutations, browser API proxy, signer, database or RPC access exist in this package. The dashboard accepts `/` and the Vercel rewritten `/api/index` path, each with optional validated readiness and page queries, behind identical authentication. Both services reject request bodies, use bounded headers/concurrency and per-process request budgets, disable caching, and return generic failures. Origin redirects are rejected and upstream headers are discarded. Each upstream response is limited to 2 MiB and a six-second total deadline; malformed read models or unavailable transports render unknown/unavailable state with HTTP 503. The web client validates every batch surface and refuses mixed snapshot IDs/times. Missing/invalid freshness becomes unknown; expired fresh data becomes stale. Discovery liveness is displayed separately from mint readiness on home and health.

A Cloudflare **Quick Tunnel** can provide an outbound-only development origin to this gateway without buying a domain or opening an inbound firewall port. Its random HTTPS URL is temporary, changes when the tunnel restarts, has no production availability commitment, and requires both the GCP host and tunnel process to remain running. The Vercel address can stay stable while live data is unavailable. Update `READ_MODEL_ORIGIN` and redeploy after every origin URL change. A managed stable tunnel and owned domain are separate later work. Cloudflare R2 credentials do not authorize Tunnel administration or Vercel deployment.

## Owner's Vercel setup

1. After reviewed code is merged, import the GitHub repository in Vercel. Select project name `palmorabot` if available; record the actual resulting address. Use framework **Other**, Node.js 22, Root Directory **packages/dashboard-vercel**, and enable **Include source files outside of the Root Directory in the Build Step** so the sibling web workspace can build. Keep source/build logs private.
2. Use the committed `vercel.json`: filtered frozen-lockfile installation with lifecycle scripts disabled, build command `pnpm --filter @mint-bot/dashboard-vercel build`, output directory `public`. The install command starts from the selected package directory and changes to the workspace root; it selects only the dashboard and its workspace dependencies. The build creates the output directory and verifies the built batch-client export. The function explicitly includes `../web/dist/**`, in addition to tracing its static `@mint-bot/web` imports. Do not run the bot's recursive build, service setup, or signer configuration on Vercel. The dashboard package has only a workspace dependency on `@mint-bot/web` and no new external dependencies.
3. Before any accessible deployment, set all four variables below for **Production and Preview** as protected/sensitive server environment values. Redeploy after any change. Do not use a public/browser prefix, put secrets in Git, paste them in chat, share deployment logs, or forward them in URLs.
4. Enable Vercel Authentication for **All Deployments** as an additional owner login boundary, including production and preview. Keep the app's Basic Auth enabled independently; deployment protection is not a substitute. Confirm the current account exposes this control before deployment.

| Variable | Value |
| --- | --- |
| `DASHBOARD_EMAIL` | `<owner-approved email>` |
| `DASHBOARD_PASSWORD` | Independently generated random password, at least 32 characters (maximum 512), stored in the owner's password manager and entered locally into Vercel only |
| `READ_MODEL_ORIGIN` | Exact current Quick Tunnel `https://<random>.trycloudflare.com` origin; no path, port, query, credentials or fragment |
| `READ_MODEL_GATEWAY_TOKEN` | Independent random URL-safe bearer token from the host's protected token file; at least 32 characters; never reuse the dashboard password |

Do not copy bot private files, DB snapshots, `.env`, RPC credentials, wallet keys, keystores or Turnkey credentials into Vercel. Do not set the gateway's token-file path on Vercel. Keep Preview credentials protected too; restrict who can change the trusted origin. Per-process request budgets are a safety limit, not distributed abuse protection.

Official platform verification, 14 November 2026: Vercel's 9 September announcement permits Vercel Authentication for All Deployments, including production, on every plan at no additional cost. The actual project setting still needs verification. Hobby remains subject to personal/noncommercial terms. Cloudflare documents Quick Tunnels as development/testing only, with changing hostnames, no uptime guarantee and a 200 in-flight request limit. Do not add interactive email authentication to the server-to-server origin: it does not support noninteractive clients. Keep the gateway's independent bearer authentication. References: [Hobby plan](https://vercel.com/docs/plans/hobby), [free production deployment protection announcement](https://vercel.com/changelog/protect-production-deployments-for-free-on-every-plan), [monorepo source access](https://vercel.com/docs/monorepos/monorepo-faq), [Node functions](https://vercel.com/docs/functions/runtimes/node-js), [Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/).

## Reviewed host installation

Run only after engineering review, under the intended unprivileged gateway service account. Replace `/absolute/path/to/MintBot` and `/absolute/private/directory` with reviewed paths owned by that same account. The private directory must not be in the repository, shared storage or a public backup. Create it mode 0700. Do not change the existing bot service, backend port, signing configuration or firewall.

Generate the independent token directly into a fresh owner-only file without printing it:

```sh
node --input-type=module -e 'import {randomBytes} from "node:crypto"; import {writeFileSync} from "node:fs"; writeFileSync(process.argv[1], randomBytes(48).toString("base64url")+"\n", {mode:0o600,flag:"wx"});' /absolute/private/directory/dashboard-gateway-token
```

The gateway refuses a symlink, a nonregular file, a different owner, permissions other than 0600, or a malformed token. The operator transfers this token directly into Vercel's protected server environment using their private local workflow; do not print it into terminal capture, logs or chat. For rotation, replace the token file atomically, restart the gateway, update the Vercel secret, and redeploy. Brief 401/503 during rotation is expected.

A foreground verification command (not an installation command) is:

```sh
cd /absolute/path/to/MintBot
READ_MODEL_GATEWAY_TOKEN_FILE=/absolute/private/directory/dashboard-gateway-token node packages/dashboard-vercel/src/gateway.js
```

For persistence, the operator creates a reviewed standalone systemd service with the actual unprivileged `User`/`Group`, absolute `WorkingDirectory`, absolute Node `ExecStart` pointing to `packages/dashboard-vercel/src/gateway.js`, and only `Environment=READ_MODEL_GATEWAY_TOKEN_FILE=/absolute/private/directory/dashboard-gateway-token`. Use `Restart=on-failure`, `NoNewPrivileges=true`, `PrivateTmp=true`, `ProtectSystem=strict`, `ProtectHome=read-only`, and no signing credentials or DB access. Validate that the reviewed filesystem paths remain readable under these restrictions. Install/start this new service only after review; this guide does not alter any existing service.

A concrete review template now exists at `ops/systemd/mint-bot-dashboard-gateway.service`. It uses a separate `mintdashboard` identity with no mint groups, root-installed release code, and its own mode-0700 directory `/var/lib/mint-bot-dashboard` containing the UID-owned mode-0600 `gateway-token`. The unit denies access to mint configuration/state and other credential roles, and permits only loopback networking. Engineering must verify effective filesystem and network isolation on the real host before acceptance. This file is not an installed service and does not grant permission to start an internet-facing origin.

If `cloudflared` is not installed, the operator installs it separately from Cloudflare's official distribution after review. With the authenticated gateway running, the temporary development tunnel command is:

```sh
cloudflared tunnel --url http://127.0.0.1:8781 --no-autoupdate
```

Copy only the newly announced HTTPS origin into Vercel's `READ_MODEL_ORIGIN` and redeploy. Keep the tunnel attached during the development session or arrange an independently reviewed service; this command alone does not survive a logout/reboot. Neither cloudflared nor the gateway needs wallet/RPC secrets. Cloudflare documents the temporary tunnel limitations in [TryCloudflare](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/).

## Acceptance checks before frontend use

1. On the host, confirm the bot is still bound only to `127.0.0.1:8780` and the gateway only to `127.0.0.1:8781`. A direct backend request must not be publicly reachable.
2. An unauthenticated GET to `https://<random>.trycloudflare.com/api/v1/read-model/home` must return 401 without data. Dashboard Basic credentials must not authorize that origin. Using the owner's private bearer-token testing workflow, the allowed GET must return the real read-model envelope; POST, `/metrics`, control paths, traversal and unapproved query-string variants must fail. Only dashboard readiness and bounded page queries are origin query exceptions. Never put the token in the URL or shell history.
3. Visit the actual Vercel deployment. After Vercel owner authentication, the app must independently require the Basic email/password. Inspect the document and network panel: only SSR HTML, no secrets/scripts/signing controls. Confirm production, preview and direct `/api/index` access all require authentication.
4. Confirm the dashboard displays real read-model snapshots, availability and freshness. Empty backend data must stay empty/unknown; no fixture or substitute data is supplied. Stop the tunnel briefly: the authenticated dashboard must return 503 with unavailable/unknown data and no secrets. Restore it, update the origin/redeploy if changed, and verify recovery.
5. Check Cache-Control/no-store, absent Set-Cookie/Location/upstream authentication headers, denied POSTs and unknown paths. Record the actual site URL, project owner, deployed commit, origin lifetime and verification result privately. This is a read-only acceptance exercise; it authorizes no transactions or funds movement.

Local implementation verification:

```sh
corepack pnpm --filter @mint-bot/dashboard-vercel build
corepack pnpm exec vitest run packages/dashboard-vercel/src/boundary.test.ts
```

Live Vercel import, cloudflared installation, host service installation, secret entry, project-name availability and end-to-end hosted acceptance remain owner actions. There is no Vercel CLI/account connector configured in this workspace; a local build is not proof of a live deployment.


14 November review update: dashboard lists use newest-first pages of at most50items, with visible total counts and previous/next links. The optional page query is a unique integer1–9999, may coexist only with the validated readiness ID, and is clamped to the current last page. Each response retains one captured state/digest/time; navigating pages refreshes current data. Source issues are summarized by distinct code/severity/message while displayed items retain their own gates. Other origin queries remain rejected.
