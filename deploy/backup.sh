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

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${BACKUP_PASSPHRASE:?BACKUP_PASSPHRASE is required — an unencrypted off-site backup of teacher data is not acceptable}"
: "${BACKUP_REMOTE:?BACKUP_REMOTE is required, e.g. myremote:mopse-backups — a local-only backup is not a backup}"

RETAIN_DAYS="${BACKUP_RETAIN_DAYS:-30}"
STAGING="${BACKUP_STAGING_DIR:-/var/backups/mopse}"
STAMP="$(date +%Y%m%dT%H%M%S)"
DUMP="$STAGING/mopse-$STAMP.dump"
ENCRYPTED="$DUMP.gpg"

for tool in pg_dump gpg rclone; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is not installed"
done

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
pg_dump --format=custom --no-owner --no-privileges --file="$DUMP" "$DATABASE_URL"

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

log "done: $(basename "$ENCRYPTED") is off-site"
