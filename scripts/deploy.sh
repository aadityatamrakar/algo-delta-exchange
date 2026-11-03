#!/usr/bin/env bash
#
# Pull, install, build, restart — the whole update in one command.
#
#   make deploy            update to origin's tip of the current branch
#   make deploy FORCE=1    ...even inside market hours
#
# Run as the SERVICE USER (`ubuntu`), not root. pm2 is per-user: a deploy run as
# root talks to root's empty daemon, reports success, and leaves the real desk
# running the old code.
#
# Why a script rather than `git pull && make restart`:
#
#   - RESTARTING MID-SESSION IS STILL THE DANGEROUS PART, but not because the
#     book is lost: SIGTERM now stops the runner WITHOUT squaring off (the
#     ledger and strategy state are durable and `onRecover()` resumes them on
#     restart; `DESK_SQUAREOFF_ON_STOP=1` restores the old flatten-on-stop).
#     What a bounce between 09:15 and 15:30 does cost is the gap itself —
#     nothing is watching the stops while the process is down, and a strategy
#     restarted mid-session picks up from recovered state, not from the session
#     it was living. The guard below refuses by default and FORCE=1 overrides.
#   - `npm ci` wipes and rebuilds node_modules (~35s). Doing that when the
#     lockfile has not changed is pure downtime, so it runs only when it must.
#   - A restart that leaves the API dead should FAIL LOUDLY. pm2 reports
#     "online" for a process that is crash-looping, so the health check below is
#     what actually decides whether the deploy worked.
#   - `--update-env` is required for pm2 to re-read `.env.local`; `make restart`
#     carries it, a bare `pm2 restart` does not.

set -euo pipefail

cd "$(dirname "$0")/.."
REPO="$PWD"
API="${DESK_API:-http://127.0.0.1:8890}"
FORCE="${FORCE:-0}"

log()  { printf '\033[36m▸\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- preflight

[ "$(id -u)" -eq 0 ] && die "run as the service user (ubuntu), not root — pm2 is per-user"

command -v git >/dev/null || die "git not found"
NODE_MAJOR="$(node -p 'process.versions.node.split(".").slice(0,2).join("")' 2>/dev/null || echo 0)"
[ "${NODE_MAJOR:-0}" -lt 249 ] && die "node $(node -v 2>/dev/null || echo missing) — need >= 24.9 for crypto.argon2"

# Untracked files are fine: optionConfig_*.json and the order journals live in
# the working tree and are regenerated. MODIFIED TRACKED FILES are not — a
# fast-forward would either fail or silently carry someone's hand-edit forward.
if ! git diff --quiet HEAD -- ':!*.json'; then
  git --no-pager diff --stat HEAD -- ':!*.json'
  die "tracked files are modified — commit, stash or discard before deploying"
fi

# Market hours: 09:15–15:30 IST, Mon–Fri. Uses IST explicitly because the box
# may well be on UTC.
DOW="$(TZ=Asia/Kolkata date +%u)"
HHMM="$((10#$(TZ=Asia/Kolkata date +%H%M)))"
if [ "$DOW" -le 5 ] && [ "$HHMM" -ge 915 ] && [ "$HHMM" -le 1530 ]; then
  if [ "$FORCE" != "1" ]; then
    die "market is OPEN ($(TZ=Asia/Kolkata date +%H:%M) IST) — restarting drops runner state. Re-run with FORCE=1 if you mean it."
  fi
  warn "market is OPEN and FORCE=1 — restarting anyway"
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
BEFORE="$(git rev-parse HEAD)"
log "repo    $REPO"
log "branch  $BRANCH"
log "at      $(git log --oneline -1)"

# ---------------------------------------------------------------- fetch

log "fetching origin/$BRANCH"
git fetch --quiet origin "$BRANCH"
TARGET="$(git rev-parse FETCH_HEAD)"

if [ "$BEFORE" = "$TARGET" ]; then
  log "already at origin's tip — nothing to pull"
  if [ "$FORCE" != "1" ]; then
    log "use FORCE=1 to rebuild and restart anyway"
    exit 0
  fi
  warn "FORCE=1 — rebuilding and restarting on the same commit"
else
  echo
  git --no-pager log --oneline --no-decorate "$BEFORE..$TARGET" | sed 's/^/    /'
  echo
  # --ff-only: a deploy host must never produce a merge commit. If this fails,
  # someone committed on the server and that needs a human.
  git merge --ff-only --quiet FETCH_HEAD || die "not a fast-forward — the server has diverged from origin"
  log "now at  $(git log --oneline -1)"
fi

# ---------------------------------------------------------------- install

if [ ! -d node_modules ] || ! git diff --quiet "$BEFORE" HEAD -- package-lock.json 2>/dev/null; then
  log "lockfile changed (or node_modules missing) — npm ci"
  npm ci
else
  log "lockfile unchanged — skipping npm ci"
fi

# ---------------------------------------------------------------- typecheck

# THE LAST LOCAL GATE (audit F-48).
#
# The dashboard's own `tsc -b` below used to be the only typecheck between a
# pulled commit and a running process — it checks `apps/web` and nothing else,
# so a type error anywhere in the four backend apps or the packages reached
# production and was found by whichever process crashed first.
#
# TESTS LIVE IN CI (`.github/workflows/check.yml`, with a real Mongo). They are
# deliberately not run here: they need a database, they take minutes, and a
# deploy is not the place to discover a red suite. The typecheck is seconds,
# needs nothing, and catches the class of breakage a deploy actually introduces.
log "typechecking (backend + dashboard)"
npm run typecheck || die "typecheck FAILED — nothing was restarted; the desk is still on $BEFORE"

# ---------------------------------------------------------------- build

# Always built: it is ~7s, and `tsc -b` here also builds what it checks.
log "building dashboard"
npm run build --workspace @algomaker/web
[ -f apps/web/dist/index.html ] || die "build produced no apps/web/dist/index.html"

# ---------------------------------------------------------------- restart

# THE BROKER MODE IS WHATEVER `.env.local` SAYS — on a live box, that is the
# real XTS account. `make restart` passes `--update-env`, so pm2 re-reads that
# file; the mode is chosen there, not here, and this line must not pretend
# otherwise.
#
# FORCE=1 skips the interactive arming prompt `make restart` would otherwise
# raise. That is deliberate and it is not a weakening: running a deploy IS the
# operator's deliberate act, the market-hours guard above has already been
# answered, and this script is run non-interactively (over `ssh -t`, or from
# `make deploy-remote`) where a `read` would hang forever waiting for a hand
# that is not there. To change the mode, edit `.env.local` and run
# `make restart` yourself — that path still asks.
log "restarting desk (broker mode from .env.local — on a live box this ARMS the real broker)"
FORCE=1 make restart

# ---------------------------------------------------------------- verify

log "waiting for the API"
for i in $(seq 1 30); do
  if curl -fsS --max-time 2 "$API/health" >/dev/null 2>&1; then
    log "health OK after ${i}s"
    break
  fi
  [ "$i" -eq 30 ] && {
    warn "API did not answer within 30s — last 40 lines:"
    npx pm2 logs dx-api --lines 40 --nostream || true
    die "deploy FAILED — rollback: git checkout $BEFORE && FORCE=1 scripts/deploy.sh"
  }
  sleep 1
done

# A crash-loop shows as "online" in pm2 with a climbing restart count, so the
# health check above is necessary but not sufficient.
RESTARTS="$(npx pm2 jlist 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const l=JSON.parse(s).filter(p=>p.name?.startsWith("dx-"));console.log(l.reduce((a,p)=>a+(p.pm2_env?.restart_time??0),0))}catch{console.log(0)}})' || echo 0)"

echo
make status
echo
log "deployed $BEFORE -> $(git rev-parse --short HEAD)   (dx restart_time total: $RESTARTS)"
log "rollback: git checkout $BEFORE && FORCE=1 scripts/deploy.sh"

# ready:false outside 09:15–15:30 is CORRECT — no ticks flow outside the
# session, and readiness reduces to feedAlive when no books are held.
if [ "$DOW" -le 5 ] && [ "$HHMM" -ge 915 ] && [ "$HHMM" -le 1530 ]; then
  curl -fsS "$API/v1/desk/feed" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const f=JSON.parse(s);if(!f.ready)process.stderr.write(`! feed not ready: feedAlive=${f.feedAlive} booksIncomplete=${f.booksIncomplete}\n`)})' || true
fi
