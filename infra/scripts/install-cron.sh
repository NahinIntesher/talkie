#!/usr/bin/env bash
# Installs Talkie's scheduled jobs for the current user (who must be able to run docker):
#   03:30 UTC daily   database backup (media files too on Sundays)
#   twice a day       TLS certificate renewal, then an nginx reload
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG=/var/log/talkie-cron.log
COMPOSE="docker compose --env-file $ROOT/.env -f $ROOT/infra/docker-compose.yml"

jobs=$(cat <<EOF
# talkie:begin
30 3 * * 1-6 $ROOT/infra/scripts/backup.sh >> $LOG 2>&1
30 3 * * 0 $ROOT/infra/scripts/backup.sh --media >> $LOG 2>&1
17 4,16 * * * $COMPOSE run --rm certbot renew --webroot -w /var/www/certbot --quiet && $COMPOSE exec -T nginx nginx -s reload >> $LOG 2>&1
# talkie:end
EOF
)

current=$(crontab -l 2>/dev/null | sed '/# talkie:begin/,/# talkie:end/d' || true)
printf '%s\n%s\n' "$current" "$jobs" | sed '/^$/d' | crontab -
sudo touch "$LOG" && sudo chown "$(id -un)" "$LOG"
echo "Installed:"
crontab -l | sed -n '/# talkie:begin/,/# talkie:end/p'
