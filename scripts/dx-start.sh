#!/usr/bin/env bash
# Start the Delta desk (pm2 namespace dx), one app at a time, stopping on the first error.
# Starts: dx-marketdata dx-api dx-gateway dx-supervisor dx-watchdog dx-web. Never dx-runner or dx-traders.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
ENV_FILE=.env.local
ECO=ecosystem.desk.config.cjs

die() { echo "REFUSED: $*" >&2; exit 1; }

[ -f "$ENV_FILE" ] || die "$ENV_FILE is missing - run: bash scripts/dx-bootstrap-env.sh"
grep -Eq '^DESK_VENUE=dx[[:space:]]*$' "$ENV_FILE" || die "$ENV_FILE does not contain DESK_VENUE=dx"
if grep -E '^DESK_MONGO_URL=' "$ENV_FILE" | grep -Eq '/algomaker([?"'"'"'[:space:]]|$)'; then
  die "$ENV_FILE points at db 'algomaker' - this desk uses algomaker_dx"
fi
if grep -E '^DESK_MONGO_URL=' "$ENV_FILE" | grep -Evq '/algomaker_dx([?"'"'"'[:space:]]|$)'; then
  die "DESK_MONGO_URL in $ENV_FILE is not db algomaker_dx"
fi

# Every app name in the ecosystem must be a dx- app (the legacy system must not be reachable from here).
names=$(node -e "for (const a of require('./$ECO').apps) console.log(a.name)")
[ -n "$names" ] || die "no apps found in $ECO"
while IFS= read -r n; do
  case "$n" in dx-*) ;; *) die "$ECO has an app named '$n' that does not start with dx-";; esac
done <<<"$names"

echo "building the web (VITE_DESK_VENUE=dx)..."
VITE_DESK_VENUE=dx npm run build --workspace @algomaker/web

for app in dx-marketdata dx-api dx-gateway dx-supervisor dx-watchdog dx-web; do
  echo "starting $app"
  npx pm2 start "$ECO" --only "$app"
done

npx pm2 list
echo "dx started. dx-runner and dx-traders are not started on purpose."
