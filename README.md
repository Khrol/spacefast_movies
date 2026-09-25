# Reel Together · Spacefast

The movie diary from [Khrol/movies](https://github.com/Khrol/movies), running on Spacefast Functions and its database. Sign in with Google to get a free, private diary immediately. There are no passwords, approval gates, payments, or subscriptions. The original diaries, repeat viewings, ratings, notes, watchlists, household invitations, companion sharing and catalog search are retained.

## Spacefast Users and Google sign-in

Accounts and sessions belong to [Spacefast Users](https://my.spacefast.com/igor-team/reel-together/users). The movie app starts Google's provider flow on the Space and validates the resulting session with the Space's Identity API. No Google credential belongs in this repository or the movie app's environment.

1. In **Users → Sign-in methods**, enable app sign-in and select **Google → Use my Google app**. Managed Google was unavailable when this integration was configured.
2. Save your OAuth Web application **client ID and client secret** in that dashboard. Disable the Gravatar and Spacefast providers.
3. In [Google Auth Platform](https://console.cloud.google.com/auth/overview), add this exact **Authorized redirect URI** to the same OAuth client:

   `https://reel-together.view.fast/identity/provider/callback?provider=google`

4. Set the Google app audience to **External** and publish it for all users, using only basic identity scopes (`openid`, `email`, `profile`).
5. Keep `APP_ORIGIN=https://reel-together.view.fast` and `OWNER_EMAIL=khroliz@gmail.com` in the Space's app variables.

The first verified Spacefast account matching the owner email receives administrator access. Its stable account ID keeps that role even if its email changes; a later account with the same email cannot take it over. Other users receive a private diary immediately. Administration links to Spacefast Users for account and session management.

The app exposes only the Google sign-in button and requires a verified, active Spacefast account with a Google identity linked. Public access excludes the native email, password and passkey sign-in endpoints; Google OAuth routes remain public. Spacefast owns the hosted Identity screens. Do not enable additional providers in its dashboard. Sign-in completes in a popup; the diary opens after the backend validates the native session.

## Run locally

Node.js 22.13+ is required. Optional catalog keys and `OWNER_EMAIL` go in ignored `.env.local` (see `.env.example`).

```sh
npm ci
npm run dev -- --demo
```

Open **http://localhost:9500**. This explicit demo mode simulates Spacefast Identity with two local test accounts. The sign-in window identifies itself as a simulator; it does not contact Google or use hosted accounts. Data persists in ignored `.local/diary.sqlite`. The simulator lives under `scripts/` and is never included in the deployed worker. Without `--demo`, the page runs with sign-in unavailable because Spacefast Users is hosted.

The development server uses the same movie API with SQLite. Spacefast's `sf dev` currently rejects Functions projects with `runtime_dev_unsupported`; hosted behavior must be checked after deployment.

```sh
npm test
npm run build
npm run test:integration
```

Tests use a separate Identity transport implementing Spacefast's account/config contract. They cover session validation, suspension and revocation, expiry, verified email and Google association, CSRF, owner binding, immediate registration, private data isolation, database concurrency, sharing, catalogs, and retired auth/payment endpoints. Browser tests simulate the native sign-in popup and exercise diary editing, sharing, administration and mobile layout. A real hosted Google login remains a separate verification step. On macOS tests use installed Chrome; elsewhere install Playwright Chromium.

## Publish to the existing Space

Team: **Igor's Team** (`igor-team`). Space: **Reel Together**, `spc_872d97161d58479abd7db5fb5dd719f6`, at https://reel-together.view.fast/. It remains connected to `Khrol/spacefast_movies`. Automatic Git deployments are paused because repository sync stalled and CLI 0.4.1's config analyzer drops Functions fetch declarations.

1. Sign in using `npx sf login --api-url https://api.spacefast.com`. Keep account credentials out of Git.
2. Link the existing Space with `npx sf link --space spc_872d97161d58479abd7db5fb5dd719f6 --api-url https://api.spacefast.com`.
3. Configure the variables below in Spacefast. For a file import, use `sf env import .env.server --secret --space <space-id> --api-url https://api.spacefast.com`. Variables take effect when a version finalizes. Remove obsolete owner-setup, mail and payment variables after switching to Google-only authentication.
4. Run `npm run deploy`. It builds `dist/`, packages the Functions worker, and publishes the archive to the linked Space. Configure Google in Spacefast Users before enabling real sign-in. The login page reports when the provider is not ready.
5. Confirm the receipt's version is ready and live. Open the site in a fresh browser without a Spacefast access cookie, check the Google button and complete Google sign-in. Check `/api/health`, verify anonymous diary requests return 401, and verify the runtime reports `db: true` and `fetch: true`.

`sf.jsonc` makes the site publicly reachable so everyone can reach Google sign-in. The API requires a verified Spacefast session with a linked Google identity for diary data. Only `/api/*` reaches the worker; other assets are static. Server source, environment files, dependencies and local data are excluded from the publish.

The CLI packaging workaround is in `scripts/package.mjs`. It copies the declared database/fetch capabilities into the supported Functions artifact metadata while retaining the exact compiled bundle digest and routes. The archive omits the runtime block so prebuilt publication does not compile the worker again. `scripts/deploy.mjs` also preserves Users settings: CLI 0.4.1 resets them when publishing. Restoration checks the live version and settings digest to avoid overwriting concurrent dashboard edits. Use `npm run deploy`, not a direct publish of `dist/`, until these CLI issues are fixed.

## Server variables

| Variable | Purpose |
| --- | --- |
| `APP_ORIGIN` | Exact canonical HTTPS origin for Identity API calls and same-origin write checks |
| `OWNER_EMAIL` | Verified owner email for initial administrator assignment |
| `KINOPOISK_TOKEN`, `TMDB_TOKEN` | Optional catalog credentials; manual movie entry works without them |

## Authentication and existing data

The backend sends the browser's cookies only to the server-configured Space origin's `/__zero/auth/api/account` endpoint, with redirects disabled. It checks the returned account status, session expiry, verified email and linked Google issuer. Each diary request checks the native session again, so a suspension or session revocation is not hidden by a second app session. The account's stable ID owns the diary; client-supplied user IDs, email addresses and bearer tokens are never trusted. Sign-out obtains the native CSRF value server-side and revokes that same Spacefast session.

There are no app passwords, custom session tokens, Google JWT verification, approval gates or payment APIs. Old application sessions are rejected. Existing data is retained but is not automatically assigned to a new Spacefast account by matching an email address. No Firebase data was imported. Native account deletion and diary retention are separate: completing an account deletion in Spacefast does not automatically erase custom movie records from `reel_state`.

## Storage

The Spacefast D1-shaped binding uses a MySQL broker. Since multiple broker calls are not a pinned SQL transaction, the adapter uses a revision-checked JSON snapshot in `reel_state`. Atomic updates and retries preserve multi-document transactions, uniqueness and sharing revocation. State is capped at **8 MiB** and serialized for each write; this remains a small-app store, even though signup is open. Expired rate limits, sessions, sign-in challenges and catalog caches are cleaned on writes.

Use Spacefast's database console to back up `reel_state`; Functions databases do not support the Zero-only `sf db export` command. Code rollback does not roll back data. Firebase is not used, and no Firebase data was imported.

Interface and assets originate from the GPL-2.0-or-later Reel Together WordPress plugin in `Khrol/films`, via `Khrol/movies`. This port retains that license.
