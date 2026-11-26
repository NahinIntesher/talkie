#!/bin/bash
# Updates Talkie on cPanel from the `cpanel` branch (built on Linux by GitHub Actions) and restarts it.
# Run inside the app folder:  bash update.sh
# .env, secrets/, node_modules/ and data/ are not in git, so an update never touches them.
set -euo pipefail
cd "$(dirname "$0")"

before=$(git rev-parse HEAD 2>/dev/null || echo none)
git fetch --quiet origin cpanel
git reset --quiet --hard origin/cpanel   # the branch is build output only: always take it as it is
after=$(git rev-parse --short HEAD)

# The app's Node.js environment (cPanel "Setup Node.js App" creates it as ~/nodevenv/<app folder>/<version>).
for activate in "$HOME/nodevenv/${PWD#"$HOME"/}"/*/bin/activate; do
  # shellcheck disable=SC1090
  [ -f "$activate" ] && source "$activate"
done

if [ "$before" = none ] || ! git diff --quiet "$before" HEAD -- package.json; then
  echo "Installing packages…"
  npm install --omit=dev --no-audit --no-fund
fi

mkdir -p tmp && touch tmp/restart.txt
echo "Talkie updated to $after. It restarts with the next visit (or press Restart in Setup Node.js App)."
