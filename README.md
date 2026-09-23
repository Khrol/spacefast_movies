# Reel Together · Firebase

A Firebase rewrite of the Reel Together WordPress movie diary. The existing interface and movie-night workflows are retained, with Firebase Authentication, Cloud Firestore, Firebase Hosting, and one Node.js HTTPS Cloud Function. There is no WordPress or PHP runtime in the deployed app.

## What is included

- Private diaries, repeat viewings, personal ratings and notes, watchlists, collection search and pagination.
- Households, seven-day invitation codes, owner-controlled removal, and joining/leaving.
- Companion labels, optional links to family accounts, explicit sharing of selected private viewings or earlier tagged viewings, and revocation when an account link or household membership changes.
- Kinopoisk and optional TMDB search in Russian, exact Kinopoisk/IMDb lookups, verified community ratings, safe poster URLs, and manual movie links without API keys.
- Email/password accounts, email verification, password reset, owner approval, invitation requests, and an administration screen.
- Optional €1/month Stripe subscriptions, independent test/live connections, verified checkout returns and signed webhooks, cancellation, payment recovery, complimentary access, and retained diaries after membership ends.

The production project, billing account, domain, and live data are not created or changed by this repository. Development and tests use `demo-reel-together`, which cannot access live Firebase resources.

## Run locally

Use Node.js **22** and Java **21 or later** for the Firestore emulator. On macOS the scripts select an installed Java 21+ runtime automatically.

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:9500**. The first run downloads the Firebase emulator. Local accounts:

| Account | Email | Password |
|---|---|---|
| Owner / administration | owner@example.test | movie-night-2026 |
| Personal diary | moviebuff@example.test | movie-night-2026 |
| Family member | family@example.test | movie-night-2026 |

Stop with Ctrl+C to save emulator data to `.local/emulator-data`. These accounts and credentials are never deployed. Password-reset and verification links are printed by the Auth emulator; it does not send mail.

Ports: Hosting 9500, Functions 9501, Firestore 9502, Auth 9503, emulator hub 9504, logging 9505, Firestore websocket 9506. The standard 5000 and 8080 ports are deliberately avoided. `npm run dev` serves a built frontend; restart it after frontend changes. Functions reload when their source changes.

For optional local catalog testing, edit the ignored `functions/.secret.local` created by the dev script. Set `APP_SECRETS` to the JSON described below on a single line. Never put server keys in frontend environment variables.

## Verify changes

```sh
npm test                  # Validation, sharing rules, billing eligibility
npm run build             # Production frontend
npm run test:integration  # Auth/Firestore/Functions/Hosting emulators + API and real-browser tests
npm run check             # All of the above
```

On macOS the browser tests use installed Google Chrome. Elsewhere run `npx playwright install chromium`. Set `REEL_BROWSER_CHANNEL=chrome` to override the browser. Screenshots are written to `test-results/`.

Integration tests exercise actual Firestore transactions and Auth tokens. They check direct Firestore denial, unverified/unapproved accounts, cross-account read/write isolation, concurrent watchlist inserts, explicit companion consent, unlink/removal/rejoin revocation, household visibility, invitation moderation, and the Stripe billing lifecycle. Catalog and Stripe HTTP calls are mocked; real provider credentials are not needed. Browser tests exercise the actual Hosting-to-Function rewrite, sign-in, diary editing, household joining, sharing, administration, and mobile layout.

## Deploy to the production Firebase project

The Firebase project ID is **`movies-khroliz-com`** and the production hostname is **https://movies.khroliz.com**. The deployment script publishes to this project's default Hosting site, **https://movies-khroliz-com.web.app**.

1. Open the [movies-khroliz-com project in the Firebase Console](https://console.firebase.google.com/project/movies-khroliz-com/overview) and register a **Web app** if you have not already done so. Enable the **Blaze** billing plan; Cloud Functions deployment requires it. Set a billing budget alert; free allowances apply, but neither a $0 bill nor a hard spending cap is guaranteed.
2. Create the **`(default)` Cloud Firestore Standard edition** database in production mode. Choose `europe-west1` to match the function, or another nearby EU location; the database location cannot be changed later. This repository deploys deny-all client rules because all app data access goes through the server.
3. Enable **Authentication → Sign-in method → Email/Password**. Under **Authentication → Settings → Authorized domains**, add `movies.khroliz.com` and check that `movies-khroliz-com.web.app` is listed. Enter hostnames without `https://`. Configure the authentication email templates as needed.
4. Use Node.js **22**, install dependencies, and authenticate the CLI:

```sh
cd /Users/khroliz/repos/Khrol/films_firebase
npm ci
npx firebase login
mkdir -p .local
```

The repository already contains `firebase.json`, Firestore rules, and the backend; no `firebase init` step is needed.

5. Create `.local/server-secrets.json` with the configuration below. Set `origin` to the final custom domain now; wait until that domain works before configuring Stripe. Catalog and Stripe keys are optional. An empty catalog configuration still supports manual entries; billing stays disabled until the administrator opens it. The `.local` directory is ignored by Git.

```json
{
  "origin": "https://movies.khroliz.com",
  "kinopoiskToken": "",
  "tmdbToken": "",
  "stripe": {
    "test": {"secretKey": ""},
    "live": {"secretKey": ""},
    "automaticTax": false
  }
}
```

6. Store it in Secret Manager and deploy:

```sh
npx firebase functions:secrets:set APP_SECRETS --project movies-khroliz-com --data-file .local/server-secrets.json
npm test
npm run deploy -- --project movies-khroliz-com
```

The deploy script always makes a production build and targets the explicitly named project. The deployed frontend obtains its **public** SDK configuration from Firebase Hosting's `/__/firebase/init.json`; no Firebase private key is embedded in the JavaScript. Optional `VITE_FIREBASE_*` overrides are documented in `.env.example` for other hosting arrangements.

Open `https://movies-khroliz-com.web.app` and check `https://movies-khroliz-com.web.app/api/health` returns `{"ok":true}`. This URL can be used to check login and diary features before the custom domain is ready.

7. In **Firebase Console → Hosting → Add custom domain**, enter `movies.khroliz.com`. Choose to serve the app on this hostname and follow the setup wizard. At the DNS provider for `khroliz.com`, add the exact verification and routing records Firebase supplies. For a routing record, the host/name is usually `movies` (some providers require `movies.khroliz.com`). A verification record may use a different host: copy the wizard's values exactly and keep verification records in place. Replace conflicting routing records only for `movies.khroliz.com`; retain the existing root website, mail records, and other subdomains.

Firebase provisions and renews HTTPS automatically. DNS propagation and certificate provisioning can take up to 24 hours after the correct records are in place. Wait for **Connected**, then check `https://movies.khroliz.com` and `https://movies.khroliz.com/api/health`. See [Firebase's custom-domain instructions](https://firebase.google.com/docs/hosting/custom-domain).

8. Create your own account on the deployed app and verify your email. New accounts wait for owner approval by default. To bootstrap the owner, configure Admin SDK [Application Default Credentials](https://cloud.google.com/docs/authentication/provide-credentials-adc) with permissions for this project, then run:

```sh
npm run admin -- --project movies-khroliz-com --email YOUR_EMAIL --grant-admin
```

Sign out and back in to refresh the administrator claim. Administration can approve emails before account creation, approve waiting accounts, grant complimentary membership, and optionally open registration. Approval does not create users or send invitations; you arrange invitations yourself.

One supported way to supply local Admin SDK credentials is **Firebase Console → Project settings → Service accounts → Generate new private key**. Save the downloaded file as `.local/admin.service-account.json`, then use it for the command:

```sh
chmod 600 .local/admin.service-account.json
GOOGLE_APPLICATION_CREDENTIALS="$PWD/.local/admin.service-account.json" npm run admin -- --project movies-khroliz-com --email YOUR_EMAIL --grant-admin
```

This file grants privileged access; keep it private and out of source control. `firebase login` only authenticates the Firebase CLI, not this Admin SDK script. Plain `gcloud auth application-default login` credentials also need additional configuration for Firebase Authentication; see [Admin SDK credential setup](https://firebase.google.com/docs/admin/setup#testing_with_gcloud_end_user_credentials).

For later releases, repeat `npm run deploy -- --project movies-khroliz-com`. If server secrets change, repeat the `functions:secrets:set` command before deploying. Configure Stripe only after the final hostname works.

Documentation: [Hosting with Functions](https://firebase.google.com/docs/hosting/functions), [reserved Hosting URLs](https://firebase.google.com/docs/hosting/reserved-urls), [server secrets](https://firebase.google.com/docs/functions/config-env), [email/password authentication](https://firebase.google.com/docs/auth/web/password-auth).

## Stripe membership

Set the Stripe sandbox and live secret keys in `APP_SECRETS` and redeploy. In Administration:

1. Select **Connect and prepare test**. The server prepares a €1 monthly price, cancellation portal, and webhook at `/api/billing/webhook/test`.
2. Run a test checkout and complete it using a Stripe test card. Checkout return verification and signed webhook delivery must both succeed. A separate sandbox account from the live account is supported.
3. Select **Connect and prepare live**. Live charges must be enabled in Stripe.
4. Assign complimentary membership to selected accounts, then select **Open €1/month subscriptions**.

The billing screen never returns saved keys, webhook secrets, or customer IDs. Stripe keys live in Secret Manager; webhook signing secrets and server-generated billing configuration live in server-only Firestore collections. Checkout fixes customer identity, price, quantity, and return destinations on the server. Transactions serialize billing operations; persisted idempotency keys recover from lost checkout responses. Webhooks validate signatures/timestamps and refetch current subscriptions, so replaying an old payment event cannot revive canceled membership. Membership checks refresh cached Stripe state after five minutes or paid-period expiry. Invalid or unverifiable payments do not grant access.

Only active subscriptions for the configured €1/month EUR price, quantity one, matching user metadata, a paid latest invoice, and an unexpired period grant access. Administrators can run test billing, but ordinary members cannot; test subscriptions never grant live access. The customer portal remains available when paid access is disabled or an account's app approval is revoked. Free access does not cancel subscriptions.

Provider mocks are covered by tests. Before opening paid subscriptions, complete the real sandbox payment/webhook flow on the deployed app. Stripe processing and Billing fees are separate from Firebase hosting charges.

## Architecture and operating costs

```
Browser → Firebase Hosting (static frontend)
       → Firebase Authentication (verified email/password)
       → /api/* → Cloud Functions → Firestore
                                 → Kinopoisk / TMDB
                                 → Stripe
Stripe → signed webhook → Cloud Functions → Firestore
```

The server verifies Firebase ID tokens, email verification, owner approval, membership, and per-entry authorization. Client Firestore reads and writes are denied, including for administrators. Companion links record both household membership epochs and a link version. Individual sharing grants must still match these values at read time; unlinking or leaving invalidates old access even after rejoining. Household entries remain in the household, and their original author retains access and editing rights after leaving.

Firestore uses ordinary single-field indexes. Collection endpoints fetch only the caller's owned entries, current household entries, and entries naming them as a sharing recipient; stale grants are rechecked and excluded before returning data. Search, sorting, counts, and 24-item pagination happen on the server. **Database reads therefore grow with the size of a person's visible collection, even when viewing one page.** This is suitable for the current small household app; large collections would benefit from stored aggregates and indexed search/cursors.

Functions scale to zero (`minInstances: 0`) with at most two instances. Cold starts are possible. Rate-limit documents and catalog search caches expire through Firestore TTL policies; enable/verify TTL after deploying `firestore.indexes.json`. Logs, builds, Secret Manager, database traffic, and Stripe have their own pricing. Blaze includes free usage allowances, but this is **not a guaranteed $0 hosting plan**. Set a billing budget alert; alerts and `maxInstances` are not a hard spending cap. See [Firebase pricing](https://firebase.google.com/pricing).

Enable a Firestore backup schedule or exports separately for production; Firebase Hosting deploy history does not back up the database. Authentication account exports require a separate Auth backup. No public registration or billing is enabled automatically.

## Source layout

- `src/` — Firebase sign-in, the retained diary interface, administration, membership, and styles.
- `functions/src/` — authenticated API, Firestore transactions and authorization, catalogs, Stripe billing.
- `scripts/` — local emulators, deployment, and administrator setup.
- `tests/` — domain tests, emulator API tests, mocked provider lifecycle tests, and browser tests.
- `firestore.rules` / `firestore.indexes.json` — direct-access policy and TTL configuration.

The interface and assets originate from the Reel Together WordPress plugin in `Khrol/films`, licensed GPL-2.0-or-later. The port is distributed under the same license; third-party dependencies retain their own licenses.
