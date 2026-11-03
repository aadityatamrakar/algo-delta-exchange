---
name: frontend-builder-routes-broken
description: "client_wc router ships 5 states whose controller file is excluded from the gulp bundle, so builder/combo/spreads/ibkr_parity throw in prod; npm run sync targets dead build/"
metadata:
  type: reference
---

## 5 dashboard routes throw in production
`client_wc/js/app.js:60,65,72` register ui-router states for `BuilderController` and
`ComboController`, but `gulpfile.js:30` **comments out** the file that implements them
(`client_wc/js/controllers/builderCtrl.js:326`).

Verified: the router *state names* appear in `build_wc/assets/app.min.js` (they live in `app.js`,
which is bundled); the controller *implementations* do not.

So `builder`, `combo`, `combo_list`, `spreads`, `ibkr_parity` don't fail closed — they load and
throw `$controller:ctrlreg`. And `builderCtrl.js` is **still being edited** (last commit
2026-01-09): active development on features that cannot run.

Dev/prod diverge too: `client_wc/index.html` (dev shell) loads `builderCtrl.js`; the prod shell
`build.html` → `build_wc/index.html` does not.

## The deploy script points at a dead directory
`package.json` `"sync": "aws s3 sync build s3://cdn.algomaker.in"` pushes **`build/`** (dead since
2022-10), not `build_wc/`. Deleting `build/` naively turns a silently-stale CDN sync into a hard
failure or an empty sync to the production CDN.

**But the app's static root is correct:** `server/middleware.json:43-44` serves `$!../build_wc`.
The live dashboard is served directly by the Node process; the S3/CloudFront path is disconnected
from what users actually see.

## Other frontend facts
- Stack: AngularJS 1.x (EOL Jan 2022) + ui-router + angular-resource + AdminLTE + Bootstrap +
  jQuery + generated LoopBack `lb-services.js`. 25 ui-router states, 26 views, 5 bundled controllers.
- Both source (`client_wc`, 142 files) and build output (`build_wc`, 86 files) are **tracked in git**
  and rebuilt/committed by hand.
- `socket.io` server **3.1.2** vs client **4.8.1** — major-version mismatch, wire-incompatible
  without `allowEIO3`; the app reportedly works, so the bundled vendor client likely differs from
  the npm dep. Worth confirming.
- Realtime P&L flows through a socket.io `ChangeStream` (LoopBack token in query params). A separate
  in-browser raw-WebSocket `KiteTicker` exists but is **fully dead** — every call site commented out.
- `common.js:780-891` `diff_strategy_pnl` reconciles manual vs algo-tagged fills sharing a broker
  position — hard-won logic, must be preserved in any rewrite.
- Dead views: `home.html` (`HomeController` exists nowhere), `pricing.html` (no controller).
  `positional` and `performance` work but have nav links commented out.
- `eval(resp)` at `socket.js:25,104` — see [[security-backdoor-and-secrets]].

Full detail in `context/03-frontend-architecture.md`.
