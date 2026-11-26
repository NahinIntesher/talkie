#!/usr/bin/env bash
# Nightly backup: every talkie_* database (consistent snapshot) and, with --media, the encrypted upload volume.
# Keeps 14 days. Installed as a cron job by infra/scripts/install-cron.sh.
#   infra/scripts/backup.sh            databases only
#   infra/scripts/backup.sh --media    databases and media files
# Copy /var/backups/talkie off the server too (rclone, S3, another machine), a backup on the same disk is not enough.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
DEST="${BACKUP_DIR:-/var/backups/talkie}"
KEEP_DAYS="${KEEP_DAYS:-14}"
STAMP="$(date -u +%Y%m%d-%H%M)"
COMPOSE=(docker compose --env-file .env -f infra/docker-compose.yml --profile localdb)
mkdir -p "$DEST"
umask 077

if grep -qE '^DB_HOST=.+' .env 2>/dev/null; then
  echo "hosted database: back it up from its control panel (cPanel → Backup); only media files are saved here"
  [[ "${1:-}" == "--media" ]] || exit 0
else

"${COMPOSE[@]}" exec -T mysql sh -c '
  export MYSQL_PWD="$(cat /run/secrets/mysql_root)"
  dbs=$(mysql -uroot -N -e "SHOW DATABASES LIKE '"'"'talkie\\_%'"'"'")
  exec mysqldump -uroot --single-transaction --quick --routines --triggers --set-gtid-purged=OFF --databases $dbs
' | gzip -9 > "$DEST/db-$STAMP.sql.gz.part"
mv "$DEST/db-$STAMP.sql.gz.part" "$DEST/db-$STAMP.sql.gz"
echo "database backup: $DEST/db-$STAMP.sql.gz ($(du -h "$DEST/db-$STAMP.sql.gz" | cut -f1))"
fi

if [[ "${1:-}" == "--media" ]]; then
  volume="$(docker volume ls -q | grep -E '(^|_)media-data$' | head -n1)"
  if [[ -n "$volume" ]]; then
    docker run --rm -v "$volume":/data:ro -v "$DEST":/backup alpine tar czf "/backup/media-$STAMP.tgz" -C /data .
    echo "media backup: $DEST/media-$STAMP.tgz"
  fi
fi

find "$DEST" -name 'db-*.sql.gz' -mtime +"$KEEP_DAYS" -delete
find "$DEST" -name 'media-*.tgz' -mtime +"$KEEP_DAYS" -delete
