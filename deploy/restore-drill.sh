#!/usr/bin/env bash
#
# Restore the most recent off-site backup into a scratch database and check it
# actually contains something.
#
# The plan requires "an off-site nightly backup, with a restore actually tested".
# The second half is the half that gets skipped, and it is the half that matters:
# an untested backup is a belief, not a capability. Run this before launch, and
# on a schedule afterwards.
#
# It never touches the live database. It restores into a throwaway one and drops
# it at the end.
#
# Usage:
#   deploy/restore-drill.sh                 # newest backup on the remote
#   deploy/restore-drill.sh mopse-2026....gpg

set -Eeuo pipefail

log() { printf '%s restore-drill: %s\n' "$(date --iso-8601=seconds)" "$*" >&2; }
die() { log "FAILED: $*"; exit 1; }

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname -- "$SCRIPT_DIR")"

# shellcheck source=/dev/null
[ -f "$REPO_DIR/.env" ] && set -a && . "$REPO_DIR/.env" && set +a

: "${BACKUP_DATABASE_URL:?BACKUP_DATABASE_URL is required. DATABASE_URL points at the compose service hostname, which the host cannot resolve — use 127.0.0.1 here}"
: "${BACKUP_PASSPHRASE:?BACKUP_PASSPHRASE is required}"
: "${BACKUP_REMOTE:?BACKUP_REMOTE is required}"

for tool in pg_restore psql gpg rclone; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is not installed"
done

WORK="$(mktemp -d)"
SCRATCH_DB="mopse_restore_drill_$(date +%s)"
# Same server, different database. Strips any path/query off the URL.
ADMIN_URL="${BACKUP_DATABASE_URL%%\?*}"
BASE_URL="${ADMIN_URL%/*}"

cleanup() {
  psql "$BASE_URL/postgres" -q -c "DROP DATABASE IF EXISTS \"$SCRATCH_DB\";" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

ARCHIVE="${1:-}"
if [ -z "$ARCHIVE" ]; then
  log "finding the newest backup on $BACKUP_REMOTE"
  ARCHIVE="$(rclone lsf "$BACKUP_REMOTE" --include 'mopse-*.dump.gpg' | sort | tail -n 1)"
  [ -n "$ARCHIVE" ] || die "no backups found on $BACKUP_REMOTE — this is the alarm, not the drill"
fi
log "testing $ARCHIVE"

rclone copyto "$BACKUP_REMOTE/$ARCHIVE" "$WORK/$ARCHIVE" || die "could not fetch $ARCHIVE"

log "decrypting"
gpg --batch --yes --decrypt --pinentry-mode loopback \
    --passphrase-fd 3 --output "$WORK/restore.dump" "$WORK/$ARCHIVE" 3<<<"$BACKUP_PASSPHRASE" \
  || die "decryption failed — is BACKUP_PASSPHRASE the one used when this was written?"

log "creating scratch database $SCRATCH_DB"
psql "$BASE_URL/postgres" -q -c "CREATE DATABASE \"$SCRATCH_DB\";" || die "could not create the scratch database"

log "restoring"
pg_restore --no-owner --no-privileges --dbname "$BASE_URL/$SCRATCH_DB" "$WORK/restore.dump" \
  || die "pg_restore failed — this backup would NOT have saved you"

# A restore that produces an empty schema exits zero and proves nothing, so
# check the result rather than the exit code.
TABLES="$(psql "$BASE_URL/$SCRATCH_DB" -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';")"
[ "$TABLES" -gt 0 ] || die "restored database has no tables — the backup is useless"

log "restored $TABLES tables"
psql "$BASE_URL/$SCRATCH_DB" -c "
  SELECT relname AS table, n_live_tup AS approx_rows
  FROM pg_stat_user_tables ORDER BY n_live_tup DESC LIMIT 15;"

log "PASSED — $ARCHIVE restores cleanly. Scratch database dropped."
