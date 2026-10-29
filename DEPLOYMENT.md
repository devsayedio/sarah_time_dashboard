# Cloudflare Workers deployment

The dashboard runs on Cloudflare Workers at
<https://sarah-time-dashboard.royalcourtbd.com>.

The Worker provides:

- Express API execution through Cloudflare's Node.js HTTP bridge
- static frontend delivery through Workers Assets
- encrypted Firebase and Basic Auth secrets
- a five-minute Cron Trigger for scheduled notifications
- shared dashboard/settings caching through Cloudflare KV
- the same Firebase project and API response contracts used by the mobile app

## Runtime configuration

[`wrangler.jsonc`](wrangler.jsonc) is the source of truth for the Worker name,
Cloudflare-managed production Custom Domain, static assets and Cron Trigger.
The Custom Domain binding creates and maintains the required DNS record, so the
dashboard does not depend on a separate CloudPanel-origin DNS entry.

Required encrypted Worker secrets:

| Secret | Purpose |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Firebase Admin service-account JSON |
| `BASIC_AUTH_USERNAME` | Dashboard Basic Auth username |
| `BASIC_AUTH_PASSWORD` | Dashboard Basic Auth password |

Required KV binding:

| Binding | Purpose |
|---|---|
| `DASHBOARD_CACHE` | Shared date-based dashboard and office-settings responses |

Set or rotate a secret without putting it in git:

```bash
npx wrangler secret put FIREBASE_SERVICE_ACCOUNT_JSON < service-account.json
npx wrangler secret put BASIC_AUTH_USERNAME
npx wrangler secret put BASIC_AUTH_PASSWORD
```

## Manual deployment

Authenticate Wrangler once, then deploy:

```bash
npx wrangler login
npm run deploy:cloudflare
```

The deploy command runs the syntax checks, generates `build-info.json`, uploads
the Worker and static assets, and applies the production Custom Domain and Cron
Trigger.

## GitHub Actions

Pushing to the `deployment` branch runs
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml).

Configure these GitHub Actions values in the `production` environment:

| Type | Name | Value |
|---|---|---|
| Secret | `CLOUDFLARE_API_TOKEN` | Token with Workers Scripts edit permission for this account |
| Variable | `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID |

The encrypted runtime secrets are already attached to the Worker and are
inherited by later deployments; they are not copied into GitHub.

## Dashboard cache

The authenticated Worker checks `DASHBOARD_CACHE` before initializing Firebase:

- today's dashboard: 60 seconds
- past dates: 24 hours
- future dates: 15 minutes
- office settings: 10 minutes

Dashboard responses also use a short, in-memory browser cache (30 seconds for
today, one hour for past dates and five minutes for future dates). The browser
keeps at most 31 dates and never persists employee HR details to local storage.

Successful attendance, employee, office-policy and date-override mutations
invalidate the affected KV entries. `Refresh Data` sends `refresh=1`, bypasses
KV, reads Firebase and replaces the cached response. Direct writes from the
Flutter app to Firestore do not pass through this Worker, so today's 60-second
TTL is the freshness safety net for those writes.

Inspect cache behaviour on an authenticated dashboard response with the
`X-Dashboard-Cache` header (`MISS`, `HIT` or `BYPASS`).

## Dashboard routes

The dashboard uses History API routes while remaining a single-page app:

- `/overview`
- `/attendance`
- `/employees`
- `/employees/new`
- `/employees/{employeeId}`
- `/notifications`
- `/settings`

Cloudflare Workers Assets uses `single-page-application` fallback so direct
links and browser refreshes return the authenticated dashboard shell. Local
Node.js development serves the same shell for these known routes only; API 404
responses and unknown local paths are not masked by the SPA fallback.

## Verification

Unauthenticated access must remain blocked:

```bash
curl -I https://sarah-time-dashboard.royalcourtbd.com/
# HTTP 401
```

Authenticated operational checks:

```bash
curl -u '<username>' https://sarah-time-dashboard.royalcourtbd.com/healthz
curl -u '<username>' https://sarah-time-dashboard.royalcourtbd.com/api/dashboard
```

The API check must return `success: true` with the expected employee and
attendance counts.

## Logs and Cron

Stream production logs:

```bash
npx wrangler tail sarah-time-dashboard --format pretty
```

The Cron Trigger runs `processDueScheduledNotifications()` every five minutes.
Only one production scheduler should be active, otherwise a due notification
can be dispatched twice.

## Rollback

List deployments and roll back to a known version:

```bash
npx wrangler deployments list
npx wrangler rollback <version-id>
```

Re-run the authenticated health and dashboard checks after rollback.

## APK download

`/app-release.apk` is not part of this repository. Add the APK to `public/`
before deployment only when it is at or below Cloudflare's per-asset size limit;
otherwise store it in Cloudflare R2 and expose a dedicated download hostname.
