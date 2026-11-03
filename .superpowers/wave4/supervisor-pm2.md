# Wire Supervisor into a runnable pm2 service

**Status:** done. `sensibull_tools/live/desk/supervisor.py`'s `Supervisor` now has a
real long-lived entrypoint, a launcher script, and a pm2 daemon entry. Committed
directly to `main` in `/Users/aaditya/Documents/dev/algo-engine/sensibull-desk`.

**Commit SHA:** `66e29ab6a6f13ae5b97a9f6ea8895463ca23d9e8`
(`feat(live): wire the desk-books Supervisor into a runnable pm2 daemon`)

## Env var names chosen

- `DESK_API_URL` — bridge base URL (e.g. `http://127.0.0.1:8790`). No existing
  name in this repo's `.env.example` to match, so chosen fresh, consistent with
  algomaker's own `DESK_PORT` default (8790).
- `DESK_API_TOKEN` — bridge bearer token. Matches algomaker's own established
  name for the same concept (`docs/PYTHON-DESK.md`: "Auth is `Authorization:
  Bearer $DESK_API_TOKEN`").
- `DESK_SUPERVISOR_MODE` (default `paper`), `DESK_SUPERVISOR_INTERVAL_SEC`
  (default `30`), `DESK_SUPERVISOR_BUDGET` (default `20`),
  `DESK_SUPERVISOR_PIDFILE` (default `data/desk/supervisor.pid`) — new knobs
  for this entrypoint, added to `.env.example`.
- `legacy_dir`/`state_dir` intentionally left unset (`None`): they already
  resolve from `SENSIBULL_LIVE_DIR` / `SENSIBULL_DESK_STATE_DIR` one layer
  down inside `store.py`/`driver.py`.

## Pytest counts

Baseline observed in this checkout (clean tree, before any change):
**2220 passed, 0 failed, 5 skipped** (2225 collected). Note: this is the
number I actually saw running `.venv/bin/python -m pytest tests/` twice for
stability — it differs slightly from the "2225 passed / 5 skipped" figure
quoted in the task; I'm reporting what I observed, not the quoted figure.

After the change: **2231 passed, 0 failed, 5 skipped** (2236 collected).
The +11 is 10 new tests in `tests/test_desk_supervisor_main.py` plus 1
auto-discovered case in the repo's `test_no_legacy_imports.py` (a
parametrized architecture guard that picks up every `.py` file, including
the new `supervisor_main.py`, and confirms it doesn't import the quarantined
legacy package). Verified this arithmetic by diffing `pytest --collect-only`
output with/without the new files.

`sensibull_tools/sim/**` was not touched (only `.env.example`,
`ecosystem.config.js`, `scripts/desk-supervisor.sh`,
`sensibull_tools/live/desk/supervisor_main.py`, and
`tests/test_desk_supervisor_main.py`).

## SIGTERM evidence (real subprocess, no network, unreachable fake bridge)

Ran `python -m sensibull_tools.live.desk.supervisor_main` directly as a
background subprocess with `DESK_API_URL=http://127.0.0.1:1` (nothing
listens there — every bridge call gets a fast `ConnectionRefused`, no real
network reachable) and `DESK_SUPERVISOR_INTERVAL_SEC=1`, waited 3s (several
converge ticks), then sent it a real `SIGTERM` and waited on it:

```
started pid=39809
--- pidfile ---
39809--- sending SIGTERM ---
--- exit status: 0 ---
--- pidfile after shutdown ---
(removed, as expected)
--- log output ---
2026-07-29 00:09:37,465 INFO __main__: desk-supervisor: starting mode=paper interval=1.0s pidfile=/tmp/desk_sup_manual/supervisor.pid pid=39809
2026-07-29 00:09:37,487 WARNING sensibull_tools.live.desk.bridge: bridge POST /v1/desk/variants failed: ConnectError('[Errno 61] Connection refused')
2026-07-29 00:09:37,490 WARNING sensibull_tools.live.desk.bridge: bridge GET /v1/desk/books/registry failed: ConnectError('[Errno 61] Connection refused')
2026-07-29 00:09:38,507 WARNING sensibull_tools.live.desk.bridge: bridge GET /v1/desk/books/registry failed: ConnectError('[Errno 61] Connection refused')
2026-07-29 00:09:39,521 WARNING sensibull_tools.live.desk.bridge: bridge GET /v1/desk/books/registry failed: ConnectError('[Errno 61] Connection refused')
2026-07-29 00:09:39,966 INFO __main__: desk-supervisor: received signal 15 — stopping (no square-off)
2026-07-29 00:09:39,966 INFO __main__: desk-supervisor: stopped cleanly (no square-off on shutdown)
```

Exit status **0**. No `POST /v1/desk/actions` ever appears in the log (the
only endpoint that could carry a close/exit action) — zero actions placed,
before or after the signal. Pidfile removed on the way out.

Also verified the single-instance guard the same way: started one instance,
then launched a second against the same pidfile while the first was still
running — second exited **1** with `error: another desk-supervisor is
already running (pid <n>, pidfile ...) — refusing to start a second one
converging the same registry`; the first kept running and exited 0
cleanly on its own SIGTERM afterward.

## What was built

1. `sensibull_tools/live/desk/supervisor_main.py` — the entrypoint (`main()`,
   `run()`, `acquire_pidlock()`/`release_pidlock()`, signal wiring). Builds
   `Bridge`+`Supervisor` from env, `publish_catalogue()` once, then loops
   `converge()` on `DESK_SUPERVISOR_INTERVAL_SEC` via an interruptible
   `threading.Event.wait()`.
2. `scripts/desk-supervisor.sh` — copies `scripts/live-tick.sh`'s repo-root
   resolution, `.env` loading, and `.venv/bin/python` hard-fail-with-message
   pattern; `set -euo pipefail`; execs the entrypoint module.
3. `ecosystem.config.js` — new `desk-supervisor` app, `autorestart: true`,
   **no** `cron_restart` (a comment explains why, mirroring the existing
   `sensibull-live` comment's style: this process holds per-book worker
   state in memory between marks, unlike the stateless one-shot
   `sensibull-live`).
4. SIGTERM/SIGINT handled explicitly; neither touches a book. Tests in
   `tests/test_desk_supervisor_main.py::test_stop_event_leaves_the_book_untouched_no_close_no_removal`
   and `::test_a_real_sigterm_stops_the_loop_via_the_installed_handler` prove
   the worker is never closed, `bridge.actions()` is never called, and the
   supervisor's own `workers` dict still contains the running book after
   shutdown.
5. Pidfile single-instance guard with tests for fresh/second-instance
   (via a real child subprocess pid)/stale/corrupt pidfile cases and both
   release-lock paths.

Not done (per instructions): did not start it under pm2, did not point it at
the production bridge.
