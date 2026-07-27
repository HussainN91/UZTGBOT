# Deploying to the server

Ubuntu 24.04, 2 vCPU, 4 GB memory, 50 GB disk, hosted in Uzbekistan so teacher
personal data never leaves the country.

Nothing here is run automatically. Every step below is one a person runs and
checks, in this order.

---

## Before you start

You need:

- **A hostname pointing at the server.** An A record for e.g. `bot.example.uz`
  resolving to the server's public IP. Caddy cannot obtain a certificate until
  this resolves, and Telegram will not deliver webhooks without one.
- **Ports 80 and 443 open.** Port 80 is not optional — it carries the ACME
  challenge and the redirect to HTTPS.
- **A bot token** from @BotFather.
- **An off-site destination for backups** — object storage, or another machine.
  Not this server, and not the same provider account if that can be avoided.
- **A Google service account** with Viewer on the FAQ/roster spreadsheet, and
  nothing else. The bot only ever reads from Sheets.

---

## 1. Install Docker

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"   # log out and back in
```

## 2. Fetch the code and configure it

```bash
git clone <this repository> /opt/mopse-bot
cd /opt/mopse-bot
cp .env.example .env
```

Fill in `.env`. Generate the webhook secret rather than inventing one:

```bash
openssl rand -hex 32
```

`.env` also needs `POSTGRES_PASSWORD` and `BOT_HOSTNAME` (the hostname alone, no
`https://`), which compose reads directly. `BOT_HOSTNAME` must match
`PUBLIC_URL`'s host or Caddy will hold a certificate for the wrong name.

Lock the file down — it holds the bot token, the database password and the
backup passphrase:

```bash
chmod 600 .env
```

## 3. Start it

```bash
docker compose up -d --build
```

Create the schema before the processes do any real work. Safe to re-run — applied
migrations are recorded and skipped, and each runs in a transaction, so a failure
leaves the schema exactly as it was:

```bash
docker compose exec web node dist/db/migrate.js
```

Then watch it come up:

```bash
docker compose logs -f web
```

Expect `connected to postgres`, `telegram credentials accepted`, and
`web process listening`. If a setting is missing or still a placeholder the web
process refuses to start and names every problem at once — that is deliberate.

Confirm Caddy has a certificate:

```bash
curl -sS https://$BOT_HOSTNAME/healthz
# {"status":"ok"}
```

`{"status":"degraded"}` means the web process is up but Postgres is not
reachable. It reports 503 in that state on purpose: a process that answers 200
while it cannot serve anyone keeps traffic arriving at something broken.

## 4. Point Telegram at it

```bash
docker compose exec web node dist/scripts/set-webhook.js
docker compose exec web node dist/scripts/set-webhook.js --show
```

`--show` must report your URL, `pending_update_count` at or near zero, and no
`last_error_message`. A `last_error_message` of "wrong response from the
webhook" almost always means the certificate is not yet valid — wait for Caddy
and re-check.

The secret travels in the `X-Telegram-Bot-Api-Secret-Token` header, not in the
URL. The Apps Script version had no choice but to put it in the query string,
where it leaked into every proxy and access log in the path.

## 5. Prove a message gets through

Message the bot `/start` from any Telegram account. It should reply that the bot
is running.

## 6. Load the FAQ and the roster

The worker syncs both every ten minutes on its own. Run it once by hand first, so
any problem surfaces now rather than silently at 03:00:

```bash
docker compose exec worker node dist/scripts/sync-sheets.js
```

Read the output. It reports, per tab, how many rows were written, how many were
deactivated, and every row it rejected with the row number and the reason —
usually a topic name that does not match the FAQ taxonomy. Fix those in the
sheet; the next sync picks them up.

Exit code 0 means applied, 2 means refused by the damage limit, 1 means failed.

**If it reports "Refusing to sync"**, that is the guard working. A sync that
would switch off more than a fifth of the active rows stops and changes nothing,
because somebody clearing the roster tab by accident must not mean 1,800 teachers
cannot sign in. Check the sheet — a filter left applied and a partial paste both
look like this. Once it looks right, the next sync recovers on its own. If the
removal really is genuine:

```bash
docker compose exec worker node dist/scripts/sync-sheets.js --force
```

The override is recorded on the sync run, so it cannot pass unnoticed.

---

## Backups — required before launch, not after

Everything previously sat in one Google account, so losing that account lost
every case ever filed. A rented server with no off-site copy is the same risk
wearing a different hat.

Install the tools and configure a remote:

```bash
sudo apt-get install -y gnupg rclone postgresql-client
rclone config          # create a remote, e.g. "backups"
```

Set `BACKUP_PASSPHRASE` (generate it: `openssl rand -base64 48`) and
`BACKUP_REMOTE` (e.g. `backups:mopse-bot`) in `.env`.

**Record the passphrase somewhere that is not this server.** An encrypted backup
whose passphrase died with the machine is not a backup.

Run one by hand and watch it succeed:

```bash
./deploy/backup.sh
```

It refuses to report success unless the dump is non-trivial, decrypts correctly,
and is listable on the remote afterwards.

Schedule it nightly at 02:30 Tashkent time:

```bash
sudo crontab -e
```

```cron
CRON_TZ=Asia/Tashkent
30 2 * * * cd /opt/mopse-bot && ./deploy/backup.sh >> /var/log/mopse-backup.log 2>&1
```

### Then test the restore

This is the half that gets skipped, and the half that matters. An untested
backup is a belief, not a capability.

```bash
./deploy/restore-drill.sh
```

It fetches the newest backup, decrypts it, restores into a throwaway database,
asserts the result actually contains tables, prints the row counts, and drops
the scratch database. It never touches live data.

Run it before launch and quarterly after.

---

## Day-to-day

```bash
docker compose ps                     # what is running
docker compose logs -f web worker     # follow both
docker compose restart worker         # restart one piece
docker compose up -d --build          # deploy a new version
```

Connect to the database over an SSH tunnel — Postgres is published on loopback
only and is not reachable from outside the host:

```bash
ssh -L 5432:127.0.0.1:5432 user@server
psql postgres://mopse@localhost:5432/mopse
```

## Time zone

Both processes run with `TZ=Asia/Tashkent`, and the application states the zone
explicitly rather than relying on it. Apps Script inherited the project's zone
automatically; a Linux server defaults to UTC, which is five hours behind. Left
alone, every staff-visible timestamp would have been five hours early and the
07:00 digest would have arrived at midday — the kind of error noticed months
later, if ever.
