# Cloudflare Workers deployment

The dashboard runs on Cloudflare Workers at
<https://sarah-time-dashboard.royalcourtbd.com>.

The Worker provides:

- Express API execution through Cloudflare's Node.js HTTP bridge
- static frontend delivery through Workers Assets
- encrypted Firebase and Basic Auth secrets
- a five-minute Cron Trigger for bounded scheduled-notification checks
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
| `FCM_DISPATCH_SECRET` | Shared secret for the Firebase multicast dispatcher |

Required KV binding:

| Binding | Purpose |
|---|---|
| `DASHBOARD_CACHE` | Shared date-based dashboard and office-settings responses |

Set or rotate a secret without putting it in git:

```bash
npx wrangler secret put FIREBASE_SERVICE_ACCOUNT_JSON < service-account.json
npx wrangler secret put BASIC_AUTH_USERNAME
npx wrangler secret put BASIC_AUTH_PASSWORD
npx wrangler secret put FCM_DISPATCH_SECRET
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
- office policy: 30 days
- date-override list: 7 days

Dashboard responses also use a short, in-memory browser cache (30 seconds for
today, one hour for past dates and five minutes for future dates). The browser
keeps at most 31 dates and never persists employee HR details to local storage.
The non-sensitive Office & Policy payload uses a separate 10-minute,
versioned browser cache so a reload or a new tab in the same browser profile
does not trigger another API request.

Successful attendance, employee, office-policy and date-override mutations
invalidate the affected dashboard entries. Policy and override mutations also
write their returned values directly into KV and the browser cache, so the UI
does not reread the full Firestore settings collection after every write.
`Refresh Data` sends `refresh=1`, bypasses both settings KV entries, reads
Firebase and replaces the cached response.

The long-lived settings cache is only used by the authenticated admin settings
page. Attendance classification, daily dashboard assembly and scheduled
reminder eligibility continue to read the office policy and exact-date override
directly from Firestore. This keeps attendance decisions authoritative even
while the admin UI benefits from the longer cache.

Inspect cache behaviour on an authenticated dashboard response with the
`X-Dashboard-Cache` header (`MISS`, `HIT` or `BYPASS`). Settings responses also
include `X-Office-Policy-Cache-Ttl` and `X-Date-Overrides-Cache-Ttl`.

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

The Cron Trigger runs a bounded due query every five minutes. An empty query is
one Firestore document read, so the idle scheduler uses about 288 reads per day
(roughly 0.6% of the 50,000 daily free-read allowance) regardless of employee
count.

Due schedules are claimed with a Firestore update-time precondition and a
ten-minute lease. Failed deliveries retry with bounded backoff, while recurring
schedules reuse the same document. A stable `occurrenceId` plus Android/iOS
collapse metadata limits duplicate user-visible delivery if a Worker stops
after FCM accepts a message but before Firestore is finalized.

Attendance-aware schedules intentionally read Firestore only when their
occurrence becomes due:

- `office_check_in_reminder` reads that day's attendance and active employees,
  then skips employees who already checked in.
- `office_check_out_reminder` reads that day's attendance and resolves only
  checked-in employees who have not checked out.
- when nobody needs the reminder, the occurrence succeeds as a no-op and does
  not retry.
- weekly off-days and closed date overrides also succeed as no-ops before any
  attendance or employee scan.

`office_broadcast` is for non-sensitive office-wide messages. It publishes to
the `active_office_employees` FCM topic without reading every employee. Topic
membership is maintained by the `syncEmployeeBroadcastTopic` Firebase Function
in the main Sarah Time app repository. Deploy the Function before deploying a
dashboard version that uses this target, then perform the one-time existing
token reconciliation:

Both the dashboard Firebase Admin service account and the Function runtime
service account require the least-privilege `roles/cloudmessaging.editor` role
for topic subscription management.

Cloudflare sends one authenticated request to the
`dispatchDashboardNotification` Firebase Function. The Function performs the
FCM multicast in Google infrastructure, so a 500-employee reminder does not
consume 500 Cloudflare external subrequests. Its Secret Manager value must
match the Worker's `FCM_DISPATCH_SECRET`:

```bash
cd /Users/sayed/Documents/GitHub/sarah_time
npx firebase-tools functions:secrets:set DASHBOARD_DISPATCH_SECRET \
  --project employee-attendance-30f81
```

```bash
cd /Users/sayed/Documents/GitHub/sarah_time
npx firebase-tools deploy \
  --only functions:syncEmployeeBroadcastTopic,functions:dispatchDashboardNotification \
  --project employee-attendance-30f81
```

The Flutter app must also be rebuilt and installed for its local notification
inbox to deduplicate retries by `occurrenceId`.

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
