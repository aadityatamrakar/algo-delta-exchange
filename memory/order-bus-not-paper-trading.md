---
name: order-bus-not-paper-trading
description: "PaperTrade is the ORDER BUS, not paper trading — xtsOrder/sparkOrder/fyersOrder forward bus orders to real brokers; sim-vs-live depends on which daemons run"
metadata:
  type: reference
---

**The most misleading name in the codebase.** `PaperTrade` is not paper trading — it is the
**order bus**. A strategy does not place an order; it *emits an order intent* by inserting a
document into the MongoDB `paper-trade` collection:

- `PaperTrade.trackOrder_v2(inst, side, tag, lots)` → `common/models/paper-trade.js:43`, `order_type: MARKET`, deliberately **no `average_price`** (`:53` commented out)
- `PaperTrade.trackOrder_slm(inst, side, tag, mult, stopPrice)` → `:25`, `order_type: 'StopMarket'`
- `PaperTrade.trackOrder_limit(...)` → `:6`, `order_type: 'Limit'`

Independent **consumer daemons** each open a change stream on that collection and decide what
the order means:

| Consumer | File | Effect |
|---|---|---|
| Simulator | `server/boot/paperstream.js` | stamps `average_price` from its tick cache; no broker |
| XTS/Jainam | `server/tools/xtsOrder.js:306-309` | **real orders**; `StopMarket` → XTS `StopLimit` ±1% limit (`:150-158`) |
| Spark | `server/tools/sparkOrder.js:62-67` | **real orders**; `StopMarket` → `SL` |
| Fyers | `server/tools/fyersOrder.js` | **real orders** |

**Why this matters:** whether an order is simulated or real is decided by **which daemons are
running**, not by the strategy code. You cannot tell from reading a strategy file whether it
trades real money.

## `placeAllAccount` is DUAL-RAIL — verified 2026-07-25

`Account.placeAllAccount` does **not** mean "Zerodha instead of the bus". It does **both**
(`common/models/account.js:148-152`):

```js
return new Promise((resolve, reject) => {
  trackOrder(optionInstrument, orderType, strategyTag, multiplier);  // → PaperTrade insert = BUS
  async.map(running_accounts, ...                                     // → Zerodha, direct
```

`trackOrder` (`account.js:112-127`) inserts into `paper-trade`, and `xtsOrder.js:311` forwards
**every** tagged insert to XTS accounts holding that tag. So ONE strategy decision can fill on
Zerodha **and** XTS/Spark/Fyers. Whether that multiplies live size depends on which accounts are
configured under the tag — not determinable from the repo.

**How to apply:**
- Never claim a strategy is "paper" because it uses `PaperTrade`. Say **bus-routed**.
- Never treat `placeAllAccount` vs `PaperTrade` as an either/or classification — `placeAllAccount`
  is a superset. The grep counts (63 vs 123) measure *which entry point*, not exposure.
- In the rewrite, `rail` must be a **set of destinations**, not a single enum. Modelling it as one
  mutually-exclusive mode silently halves live size for these ~35 files.
- A rewrite must make this explicit: an `OrderIntent` type with a **required `mode: 'sim' | 'live'`**.
- Open risk: some strategies enter via `placeAllAccount` (Zerodha) but stop via `trackOrder_slm`
  (bus → XTS/Spark) — possible broker-rail mismatch. See [[strategy-sprawl-and-config-axes]] and
  `context/07-verified-risks.md` H3.

Supersedes the narrower framing in [[paper-options-fill-flow]], which describes only the
*simulator* consumer and is otherwise still accurate.
