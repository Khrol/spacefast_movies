# Reel Together · Spacefast

The movie diary from [Khrol/movies](https://github.com/Khrol/movies), ported to Spacefast Functions and its built-in database. The original interface, private diaries, repeat viewings, ratings, notes, watchlists, household invitations, explicit companion sharing, administration, catalog search and optional Stripe memberships are retained. Firebase is not used at runtime or for development.

## Run locally

Node.js 22.13+ is required (Node 24+ recommended).

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:9500. Local-only accounts are `owner@example.test`, `moviebuff@example.test` and `family@example.test`, with password `movie-night-2026`. Data persists in ignored `.local/diary.sqlite`. Restart after source edits. These accounts and their database are never deployed.

This is the app's local development server, with the same API/authentication code and a SQLite database adapter. Spacefast's `sf dev` currently rejects Functions projects with `runtime_dev_unsupported`; it does not provide a Firebase-style emulator for this runtime. Hosted database and network behavior still need a check after deployment. See [Spacefast local development](https://spacefast.com/docs/cli/publish#sf-dev).

```sh
npm test
npm run build
npm run test:integration
```

Tests cover session cookies, owner setup, verification and reset links, CSRF protection, transactional concurrency, per-account isolation, household/companion revocation, catalog metadata, and the Stripe lifecycle using mocked providers. Real-browser tests exercise diary editing, sharing, administration and mobile layout. On macOS they use installed Chrome; elsewhere install Playwright Chromium. Screenshots are in `test-results/`.

## Publish to the existing Space

Team: **Igor's Team** (`igor-team`). Existing Space: **Reel Together**, `spc_872d97161d58479abd7db5fb5dd719f6`, at https://composed-gravatar.view.fast/. The Space remains connected to `Khrol/spacefast_movies`. Automatic production and preview deployments are paused: the repository sync is stuck, and the current CLI config analyzer drops Functions outbound-fetch declarations. Use `npm run deploy` to publish to this existing Space.

1. Sign in using `npx sf login --api-url https://api.spacefast.com` or redeem a dashboard handoff through the hidden `--handoff` prompt. Do not put credentials in command arguments or Git.
2. Link the existing Space using `npx sf link --space spc_872d97161d58479abd7db5fb5dd719f6 --api-url https://api.spacefast.com`. Alternatively the local non-secret `.spacefast/space.json` is `{ "space": "spc_872d97161d58479abd7db5fb5dd719f6" }`.
3. Configure the server variables below in the Spacefast dashboard or with `sf env set NAME --value-from-stdin --space <space-id> --api-url https://api.spacefast.com`. Secret values should remain write-only. Variables take effect when a version finalizes.
4. Run `npm run deploy`. This builds an explicit `dist/` allowlist and packages it with `sf build`. The package script carries the database and fetch declarations from `sf.jsonc` into the supported Functions artifact metadata before publishing the archive. The file router sends only `/api/*` to the worker; all other assets are static. Server source, environment files, local data and dependencies are not served.
5. Follow the publish receipt's private access URL. Verify the version is ready and is the Space's live version, then check `/api/health`, the sign-in page, and owner setup. A private bare URL can return 403 without the receipt's browser access cookie.

The CLI 0.4.1 packaging workaround is in `scripts/package.mjs`. The compiled archive omits the runtime block so a prebuilt publish does not attempt to compile already-packaged Functions a second time. It keeps the exact bundle digest and route table produced by `sf build`. Do not publish `dist/` directly or re-enable Git deployments until the platform handles both capabilities correctly; verify the resulting version reports `db: true` and `fetch: true` first.

## Owner setup and server variables

Set `OWNER_EMAIL=owner@example.com` and `APP_ORIGIN` to the exact HTTPS origin returned by Spacefast. Generate a cryptographically random 32-byte hex setup token, set `OWNER_SETUP_HASH` to its SHA-256 hash, and keep the token private. The owner opens `/#setup=<token>` after passing the Space access gate and chooses their own password. Setup is single-use, transactionally recorded, and cannot be claimed by an ordinary registrant. The setup token is removed from the address bar before displaying the form. Remove the setup hash variable after completing setup.

| Variable | Purpose |
| --- | --- |
| `APP_ORIGIN` | Canonical HTTPS app origin; CSRF and email/Stripe return URLs |
| `OWNER_EMAIL`, `OWNER_SETUP_HASH` | One-time owner bootstrap |
| `RESEND_API_KEY`, `MAIL_FROM` | Verified sender for account verification and reset emails |
| `KINOPOISK_TOKEN`, `TMDB_TOKEN` | Optional server-only catalog credentials |
| `STRIPE_TEST_SECRET_KEY`, `STRIPE_LIVE_SECRET_KEY` | Optional Stripe connections |
| `STRIPE_AUTOMATIC_TAX` | `true` to enable Stripe automatic tax |

The Functions contract exposes the database and outbound fetch, but no documented native mail binding. Email verification/reset uses Resend. Without mail configuration, owner setup and existing-account login work, but new registrations and password-reset email are unavailable. Never silently treat an unverified registration as verified. Catalog keys are optional: manual movie entry works without them. Billing stays off until an administrator completes the existing test payment, signed webhook, live connection and enable sequence.

## Storage and authentication

```
Browser → Spacefast static frontend
        → /api/* → Spacefast Functions → Spacefast database
                                       → Kinopoisk / TMDB (optional)
                                       → Stripe (optional)
                                       → Resend (account emails)
```

Passwords are salted scrypt hashes. Opaque sessions are stored as hashes, expire after seven days, and travel in Secure, HttpOnly, SameSite cookies. Password resets invalidate old sessions; verification/reset tokens expire after one hour and are single-use. Application writes validate same-origin requests. Approval and private-sharing rules run on the server.

The Spacefast D1-shaped binding reaches a MySQL database through a broker. Since a series of broker calls is not a pinned SQL transaction, the adapter stores a JSON document snapshot in `reel_state`, with an atomic revision-checked update and retries. This preserves multi-document diary transactions, uniqueness and sharing revocation. State is capped at **8 MiB** and serialized for each write; this is intended for a small household, not a large multi-tenant service. Expired rate limits, sessions, tokens and catalog caches are cleaned on writes. The browser has no database credentials or direct database route.

Use Spacefast's database console for backups of `reel_state`; Functions databases do not support the Zero-only `sf db export` command. A code rollback does not roll back diary data. Local SQLite validates the SQL and transactional adapter, while a hosted check must verify the actual Spacefast broker before calling the deployment ready.

This is a new Spacefast installation. It does not automatically import existing Firebase accounts, password hashes, diaries or Stripe customer mappings. Such an import requires an authorized export and a separate migration; do not point the new app at an old Stripe webhook/customer mapping without reviewing that migration.

## Source layout

- `src/`: existing interface and same-origin authentication client.
- `server/`: Web-standard API, database adapter, authentication, diaries, catalogs and billing.
- `scripts/`: build, isolated local SQLite server and deployment.
- `tests/`: unit, authentication, database, API and browser checks.
- `sf.jsonc`: Spacefast Functions capabilities.

Interface and assets originate from the GPL-2.0-or-later Reel Together WordPress plugin in `Khrol/films`, via `Khrol/movies`. This port retains that license.
