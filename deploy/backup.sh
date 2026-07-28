#!/usr/bin/env bash
#
# Nightly encrypted backup, pushed OFF the server.
#
# The concerns list records that everything sat in one Google account, so losing
# that account lost every case ever filed. A rented server with no off-site copy
# is the same single point of failure wearing a different hat: one failed disk,
# one unpaid invoice, one mistaken `docker compose down -v`, and the case history
# is gone. This is a launch requirement, not a nice-to-have.
#
# The script fails loudly and exits non-zero if anything goes wrong, including
# the off-site push. A backup that only exists on the machine being backed up is
# not a backup, and reporting success for one would be worse than not running.
#
# Usage:  deploy/backup.sh
# Cron:   see deploy/README.md — the worker's heartbeat alerts if this stops running.

set -Eeuo pipefail

log() { printf '%s backup: %s\n' "$(date --iso-8601=seconds)" "$*" >&2; }
die() { log "FAILED: $*"; exit 1; }
trap 'die "unexpected error on line $LINENO"' ERR

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname -- "$SCRIPT_DIR")"

# shellcheck source=/dev/null
[ -f "$REPO_DIR/.env" ] && set -a && . "$REPO_DIR/.env" && set +a

# Deliberately NOT DATABASE_URL. That value is written for the application
# containers, where the database is reachable as the compose service name
# "postgres" — a hostname that exists only inside the compose network. This
# script runs from the host, out of cron, where "postgres" does not resolve at
# all. Postgres is published on loopback for exactly this.
: "${BACKUP_DATABASE_URL:?BACKUP_DATABASE_URL is required. DATABASE_URL points at the compose hostname \"postgres\", which the host cannot resolve — use 127.0.0.1 here. See .env.example}"
: "${BACKUP_PASSPHRASE:?BACKUP_PASSPHRASE is required — an unencrypted off-site backup of teacher data is not acceptable}"
: "${BACKUP_REMOTE:?BACKUP_REMOTE is required, e.g. myremote:mopse-backups — a local-only backup is not a backup}"

RETAIN_DAYS="${BACKUP_RETAIN_DAYS:-30}"
STAGING="${BACKUP_STAGING_DIR:-/var/backups/mopse}"
STAMP="$(date +%Y%m%dT%H%M%S)"
DUMP="$STAGING/mopse-$STAMP.dump"
ENCRYPTED="$DUMP.gpg"

for tool in pg_dump psql gpg rclone; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is not installed"
done

# pg_dump refuses to dump a server newer than itself, and Ubuntu 24.04 ships
# client 16 while this stack runs PostgreSQL 17 — so the default apt package
# produces a backup that never runs, every night, silently. Fail loudly here
# instead, with the fix in the message.
DUMP_MAJOR="$(pg_dump --version | grep -oE '[0-9]+' | head -1)"
SERVER_MAJOR="$(psql "$BACKUP_DATABASE_URL" -tAc 'SHOW server_version_num' | cut -c1-2)"
[ -n "$SERVER_MAJOR" ] || die "could not reach the database at BACKUP_DATABASE_URL"
[ "$DUMP_MAJOR" -ge "$SERVER_MAJOR" ] || die "pg_dump is version $DUMP_MAJOR but the server is $SERVER_MAJOR. pg_dump refuses to dump a newer server. Install postgresql-client-$SERVER_MAJOR from the PGDG repository — see deploy/README.md"

mkdir -p "$STAGING"
chmod 700 "$STAGING"

# Clean up the plaintext dump however we exit. An unencrypted copy of every
# teacher's personal data must not survive a failure part-way through.
cleanup() { rm -f "$DUMP"; }
trap 'cleanup; die "unexpected error on line $LINENO"' ERR
trap cleanup EXIT

log "dumping database"
# Custom format: compressed, and restorable table-by-table, which matters when
# the thing you need back is one accidentally-cleared table rather than the lot.
pg_dump --format=custom --no-owner --no-privileges --file="$DUMP" "$BACKUP_DATABASE_URL"

DUMP_BYTES="$(stat -c %s "$DUMP")"
[ "$DUMP_BYTES" -gt 1024 ] || die "dump is only ${DUMP_BYTES} bytes — refusing to ship an empty backup over a good one"
log "dump written, ${DUMP_BYTES} bytes"

log "encrypting"
# --pinentry-mode loopback is required from GnuPG 2.1 on: without it gpg ignores
# --passphrase-fd and tries to open a prompt, which under cron means hanging
# forever rather than failing.
gpg --batch --yes --symmetric --cipher-algo AES256 --pinentry-mode loopback \
    --passphrase-fd 3 --output "$ENCRYPTED" "$DUMP" 3<<<"$BACKUP_PASSPHRASE"

# Verify the encrypted file actually decrypts before we rely on it. An
# unverified backup is a guess, and the moment you discover the guess was wrong
# is the moment you needed it.
log "verifying the encrypted copy decrypts"
gpg --batch --yes --decrypt --pinentry-mode loopback \
    --passphrase-fd 3 --output /dev/null "$ENCRYPTED" 3<<<"$BACKUP_PASSPHRASE" \
  || die "the encrypted backup does not decrypt with BACKUP_PASSPHRASE"

log "pushing off-site to $BACKUP_REMOTE"
rclone copy "$ENCRYPTED" "$BACKUP_REMOTE" --checksum \
  || die "off-site push failed — the backup exists only on this server, which does not count"

log "confirming it arrived"
rclone lsf "$BACKUP_REMOTE/$(basename "$ENCRYPTED")" >/dev/null \
  || die "off-site copy is not listable after upload"

rm -f "$ENCRYPTED"

log "pruning copies older than ${RETAIN_DAYS} days"
rclone delete "$BACKUP_REMOTE" --min-age "${RETAIN_DAYS}d" --include 'mopse-*.dump.gpg' || \
  log "WARNING: pruning failed; backups are safe but will accumulate"

# Report success into the same table the worker's heartbeat watches, so a cron
# job that silently stops running becomes an alarm within the day rather than a
# discovery three months later when a restore is needed. Thirty hours, so one
# missed night is enough to raise it.
psql "$BACKUP_DATABASE_URL" -q -c "
  INSERT INTO job_runs (job_name, last_success_at, expected_interval_seconds)
  VALUES ('nightly_backup', now(), 108000)
  ON CONFLICT (job_name) DO UPDATE
    SET last_success_at = now(), consecutive_failures = 0, last_error = NULL, alerted_at = NULL;" \
  || log "WARNING: the backup succeeded but its heartbeat could not be recorded"

log "done: $(basename "$ENCRYPTED") is off-site"
