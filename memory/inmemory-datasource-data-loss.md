---
name: inmemory-datasource-data-loss
description: "7 LoopBack models sit on a memory connector and lose all data on restart (incl. strategyPNL); algopaper is memory-backed but paperstream watches a Mongo collection it never writes"
metadata:
  type: reference
---

`server/datasources.json` defines two datasources:
- `cloud` — MongoDB Atlas
- `db` — `{"connector": "memory"}` → **not persistent**

Per `server/model-config.json`, these 7 models are on `db` and **lose all data whenever a process
restarts**, with no error raised:

`strategy` · `strategyPNL` · `payment` · `log` · `manager` · `algopaper` · `algouser`

**Worst case:** `strategyPNL` receives 10-second M2M snapshots, so a mid-session crash or restart
silently truncates the whole day's P&L history to `[]`. Any P&L report covering a day with a
restart is wrong and gives no indication of it.

## Related consistency bug
`algopaper` is memory-backed, but `server/boot/paperstream.js:413-420` watches an `algopaper`
**MongoDB collection** via a raw change stream — a collection the memory-backed model never writes
to. `server/tools/paperalgo.js` creates priceless `Algopaper` documents expecting a fill-stamp that
can never arrive, silently corrupting downstream P&L.

## How to apply
- Never trust `strategyPNL` history across a restart; cross-check against the `paper-trade`
  collection (which is on `cloud` and does persist).
- Any rewrite must move all 7 models to real persistence. This is not a "nice to have" — the
  P&L numbers the dashboard shows are affected.
- Remember every strategy process boots the whole app ([[strategy-sprawl-and-config-axes]]), so
  each has its **own separate** in-memory copy of these models — they are not even shared between
  processes.

Full detail in `context/02-backend-architecture.md` and `context/07-verified-risks.md` H4.
