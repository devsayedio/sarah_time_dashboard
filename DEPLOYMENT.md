# Cloudflare Workers deployment

The dashboard runs on Cloudflare Workers at
<https://sarah-time-dashboard.royalcourtbd.com>.

The Worker provides:

- Express API execution through Cloudflare's Node.js HTTP bridge
- static frontend delivery through Workers Assets
- encrypted Firebase and Basic Auth secrets
- a five-minute Cron Trigger for scheduled notifications
- the same Firebase project and API response contracts used by the mobile app

## Runtime configuration

[`wrangler.jsonc`](wrangler.jsonc) is the source of truth for the Worker name,
production Worker Route, static assets and Cron Trigger.

Required encrypted Worker secrets:

| Secret | Purpose |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Firebase Admin service-account JSON |
| `BASIC_AUTH_USERNAME` | Dashboard Basic Auth username |
| `BASIC_AUTH_PASSWORD` | Dashboard Basic Auth password |

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
the Worker and static assets, and applies the production route and Cron Trigger.

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
