# Reel Together · Spacefast

The movie diary from [Khrol/movies](https://github.com/Khrol/movies), running on Spacefast Functions and its database. Sign in with Google to get a free, private diary immediately. There are no passwords, approval gates, payments, or subscriptions. The original diaries, repeat viewings, ratings, notes, watchlists, household invitations, companion sharing and catalog search are retained.

## Google sign-in setup

Google Identity Services needs a **Web application** OAuth client owned by the operator. It uses a public client ID; this app does not need a client secret or access to Google APIs beyond basic identity.

In a normal browser, open [Google Auth Platform](https://console.cloud.google.com/auth/overview):

1. Create or select a project, for example **Reel Together**.
2. Complete **Get started** with app name **Reel Together**, support/contact email **khroliz@gmail.com**, and audience **External**.
3. Under **Clients → Create client**, choose **Web application** and name it **Reel Together Web**. Add these **Authorized JavaScript origins**, without trailing slashes:
   - `https://reel-together.view.fast`
   - `http://localhost`
   - `http://localhost:9500`
4. Leave redirect URIs empty: this app uses the Google button's popup callback.
5. Under **Audience**, publish the app for external users so access is not limited to a test-user list. Request only the standard `openid`, `email`, and `profile` identity scopes.
6. Set `GOOGLE_CLIENT_ID` to the resulting value ending in `.apps.googleusercontent.com`. Set `APP_ORIGIN=https://reel-together.view.fast` and `OWNER_EMAIL=khroliz@gmail.com`.

Google can reject sign-in from an automated browser. Complete the Cloud Console setup in your normal browser in that case. See [Google's setup guide](https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid).

The first verified Google identity matching the configured owner email receives administrator access. Other users can start immediately and have no account-approval or payment step. Administration only lists accounts and catalog availability. Every user's diary stays private unless they explicitly share through a household or companion link.

## Run locally

Node.js 22.13+ is required. Create an ignored `.env.local` with `GOOGLE_CLIENT_ID` and, optionally, `OWNER_EMAIL` (see `.env.example`), then run:

```sh
npm ci
npm run dev
```

Open **http://localhost:9500** and sign in with Google. Data persists in ignored `.local/diary.sqlite`; it never touches the hosted database. Restart after source edits. There are no local password accounts or authentication bypasses. Automated tests use a separate signing key and a simulated Google button, without changing the production verifier.

This development server runs the same API/authentication code with a SQLite adapter. Spacefast's `sf dev` currently rejects Functions projects with `runtime_dev_unsupported`; hosted behavior must still be checked after deployment. See [Spacefast local development](https://spacefast.com/docs/cli/publish#sf-dev).

```sh
npm test
npm run build
npm run test:integration
```

Tests cover signed Google tokens, audience/issuer/expiry/nonce validation, replay and CSRF rejection, session invalidation, account migration, immediate registration, private data isolation, database concurrency, household/companion revocation, catalogs, and the removal of password/payment endpoints. Browser tests exercise Google sign-in/sign-out, new accounts, diary editing, sharing, administration and mobile layout. On macOS they use installed Chrome; elsewhere install Playwright Chromium. Screenshots are in `test-results/`.

## Publish to the existing Space

Team: **Igor's Team** (`igor-team`). Space: **Reel Together**, `spc_872d97161d58479abd7db5fb5dd719f6`, at https://reel-together.view.fast/. It remains connected to `Khrol/spacefast_movies`. Automatic Git deployments are paused because repository sync stalled and CLI 0.4.1's config analyzer drops Functions fetch declarations.

1. Sign in using `npx sf login --api-url https://api.spacefast.com`. Keep account credentials out of Git.
2. Link the existing Space with `npx sf link --space spc_872d97161d58479abd7db5fb5dd719f6 --api-url https://api.spacefast.com`.
3. Configure the variables below in Spacefast. For a file import, use `sf env import .env.server --secret --space <space-id> --api-url https://api.spacefast.com`. Variables take effect when a version finalizes. Remove obsolete owner-setup, mail and payment variables after switching to Google-only authentication.
4. Run `npm run deploy`. It builds `dist/`, packages the Functions worker, and publishes the archive to the linked Space. Do not activate the Google-only release until a real client ID and authorized origins are configured.
5. Confirm the receipt's version is ready and live. Open the site in a fresh browser without a Spacefast access cookie, check the Google button and complete Google sign-in. Check `/api/health`, verify anonymous diary requests return 401, and verify the runtime reports `db: true` and `fetch: true`.

`sf.jsonc` makes the site publicly reachable so everyone can reach Google sign-in. The API still requires a verified Google session for diary data. Only `/api/*` reaches the worker; other assets are static. Server source, environment files, dependencies and local data are excluded from the publish.

The CLI packaging workaround is in `scripts/package.mjs`. It copies the declared database/fetch capabilities into the supported Functions artifact metadata while retaining the exact compiled bundle digest and routes. The archive omits the runtime block so prebuilt publication does not compile the worker again. Use `npm run deploy`, not a direct publish of `dist/`, until the platform handles both declarations correctly.

## Server variables

| Variable | Purpose |
| --- | --- |
| `APP_ORIGIN` | Exact canonical HTTPS origin for same-origin write checks |
| `GOOGLE_CLIENT_ID` | OAuth Web application client ID used by the button and server verifier |
| `OWNER_EMAIL` | Google-hosted owner email for initial administrator assignment |
| `KINOPOISK_TOKEN`, `TMDB_TOKEN` | Optional catalog credentials; manual movie entry works without them |

## Authentication and existing data

The backend verifies Google's RS256 signature, issuer, audience, expiry, issue time, verified email and a one-use nonce bound to the browser's HttpOnly cookie. Google subject IDs identify accounts, so changing an email does not create a different diary. Tokens and cookies never appear in URLs. Sessions last seven days and are stored as hashes in the database; production cookies are Secure, HttpOnly and SameSite=Lax. Sign-out revokes the current session.

Old password, verification, reset and owner-setup endpoints are removed, and password-era sessions are rejected. An existing verified account can be linked to Google by matching a Google-hosted email (Gmail or Workspace); its account ID, movies and sharing relationships are retained, and its password hash is removed. A non-Google-hosted email never automatically claims an old account: that Google identity gets a separate diary. No existing movie data is deleted, and old billing/approval settings have no effect on access.

## Storage

The Spacefast D1-shaped binding uses a MySQL broker. Since multiple broker calls are not a pinned SQL transaction, the adapter uses a revision-checked JSON snapshot in `reel_state`. Atomic updates and retries preserve multi-document transactions, uniqueness and sharing revocation. State is capped at **8 MiB** and serialized for each write; this remains a small-app store, even though signup is open. Expired rate limits, sessions, sign-in challenges and catalog caches are cleaned on writes.

Use Spacefast's database console to back up `reel_state`; Functions databases do not support the Zero-only `sf db export` command. Code rollback does not roll back data. Firebase is not used, and no Firebase data was imported.

Interface and assets originate from the GPL-2.0-or-later Reel Together WordPress plugin in `Khrol/films`, via `Khrol/movies`. This port retains that license.
