# Deployment

Pushing to the **`deployment`** branch deploys the dashboard to
<https://sarah-time-dashboard.royalcourtbd.com> automatically via
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml).

```
push to `deployment`
  → npm ci + syntax check (GitHub runner)
  → tar backup of the current release (server)
  → rsync htdocs
  → npm ci --omit=dev
  → restart the existing systemd user service
  → GET http://127.0.0.1:3001 over SSH until it answers
  → Slack notification (optional)
```

## Target

| | |
|---|---|
| Host | `150.230.239.107` (CloudPanel) |
| Site user | `sarah-time-dashboard` |
| Path | `/home/sarah-time-dashboard/htdocs/sarah-time-dashboard.royalcourtbd.com` |
| Process manager | systemd user service: `sarah-time-dashboard.service` |
| Internal app port | `3001` |

The scheduled-notification worker runs inside the web process, so the app must
run as exactly one process. The workflow therefore restarts only the existing
systemd service; it never starts a second application process as a fallback.

## One-time setup

### 1. Create the deploy SSH key

On your Mac:

```bash
ssh-keygen -t ed25519 -C "github-actions-sarah-time" -f ~/.ssh/sarah_time_deploy -N ""
```

Put the **public** key (`~/.ssh/sarah_time_deploy.pub`) into CloudPanel:
Sites → `sarah-time-dashboard.royalcourtbd.com` → **Settings** → **Site User
Settings** → **SSH Keys** → add the key for the site user.

Confirm it works before touching GitHub:

```bash
ssh -i ~/.ssh/sarah_time_deploy sarah-time-dashboard@150.230.239.107 \
  "whoami && systemctl --user is-active sarah-time-dashboard.service && curl -fsS http://127.0.0.1:3001/ >/dev/null"
```

### 2. Add the GitHub secrets

Repo → Settings → Secrets and variables → **Actions → Secrets**:

| Secret | Value |
|---|---|
| `DEPLOY_SSH_KEY` | contents of `~/.ssh/sarah_time_deploy` (the **private** key, `-----BEGIN` line included) |
| `DEPLOY_KNOWN_HOSTS` | output of `ssh-keyscan -H 150.230.239.107` — optional but recommended; without it the workflow trusts the host key on first use |
| `SLACK_WEBHOOK_URL` | optional; the Slack step is skipped when unset |

### 3. Override the defaults if needed

Everything else is hardcoded as a default in the workflow's `env:` block and can
be overridden with **Actions → Variables** without editing the file:

| Variable | Default |
|---|---|
| `DEPLOY_HOST` | `150.230.239.107` |
| `DEPLOY_USER` | `sarah-time-dashboard` |
| `DEPLOY_PORT` | `22` |
| `DEPLOY_PATH` | `/home/sarah-time-dashboard/htdocs/sarah-time-dashboard.royalcourtbd.com` |
| `SYSTEMD_SERVICE` | `sarah-time-dashboard.service` |
| `APP_PORT` | `3001` |
| `DASHBOARD_URL` | `https://sarah-time-dashboard.royalcourtbd.com/` |

The service name and port must match what is already running on the server:

```bash
ssh sarah-time-dashboard@150.230.239.107 \
  "systemctl --user status sarah-time-dashboard.service --no-pager && curl -fsS http://127.0.0.1:3001/ >/dev/null"
```

- **`SYSTEMD_SERVICE`** must name an existing systemd user service. The workflow
  fails safely if the service is missing; it does not create another process.
- **`APP_PORT`** must equal both the app's listen port and CloudPanel Vhost's
  `proxy_pass` upstream port. It is used for the private post-deploy health check.
- The public site is protected by Basic Authentication, so an unauthenticated
  public health request correctly returns `401`. Running the health check over
  SSH against localhost verifies Node.js without weakening that protection.

### 4. Create the branch

```bash
git checkout -b deployment && git push -u origin deployment
```

## Files that stay on the server

`rsync --delete` mirrors the repo into htdocs, but never removes excluded paths:

- `service-account.json` — Firebase credentials, gitignored, uploaded manually
- `.env`
- `node_modules/` — rebuilt on the server by `npm ci --omit=dev`
- `.well-known/` — Let's Encrypt
- `public/app-release.apk` — downloadable Android build managed outside the repo

Everything else in htdocs is **replaced by the repo on every deploy**. Any file
edited directly through CloudPanel's File Manager will be wiped — change it in
git instead.

## Rollback

Each deploy tars the previous release to `~/backups/deploys/` (last 5 kept):

```bash
ssh sarah-time-dashboard@150.230.239.107
ls -1t ~/backups/deploys/
cd ~/htdocs/sarah-time-dashboard.royalcourtbd.com
tar xzf ~/backups/deploys/<timestamp>-<sha>.tar.gz
npm ci --omit=dev
systemctl --user restart sarah-time-dashboard.service
systemctl --user is-active sarah-time-dashboard.service
```

Or just revert the commit and push to `deployment` again.

## Debugging a failed run

The workflow dumps the last 60 systemd journal lines into the Actions log on
failure.
Manually:

```bash
ssh sarah-time-dashboard@150.230.239.107 \
  "journalctl --user-unit=sarah-time-dashboard.service --no-pager -n 100"
```

Common causes:

- **Health check times out** — the service is inactive, the app crashed on boot,
  `service-account.json` is missing, or the app is not listening on `3001`.
- **systemd service not found** — verify `SYSTEMD_SERVICE` and that the command is
  running as the CloudPanel site user, not `root`.
- **`node: command not found`** — nvm is not being sourced. The workflow sources
  `~/.nvm/nvm.sh`; if node lives elsewhere on this server, adjust that line.
- **`npm run check` fails** — `scripts/migrate-firestore-schema.js` is referenced
  by the `check` script; make sure it is committed, or drop it from the script.
