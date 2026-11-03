# DX emergency flatten

Use this when a Delta account must be flat now and the desk cannot do it. For example, the desk is down, the dashboard's Close does nothing, or dx-watchdog's `close_all FAILED` alert has fired.

## 1. Stop the desk re-entering

Engage the kill switch on the dashboard, or stop the supervisor: `pm2 stop dx-supervisor`. A live desk that is still running will sell straddles again after you flatten.

## 2. Look (dry run, read-only)

```
cd /opt/algomaker-delta
node --env-file=.env.local scripts/dx-flatten.mts --rail live      # or --rail demo
```

This prints every non-zero position and every open order: desk exits, `bkstp…` exchange backstops, and anything manual.

## 3. Flatten

```
node --env-file=.env.local scripts/dx-flatten.mts --rail live --yes
```

The script cancels **every** open order, including stops and backstops (`DELETE /v2/orders/all`). It then sends `POST /v2/positions/close_all`, waits 3 s, and prints what is left. `close_all` skips halted and auction products, so anything under `STILL OPEN` must be closed by hand on Delta's web UI.

## 4. After

- The desk's books still show the legs. Reconcile them before you restart the supervisor: Status → Positions truth, then repair or purge the book.
- If dx-watchdog flattened the account itself (`WATCHDOG LIVE: FLATTENED` alert), the same applies. It does this after `DX_WATCHDOG_FLATTEN_S` (default 300 s) of any desk process being unhealthy while the live account holds positions.
- Ack the alerts on the dashboard banner.

## Planned maintenance with live positions open

dx-watchdog will flatten the live account if a desk process stays down longer than `DX_WATCHDOG_FLATTEN_S`. Before a long stop:

1. Set `DX_WATCHDOG_FLATTEN_S=0` in `.env.local`.
2. Run `pm2 restart dx-watchdog --update-env`. Alerts and backstop checks keep running.
3. Afterwards, remove the line and run the restart again.

The exchange backstops (reduce-only stop-limits at each book's stop line) stay on Delta the whole time.
