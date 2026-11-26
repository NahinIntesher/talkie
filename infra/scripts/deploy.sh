#!/usr/bin/env bash
# Builds and (re)starts Talkie on the VPS. Run from anywhere inside the repository:
#   infra/scripts/deploy.sh                 first run: creates secrets and .env, then stops so you can edit .env
#   LETSENCRYPT_EMAIL=you@example.com infra/scripts/deploy.sh    issues the TLS certificate (first time) and deploys
#   infra/scripts/deploy.sh                 later runs: rebuild, migrate, rolling restart
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
DOMAIN="${DOMAIN:-talkie.kodofact.com}"
COMPOSE=(docker compose --env-file .env -f infra/docker-compose.yml)

say() { printf '\n\033[1;35m==> %s\033[0m\n' "$*"; }
random() { openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 43; }

# ───────── Secrets (created once, never overwritten) ─────────
say "Secrets"
mkdir -p secrets && chmod 700 secrets
if [[ ! -f secrets/jwt-private.pem ]]; then
  openssl genpkey -algorithm ed25519 -out secrets/jwt-private.pem
  openssl pkey -in secrets/jwt-private.pem -pubout -out secrets/jwt-public.pem
  echo "    created the access-token signing key"
fi
for name in mysql-root mysql-password; do
  if [[ ! -f "secrets/${name}.txt" ]]; then random > "secrets/${name}.txt"; echo "    created secrets/${name}.txt"; fi
done
# Containers run as their own users and read these through bind mounts; the folder itself stays private.
chmod 644 secrets/*.pem secrets/*.txt

# ───────── Environment ─────────
if [[ ! -f .env ]]; then
  cp infra/env.production.example .env
  sed -i "s|^INTERNAL_TOKEN=.*|INTERNAL_TOKEN=$(random)|; s|^OTP_PEPPER=.*|OTP_PEPPER=$(random)|" .env
  chmod 600 .env
  say "Created .env, fill in OWNER_EMAILS, SMTP_* and LIVEKIT_*, then run this script again."
  exit 0
fi
get() { grep -E "^$1=" .env | tail -n1 | cut -d= -f2-; }
[[ "$(get NODE_ENV)" == "production" ]] || { echo ".env must have NODE_ENV=production" >&2; exit 1; }
[[ -n "$(get SMTP_HOST)" ]] || { echo ".env: SMTP_HOST is required (sign-in codes are sent by email)" >&2; exit 1; }
[[ -n "$(get OWNER_EMAILS)" ]] || echo "    warning: OWNER_EMAILS is empty, nobody will be able to open the admin panel"
[[ -n "$(get LIVEKIT_URL)" ]] || echo "    warning: LIVEKIT_URL is empty, calls and meetings are turned off"
grep -qE '^DEV_FIXED_OTP=.+' .env && { echo ".env: remove DEV_FIXED_OTP in production" >&2; exit 1; }

# DB_HOST set → a hosted database (cPanel); empty → the bundled MySQL container.
if [[ -n "$(get DB_HOST)" ]]; then
  if [[ -n "$(get DB_SHARED_NAME)" ]]; then
    echo "    database: $(get DB_SHARED_NAME) on $(get DB_HOST) (hosted, one database for every service)"
  elif [[ -n "$(get DB_NAME_PREFIX)" ]]; then
    echo "    databases: $(get DB_NAME_PREFIX)auth, $(get DB_NAME_PREFIX)users, … on $(get DB_HOST) (hosted)"
  else
    echo "    warning: set DB_SHARED_NAME (one database) or DB_NAME_PREFIX, otherwise databases must be named talkie_auth, talkie_users, …"
  fi
  grep -qE '^DB_PASSWORD=.*\$' .env && { echo ".env: DB_PASSWORD contains \$, which Docker Compose would expand; change the password" >&2; exit 1; }
else
  COMPOSE+=(--profile localdb)
fi

# ───────── TLS certificate (first deploy only) ─────────
if [[ ! -d "/etc/letsencrypt/live/${DOMAIN}" ]]; then
  : "${LETSENCRYPT_EMAIL:?Set LETSENCRYPT_EMAIL=you@example.com for the first certificate}"
  say "TLS certificate for ${DOMAIN} (port 80 must reach this server)"
  "${COMPOSE[@]}" stop nginx 2>/dev/null || true
  "${COMPOSE[@]}" run --rm -p 80:80 certbot certonly --standalone -d "${DOMAIN}" \
    --email "${LETSENCRYPT_EMAIL}" --agree-tos --no-eff-email --non-interactive
fi

# ───────── Build, migrate, start ─────────
say "Building images"
"${COMPOSE[@]}" --profile tools build --pull

say "Starting the database and Redis"
if [[ -z "$(get DB_HOST)" ]]; then "${COMPOSE[@]}" up -d mysql redis; else "${COMPOSE[@]}" up -d redis; fi

say "Applying database migrations"
"${COMPOSE[@]}" run --rm migrate

say "Starting Talkie"
"${COMPOSE[@]}" up -d --remove-orphans
"${COMPOSE[@]}" exec -T nginx nginx -s reload 2>/dev/null || true
docker image prune -f >/dev/null

say "Checking https://${DOMAIN}"
for attempt in $(seq 1 30); do
  if curl -fsS -o /dev/null "https://${DOMAIN}/"; then
    "${COMPOSE[@]}" ps --format 'table {{.Service}}\t{{.Status}}'
    say "Talkie is live at https://${DOMAIN}"
    exit 0
  fi
  sleep 3
done
echo "The site did not answer yet. Look at: docker compose -f infra/docker-compose.yml logs --tail=100" >&2
exit 1
