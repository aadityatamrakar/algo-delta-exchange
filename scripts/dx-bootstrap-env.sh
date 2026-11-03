#!/usr/bin/env bash
# One-time operator script: writes /opt/algomaker-delta/.env.local (mode 600).
# Refuses if the file exists. Prints variable names only, never values.
set -euo pipefail

TARGET="${DX_ENV_FILE:-/opt/algomaker-delta/.env.local}"

if [ -e "$TARGET" ]; then
  echo "refusing: $TARGET already exists" >&2
  exit 1
fi

umask 077
MASTER_KEY="$(openssl rand -hex 32)"
API_TOKEN="$(openssl rand -hex 32)"

cat >"$TARGET" <<ENV
DESK_MASTER_KEY=${MASTER_KEY}
DESK_API_TOKEN=${API_TOKEN}
DESK_MONGO_URL=mongodb://127.0.0.1:27017/algomaker_dx
DESK_BUS_URL=ws://127.0.0.1:8891
DESK_BUS_PORT=8891
DESK_SUPERVISOR_PORT=8893
DESK_PORT=8890
DESK_BROKER=simulate
DESK_VENUE=dx
DESK_WEB_PORT=5000
DESK_CORS_ORIGINS=http://3.108.231.230:5000,http://localhost:5000,http://127.0.0.1:5000
TZ=Asia/Kolkata
NODE_ENV=production
ENV
chmod 600 "$TARGET"

echo "wrote $TARGET (mode 600) with:"
cut -d= -f1 "$TARGET" | sed 's/^/  /'
