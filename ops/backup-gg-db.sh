#!/usr/bin/env bash
# GG — nightly Postgres backup (hardening phase, PROGRESS runbook).
#
# Dumps the production database (gg_dev) in pg_dump custom format
# (compressed) into /home/aman/gg-dev/backups/db/, timestamped, and keeps
# the newest 7 dumps. Install: copy to /home/aman/gg-dev/bin/ on the
# laptop; cron: 15 3 * * * /home/aman/gg-dev/bin/backup-gg-db.sh
#
# Restore (see docs/PROGRESS.md "Backup & restore runbook"):
#   sudo -u postgres createdb gg_restore_test
#   pg_restore --no-owner --role=gg -d "$RESTORE_URL" <dumpfile>
set -euo pipefail

ENV_FILE="${GG_ENV_FILE:-/home/aman/gg-dev/app/.env}"
BACKUP_DIR="${GG_BACKUP_DIR:-/home/aman/gg-dev/backups/db}"
KEEP="${GG_BACKUP_KEEP:-7}"

# Pull DATABASE_URL out of the app env file without sourcing secrets into
# the shell history; pg_dump accepts the URI directly.
DATABASE_URL="$(grep -E '^DATABASE_URL=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
if [[ -z "${DATABASE_URL}" ]]; then
  echo "[backup-gg-db] DATABASE_URL not found in $ENV_FILE" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$BACKUP_DIR/gg_dev-$STAMP.dump"
TMP="$OUT.partial"

pg_dump --format=custom --compress=6 --no-owner -f "$TMP" "$DATABASE_URL"
mv "$TMP" "$OUT"
echo "[backup-gg-db] wrote $OUT ($(du -h "$OUT" | cut -f1))"

# Retention: newest $KEEP dumps survive; older ones are removed.
ls -1t "$BACKUP_DIR"/gg_dev-*.dump 2>/dev/null | tail -n "+$((KEEP + 1))" | while read -r old; do
  echo "[backup-gg-db] pruning $old"
  rm -f "$old"
done
