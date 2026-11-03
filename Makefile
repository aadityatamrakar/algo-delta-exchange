# Desk system — local development and operation.
#
# Thin wrapper over pm2, which does the actual supervising. The point is that
# the common paths are one word, and the DANGEROUS path is not.
#
#   make up        start everything, broker mode from .env.local
#   make down      stop everything
#   make status    what is running, plus feed readiness
#   make logs      tail everything
#   make live      start with the REAL broker — asks for confirmation
#
# `make up` IS NOT SAFE BY CONSTRUCTION, whatever it used to claim here, AND
# NEITHER IS `make restart`. `ecosystem.desk.config.cjs` lets `.env.local` win
# over the ecosystem's own DESK_BROKER, by design — a live box must stay armed
# across a restart rather than silently drop to simulate. So on a box whose
# `.env.local` says `xts`, plain `make up` arms the real broker, and so does
# `make restart`: `--update-env` re-reads that very file, so a restart can arm a
# mode that was never running. Both targets read it and make you type the mode
# back before they proceed; `FORCE=1` skips the prompt for scripts.

PM2      := npx pm2
ECO      := ecosystem.desk.config.cjs
MONGO    := mongodb://127.0.0.1:27017/algomaker_dx
API      := http://127.0.0.1:8890
NODE     := node

# ---------------------------------------------------------- the arming guard
#
# THIS PARSER MUST AGREE WITH `loadEnvFile` (ecosystem.desk.config.cjs:46-65),
# because that function is what actually decides the broker mode. A `grep -E
# '^DESK_BROKER='` did not: it missed leading whitespace and spaces around the
# `=`, both of which `loadEnvFile` trims and accepts — so `  DESK_BROKER=xts`
# armed the REAL broker with no prompt at all, under a banner saying `simulate`.
# It also kept the quotes on `DESK_BROKER="xts"`, which turned the confirmation
# into "type xts including the quotation marks".
#
# So, in the same order `loadEnvFile` does it: take everything after the `=`,
# trim surrounding whitespace, then strip ONE surrounding pair of quotes.
BROKER_MODE = sed -nE "s/^[[:space:]]*DESK_BROKER[[:space:]]*=[[:space:]]*//p" .env.local 2>/dev/null \
              | tail -1 | sed -E "s/[[:space:]]*\$$//; s/^[\"'](.*)[\"']\$$/\1/"

# Refuse to arm the real broker without the operator typing the mode back.
# `$(1)` is the word for what is about to happen (`start`, `restart`), because a
# guard that describes the wrong action is a guard people learn to skip.
# FORCE=1 bypasses it, for scripts that have already made the decision.
define ARM_GUARD
mode=$$($(BROKER_MODE)); \
mode=$${mode:-simulate}; \
if [ "$$mode" != "simulate" ] && [ "$(FORCE)" != "1" ]; then \
  echo ""; \
  echo "  .env.local sets DESK_BROKER=$$mode — this $(1) ARMS THE REAL BROKER."; \
  printf "  Type '$$mode' to continue (or FORCE=1 to skip this check): " && read ans && [ "$$ans" = "$$mode" ]; \
fi
endef

# ------------------------------------------------------------------- remote
#
# The server, for `make deploy-remote`. Overridable so this file carries no
# secret and works against a second box:
#
#   make deploy-remote DEPLOY_HOST=ubuntu@1.2.3.4 SSH_KEY=~/.ssh/desk.pem
#
# The IP is already in docs/SERVER-REBUILD.md; the KEY is not, and must not be.
DEPLOY_HOST ?= ubuntu@3.108.231.230
DEPLOY_PATH ?= /opt/algomaker-delta
# The key PATH is not a secret and the key itself is outside the repo, so
# defaulting it costs nothing and removes a flag nobody remembers. Override for
# a different box; the file never leaves your machine either way.
SSH_KEY     ?= $(HOME)/Documents/dev/aws_keys/wealthcreator.pem
SSH_OPTS    := $(if $(SSH_KEY),-i $(SSH_KEY),)

.DEFAULT_GOAL := help
.PHONY: help up down restart deploy deploy-remote status-remote logs-remote status logs logs-api logs-gateway logs-md live \
        logs-runner strategies sync seed positions feed check test typecheck web mongo-up e2e clean-logs \
        watcher watcher-test

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

# ---------------------------------------------------------------- lifecycle

up: mongo-up ## Start everything (broker mode from .env.local; default simulate)
	@mkdir -p logs
	@$(call ARM_GUARD,start)
	# --update-env is REQUIRED: pm2 keeps the previous process definition and
	# will not re-read the ecosystem's env on a restart without it, so an edited
	# .env.local (or a changed broker mode) is silently ignored.
	$(PM2) startOrRestart $(ECO) --update-env
	@mode=$$($(BROKER_MODE)); \
	echo ""; \
	echo "  desk up (broker: $${mode:-simulate}). Feed needs ~90s to warm up."; \
	echo "  make status   check readiness"; \
	echo "  make logs     follow"

# Stopping does NOT square off the hosted book (2026-08-15, F-8): the runner's
# ledger and strategy state are durable and resume on restart, and the EOD tick
# backstop at 15:30 owns the day-end flatten. pm2 cannot pass an env var to a
# process it is stopping, so the old flatten-on-stop behaviour is opt-in at
# BOOT: set DESK_SQUAREOFF_ON_STOP=1 in .env.local. To get flat before a stop,
# flatten from the dashboard (or /v1/desk/close-all) first.
down: ## Stop everything (does NOT square off — see comment)
	-$(PM2) stop dx
	@echo "desk stopped (positions NOT squared off; processes retained — 'make clean' to remove)"

# SAME GUARD AS `up`, because this is the same act.
#
# The comment here used to say a restart "re-arms whatever was ALREADY running,
# rather than choosing a mode". That is false, and `--update-env` is exactly why
# it is false: the flag exists so pm2 RE-READS the ecosystem env, which reads
# `.env.local`. Edit that file to `xts` and `make restart` arms the real broker
# on the next line — from a target that asked nothing and printed no warning.
#
# `scripts/deploy.sh` passes FORCE=1, which is correct there and stated at the
# call site: running a deploy is itself the deliberate act this prompt asks for.
restart: ## Restart everything (re-reads .env.local; asks before arming the real broker)
	@$(call ARM_GUARD,restart)
	$(PM2) startOrRestart $(ECO) --update-env

deploy: ## Pull, install, build, restart — refuses during market hours (FORCE=1 to override)
	@bash scripts/deploy.sh

# Runs the SAME `make deploy` on the server rather than reimplementing it here.
# A second deploy path is a second thing to keep in step, and the guard that
# refuses during market hours lives in that script — a laptop-side copy would
# eventually disagree with it.
#
# `ssh -t` because the script writes progress as it goes and may prompt; without
# a TTY the output arrives in one lump at the end, or not at all.
# `FORCE` is forwarded so overriding the market-hours guard stays a deliberate
# thing you type, not a default.
deploy-remote: ## Deploy on the server over SSH (DEPLOY_HOST=, SSH_KEY=, FORCE=1)
	@echo "deploying to $(DEPLOY_HOST):$(DEPLOY_PATH)"
	@ssh $(SSH_OPTS) -t $(DEPLOY_HOST) "cd $(DEPLOY_PATH) && FORCE=$(FORCE) make deploy"

status-remote: ## pm2 list + health on the server
	@ssh $(SSH_OPTS) $(DEPLOY_HOST) "cd $(DEPLOY_PATH) && npx pm2 list && curl -s localhost:8890/health && echo"

logs-remote: ## Follow the server's desk logs (Ctrl-C to stop)
	@ssh $(SSH_OPTS) -t $(DEPLOY_HOST) "cd $(DEPLOY_PATH) && npx pm2 logs dx --lines 50"

clean: ## Remove the desk processes from pm2 entirely
	-$(PM2) delete dx

live: mongo-up ## Start with the REAL broker (asks first)
	@echo "This starts the gateway against the REAL XTS account."
	@echo "Orders for allowlisted tags WILL reach the exchange."
	@printf "Type 'live' to continue: " && read ans && [ "$$ans" = "live" ]
	@mkdir -p logs
	$(PM2) startOrRestart $(ECO) --env live --update-env
	@echo "desk up in LIVE mode"

# ------------------------------------------------------------------ status

status: ## Process list + feed readiness + pending orders
	@$(PM2) list
	@echo ""
	@echo "-- feed --"
	@curl -s -m 3 $(API)/v1/desk/feed 2>/dev/null || echo "  api not reachable"
	@echo ""
	@echo "-- broker mode --"
	@grep -h "BROKER MODE" logs/dx-gateway-out.log 2>/dev/null | tail -1 || echo "  gateway not started"

feed: ## Feed readiness only
	@curl -s $(API)/v1/desk/feed && echo ""

logs: ## Tail every desk process
	$(PM2) logs dx

logs-api: ## Tail the bridge
	$(PM2) logs dx-api

logs-gateway: ## Tail the order gateway
	$(PM2) logs dx-gateway

logs-md: ## Tail market data
	$(PM2) logs dx-marketdata

logs-runner: ## Tail the hosted strategy runner
	$(PM2) logs dx-runner

strategies: ## Registry rows + the runner's observed state for each
	@curl -s $(API)/v1/desk/strategies && echo ""

clean-logs: ## Truncate the log files
	$(PM2) flush

# -------------------------------------------------------------------- data

mongo-up: ## Ensure the local MongoDB replica set is running
	@docker start algomaker-mongo >/dev/null 2>&1 || true
	@$(NODE) -e "(async()=>{const {connectMongo}=await import('./apps/api/src/mongo.ts');\
	  try{const h=await connectMongo('$(MONGO)',{serverSelectionTimeoutMS:3000});await h.close();\
	  console.log('mongo ok')}catch(e){console.error('MONGO UNREACHABLE:',e.message);process.exit(1)}})()" 2>/dev/null

sync: ## Refresh instruments + NSE and BSE freeze limits
	@DESK_MONGO_URL=$(MONGO) $(NODE) apps/api/src/cli.ts sync
	@DESK_MONGO_URL=$(MONGO) $(NODE) -e "(async()=>{\
	  const {connectMongo}=await import('./apps/api/src/mongo.ts');\
	  const {syncFreezeLimits,syncBseFreezeLimits}=await import('./apps/marketdata/src/sync-runner.ts');\
	  const h=await connectMongo(process.env.DESK_MONGO_URL);\
	  await syncFreezeLimits({collection:h.db.collection('desk-freeze-limits'),log:(m,c)=>console.log(m,c||'')});\
	  await syncBseFreezeLimits({collection:h.db.collection('desk-freeze-limits'),log:(m,c)=>console.log(m,c||'')});\
	  await h.close()})()" 2>/dev/null

seed: ## Seed the BHEL opening position (paper)
	@DESK_MONGO_URL=$(MONGO) $(NODE) apps/api/src/cli.ts seed-bhel --replace

positions: ## Print the BHEL book with greeks
	@DESK_MONGO_URL=$(MONGO) $(NODE) apps/api/src/cli.ts positions BHEL --spot $${SPOT:-417}

# --------------------------------------------------------------- frontend

web: ## Run the dashboard dev server
	cd apps/web && npx vite

web-build: ## Build the dashboard
	cd apps/web && npx vite build

# ------------------------------------------------------------------ checks

test: ## Full test suite
	npm test

typecheck: ## Typecheck everything
	npm run typecheck

# ------------------------------------------------------------------ watcher
# The Windows folder watcher (apps/watcher). Pure Go, no third-party modules.

GO ?= $(shell command -v go 2>/dev/null || echo /usr/local/go/bin/go)
WATCHER_VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)

watcher: ## Build apps/watcher/dist/watcher.exe (Windows amd64, pure Go) and the download, dist/delta-desk-watcher.zip
	cd apps/watcher && CGO_ENABLED=0 GOOS=windows GOARCH=amd64 $(GO) build -trimpath -ldflags "-H=windowsgui -X main.version=$(WATCHER_VERSION)" -o dist/watcher.exe .
	# the zip: the exe, install.cmd, its script and the README, with Windows line endings; served at /download/ (runbook section 8)
	cd apps/watcher && rm -rf dist/kit && mkdir dist/kit && cp dist/watcher.exe dist/kit/ \
	  && for f in install/*; do sed 's/\r*$$/\r/' "$$f" > "dist/kit/$${f#install/}"; done \
	  && rm -f dist/delta-desk-watcher.zip && cd dist/kit && python3 -m zipfile -c ../delta-desk-watcher.zip * && cd .. && rm -rf kit

watcher-test: ## Go vet (linux + windows) and tests for the watcher
	cd apps/watcher && CGO_ENABLED=0 $(GO) vet ./... && CGO_ENABLED=0 GOOS=windows GOARCH=amd64 $(GO) vet ./... && CGO_ENABLED=0 $(GO) test ./...

check: typecheck test watcher-test ## Typecheck + tests
