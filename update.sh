#!/bin/bash
# Updates Talkie on cPanel from the `cpanel` branch (built on Linux by GitHub Actions) and restarts it.
# Run inside the app folder:  bash update.sh
# .env, secrets/, node_modules/ and data/ are not in git, so an update never touches them.

# The pull below replaces this very file; run from a copy so bash never reads a file that changed under it.
if [ -z "${TALKIE_UPDATE_COPY:-}" ]; then
  copy="$(mktemp)"
  cp "$0" "$copy"
  TALKIE_UPDATE_COPY="$copy" TALKIE_APP_DIR="$(cd "$(dirname "$0")" && pwd)" exec bash "$copy" "$@"
fi
trap 'rm -f "$TALKIE_UPDATE_COPY"' EXIT

set -eo pipefail
cd "$TALKIE_APP_DIR"

git fetch --quiet origin cpanel
git reset --quiet --hard origin/cpanel   # the branch is build output only: always take it as it is
after=$(git rev-parse --short HEAD)
echo "Code: $after"
if [ -f revision.txt ]; then
  echo "Source: $(cat revision.txt)"
fi

# The app's Node.js environment (cPanel "Setup Node.js App" creates it as ~/nodevenv/<app folder>/<version>).
# CloudLinux's activate script reads variables that may be unset, so it is loaded without strict checks.
for activate in "$HOME/nodevenv/${PWD#"$HOME"/}"/*/bin/activate; do
  # shellcheck disable=SC1090
  [ -f "$activate" ] && source "$activate"
done

mkdir -p tmp
manifest=$(git rev-parse HEAD:package.json)
installed=$(cat tmp/talkie-installed-manifest 2>/dev/null || true)
if [ "$manifest" != "$installed" ] || [ ! -d node_modules ]; then
  echo "Installing packages…"
  npm install --omit=dev --no-audit --no-fund
  printf '%s\n' "$manifest" > tmp/talkie-installed-manifest
fi

touch tmp/restart.txt
echo "Talkie updated to $after. It restarts with the next visit (or press Restart in Setup Node.js App)."
