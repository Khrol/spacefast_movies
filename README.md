# Reel Together · Spacefast

The movie diary from [Khrol/movies](https://github.com/Khrol/movies), running on Spacefast Functions and its database. Sign in with Google to get a free, private diary immediately. There are no passwords, approval gates, payments, or subscriptions. The original diaries, repeat viewings, ratings, notes, watchlists, household invitations, companion sharing and catalog search are retained.

## Google sign-in

The app uses [Google Identity Services](https://developers.google.com/identity/gsi/web/guides/overview) directly. Its backend verifies Google's signed ID token and creates an app-owned session in the Spacefast database. Spacefast Users and its Identity endpoints are not used. No Google client secret is needed.

1. Use an OAuth **Web application** client in [Google Cloud → Clients](https://console.cloud.google.com/auth/clients).
2. Under **Authorized JavaScript origins**, register `https://reel-together.view.fast`, `http://localhost`, and `http://localhost:9500`.
3. Set `GOOGLE_CLIENT_ID` in the app variables (see `.env.example`). Keep `APP_ORIGIN=https://reel-together.view.fast` and `OWNER_EMAIL=khroliz@gmail.com`.
4. Configure Google's audience for external users and production access. Only basic identity information is requested.

The Google button uses popup mode and returns the credential to JavaScript. It does not use a server OAuth redirect URI or the old `/identity/provider/callback` route. The client ID is public; do not put a client secret in the app. See [Google's setup instructions](https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid).

Anyone with a verified Google email can create a private diary immediately. The first authoritative Google email matching `OWNER_EMAIL` binds the administrator role to that Google account's stable subject ID. A later account with the same email cannot take it over. The app's Administration page lists diary accounts; the Spacefast Users dashboard does not manage these sessions.

## Run locally

Node.js 22.13+ is required. `GOOGLE_CLIENT_ID`, optional catalog keys and `OWNER_EMAIL` go in ignored `.env.local` (see `.env.example`).

```sh
npm ci
npm run dev -- --demo
```

Open **http://localhost:9500**. Demo mode offers two clearly labeled local accounts and issues tokens with ephemeral local signing keys. It exercises the same nonce validation and app sessions as production without contacting Google. Data persists in ignored `.local/diary.sqlite`; the signing code lives under `scripts/` and is never deployed.

To use real Google locally, set `GOOGLE_CLIENT_ID` in `.env.local` and run `npm run dev` without `--demo`. The localhost origins must be registered on that client. Local and hosted databases stay separate.

The development server uses the same movie API with SQLite. Spacefast's `sf dev` currently rejects Functions projects with `runtime_dev_unsupported`; hosted behavior must be checked after deployment.

```sh
npm test
npm run build
npm run test:integration
```

Tests use RSA-signed fixture tokens with an injected test key set, never a production bypass. They cover signature, issuer, audience, expiry, nonce and verified-email checks; atomic challenge consumption; per-tab sessions, logout and revocation; CSRF; owner binding; registration and private diary isolation. Integration and browser tests exercise diary editing, sharing, administration and mobile layout. Browser tests replace only Google's external SDK while using the real app authentication endpoints. A real hosted Google login remains a separate verification step. On macOS tests use installed Chrome; elsewhere install Playwright Chromium.

## Publish to the existing Space

Team: **Igor's Team** (`igor-team`). Space: **Reel Together**, `spc_872d97161d58479abd7db5fb5dd719f6`, at https://reel-together.view.fast/. It remains connected to `Khrol/spacefast_movies`. Automatic Git deployments are paused because repository sync stalled and CLI 0.4.1's config analyzer drops Functions fetch declarations.

1. Sign in using `npx sf login --api-url https://api.spacefast.com`. Keep account credentials out of Git.
2. Link the existing Space with `npx sf link --space spc_872d97161d58479abd7db5fb5dd719f6 --api-url https://api.spacefast.com`.
3. Configure the variables below in Spacefast. For a file import, use `sf env import .env.server --secret --space <space-id> --api-url https://api.spacefast.com`. Variables take effect when a version finalizes. Remove obsolete owner-setup, mail and payment variables after switching to Google-only authentication.
4. Run `npm run deploy`. It builds `dist/`, packages the Functions worker, and publishes the archive to the linked Space. Set `GOOGLE_CLIENT_ID` before enabling real sign-in. The login page reports when the provider is not ready.
5. Confirm the receipt's version is ready and live. Open the site in a fresh browser without a Spacefast access cookie, check the Google button and complete Google sign-in. Check `/api/health`, verify anonymous diary requests return 401, and verify the runtime reports `db: true` and `fetch: true`.

`sf.jsonc` makes the site publicly reachable so everyone can reach Google sign-in. The API requires its own Google-authenticated session for diary data. Only `/api/*` reaches the worker; other assets are static. Server source, environment files, dependencies and local data are excluded from the publish.

The CLI packaging workaround is in `scripts/package.mjs`. It copies the declared database/fetch capabilities into the supported Functions artifact metadata while retaining the exact compiled bundle digest and routes. The archive omits the runtime block so prebuilt publication does not compile the worker again. `scripts/deploy.mjs` keeps native Users disabled and preserves its saved provider configuration. CLI 0.4.1 resets that configuration when publishing; restoration checks the live version and settings digest to avoid overwriting concurrent dashboard edits. Use `npm run deploy`, not a direct publish of `dist/`, until these CLI issues are fixed.

## Server variables

| Variable | Purpose |
| --- | --- |
| `APP_ORIGIN` | Exact canonical HTTPS origin for same-origin write checks |
| `GOOGLE_CLIENT_ID` | OAuth Web application client ID; no client secret |
| `OWNER_EMAIL` | Verified owner email for initial administrator assignment |
| `KINOPOISK_TOKEN`, `TMDB_TOKEN` | Optional catalog credentials; manual movie entry works without them |

## Authentication and existing data

The backend verifies Google's RS256 signature against Google's rotating public keys, issuer, audience, expiry, issuance time, verified email and a server-generated nonce. A ten-minute, single-use challenge secret stays in the initiating page’s memory and is consumed atomically with its matching signed nonce when creating a session. JSON login requests also require the exact app Origin; tokens and cookies are never forwarded to Spacefast Identity.

Seven-day sessions use random 256-bit tokens stored only as hashes in the database. The browser keeps its token in `sessionStorage` for the current tab and sends it only to the same-origin movie API through `X-Reel-Session`. Refreshing retains sign-in; a separate fresh tab requires sign-in. If browser storage is unavailable, the session lives only in memory. Every request checks expiry and the account’s session version. Logout deletes the server session and clears browser storage. Google account revocation does not automatically revoke an existing app session; server-side account session-version rotation can revoke all of that account's sessions.

The hosted Functions proxy was verified to drop `Set-Cookie` response headers. This transport avoids that dependency and does not rely on Spacefast's native accounts. Unlike HttpOnly cookies, tab session tokens are accessible to same-origin JavaScript. The app escapes user content and serves a Content Security Policy that blocks inline scripts and limits external scripts to Google's sign-in SDK. Tokens never appear in URLs, cookies, logs or persistent `localStorage`.

Google's stable `sub` identifies an account, including after email changes. Existing direct-Google accounts with a verified subject mapping retain their diary. Native Spacefast identities, old password sessions and unlinked accounts are not accepted or linked by email. Their stored data stays untouched. No data is imported, and there are no password, approval or payment endpoints.

## Storage

The Spacefast D1-shaped binding uses a MySQL broker. Since multiple broker calls are not a pinned SQL transaction, the adapter uses a revision-checked JSON snapshot in `reel_state`. Atomic updates and retries preserve multi-document transactions, uniqueness and sharing revocation. State is capped at **8 MiB** and serialized for each write; this remains a small-app store, even though signup is open. Expired rate limits, sessions, sign-in challenges and catalog caches are cleaned on writes.

Use Spacefast's database console to back up `reel_state`; Functions databases do not support the Zero-only `sf db export` command. Code rollback does not roll back data. Firebase is not used, and no Firebase data was imported.

Interface and assets originate from the GPL-2.0-or-later Reel Together WordPress plugin in `Khrol/films`, via `Khrol/movies`. This port retains that license.
