# Desk Books Phases 3–4 — Live Driver and Supervisor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run `hold-recycle-r` on the live BHEL August paper book, driving the *same* `sim` primitives the backtest drives, priced off the algomaker bridge instead of the GFDL lake — then supervise it unattended.

**Architecture:** `sim/engine.run_cycle` walks historical dates × checkpoints over a `GfdlStore`. This plan replaces the *loop*, not the engine: a new `sensibull_tools/live/desk/` package supplies a `BridgeStore` that duck-types the six store methods, and a wall-clock driver that marks, decides, throttles, translates to bridge actions, and folds fills back. Everything the loop owned but the playbook does not — the settle at expiry, the session grid, `cum_realized`, the throttle queue — is reimplemented explicitly, because `hold_recycle` never emits a close and would otherwise never end.

**Tech Stack:** Python 3 (`.venv`, `pytest`), `requests` for the bridge client, pm2 under the existing `pm2-ubuntu` systemd unit.

## Global Constraints

- **Run everything through the venv:** `.venv/bin/python`, `.venv/bin/pytest`. Never the system python.
- **Fail-soft is the house contract.** `sim` modules never raise (`engine.py`'s docstring, `decide.py:401`). Match it: a bad mark, a bad response, a bad leg is logged and skipped, never an exception out of the driver.
- **The engine is not modified.** No edits to `sensibull_tools/sim/**` in this plan. If the driver seems to need one, stop — it is a sign the driver is doing engine work.
- **Desk state lives under `data/desk/`, keyed by tag** — never `data/live/`, which is the old `sensibull-live` loop's root and which the §6 double-execution guard reads.
- **`decisionId = <tag>:<mode>:<ISO mark>`.** Mode is in the key; without it a paper and a live worker on one tag collide and swap fills.
- **Prices come from the bridge; greeks are computed locally** (spec D9), Black-76 off the near future, exactly as `GfdlStore.mark` does with `F = future = S`.
- **Never restart `desk-runner`** — it squares off positions on SIGTERM.
- **Depends on phases 0–2** being merged and deployed: tag-keyed books, `/v1/desk/chain`, `?tag=` on trades, the registry and the variant catalogue.
- Commit after every task.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `sensibull_tools/live/desk/__init__.py` | Package marker | **Create** |
| `sensibull_tools/live/desk/bridge.py` | HTTP client for the algomaker API | **Create** |
| `sensibull_tools/live/desk/store.py` | `BridgeStore` — the six-method duck-type | **Create** |
| `sensibull_tools/live/desk/translate.py` | sim decision ⇄ bridge actions; fills → book; realized | **Create** |
| `sensibull_tools/live/desk/session.py` | IST session grid, mark boundaries, expiry day | **Create** |
| `sensibull_tools/live/desk/driver.py` | One book's mark loop, state, recovery, settle | **Create** |
| `sensibull_tools/live/desk/supervisor.py` | Converge `desired` → running workers | **Create** |
| `tests/test_desk_bridge_store.py` | `BridgeStore` conformance | **Create** |
| `tests/test_desk_translate.py` | Vocabulary mapping, fills, realized | **Create** |
| `tests/test_desk_session.py` | Session grid, holidays, expiry | **Create** |
| `tests/test_desk_driver.py` | Gates, settle, recovery, skips | **Create** |
| `ecosystem.config.js` | pm2 apps | **Modify.** Add `desk-supervisor` |

---

### Task 1: The bridge HTTP client

**Files:**
- Create: `sensibull_tools/live/desk/__init__.py`, `sensibull_tools/live/desk/bridge.py`
- Test: `tests/test_desk_bridge_client.py`

**Interfaces:**
- Produces `class Bridge` with:
  - `feed() -> Dict[str, Any]`
  - `positions(tag: str, mode: str) -> Dict[str, Any]`
  - `chain(underlying: str, expiry: str) -> Dict[str, Any]`
  - `trades(tag: str, mode: str, limit: int = 200) -> List[Dict[str, Any]]`
  - `actions(payload: Dict[str, Any]) -> Dict[str, Any]`
  - `declare(tag: str, symbol: str, legs: List[Dict[str, Any]]) -> None`
  - `put_variants(rows: List[Dict[str, Any]]) -> None`
  - `books(mode: str) -> List[Dict[str, Any]]`  *(registry rows)*
  - `set_actual(tag, mode, actual, last_mark_at, last_decision) -> None`

- [ ] **Step 1: Write the failing test**

Create `tests/test_desk_bridge_client.py`:

```python
"""Bridge client: URL shape, auth header, and the fail-soft contract."""
from sensibull_tools.live.desk.bridge import Bridge


class _Resp:
    def __init__(self, status=200, payload=None):
        self.status_code = status
        self._payload = payload if payload is not None else {}

    def json(self):
        return self._payload


def test_positions_asks_by_tag_and_mode():
    calls = []

    def fake_get(url, headers=None, timeout=None, params=None):
        calls.append((url, params, headers))
        return _Resp(200, {"tag": "T", "legs": []})

    b = Bridge("http://x:8790", "tok", get_fn=fake_get)
    out = b.positions("BHEL-2026-08-25-hold-recycle-r", "paper")

    assert out["tag"] == "T"
    url, params, headers = calls[0]
    assert url.endswith("/v1/desk/positions")
    assert params["tag"] == "BHEL-2026-08-25-hold-recycle-r"
    assert params["mode"] == "paper"
    assert headers["Authorization"] == "Bearer tok"


def test_a_failed_call_returns_empty_rather_than_raising():
    def boom(*_a, **_k):
        raise OSError("connection refused")

    b = Bridge("http://x:8790", "tok", get_fn=boom)
    assert b.positions("T", "paper") == {}
    assert b.chain("BHEL", "2026-08-25") == {}
    assert b.trades("T", "paper") == []


def test_a_non_200_is_not_mistaken_for_data():
    b = Bridge("http://x:8790", "tok", get_fn=lambda *a, **k: _Resp(503, {"error": "down"}))
    assert b.positions("T", "paper") == {}
```

**The fail-soft assertions are the point.** A driver that raises on a transient 503 dies mid-session, and pm2 restarts it into a state file it may not have finished writing.

- [ ] **Step 2: Run it to verify it fails**

Run: `.venv/bin/pytest tests/test_desk_bridge_client.py -v`
Expected: FAIL — `ModuleNotFoundError: sensibull_tools.live.desk`.

- [ ] **Step 3: Write the client**

Create `sensibull_tools/live/desk/__init__.py` (empty) and `bridge.py`:

```python
"""HTTP client for the algomaker bridge.

Fail-soft by contract: every read returns an EMPTY value on any failure —
connection, timeout, non-200, unparseable body — and never raises. The driver
treats empty as "no data this mark" and holds, which is the correct response to
not knowing. Raising instead would kill the worker mid-session and hand pm2 a
restart into a half-written state file.

Writes are different and say so: `actions` returns the response dict, and an
empty dict there means the caller must NOT advance its mark — see driver.py's
indeterminate handling.

`get_fn`/`post_fn` are injectable so tests never open a socket.
"""
from __future__ import annotations

import logging
from typing import Any, Callable, Dict, List, Optional

_log = logging.getLogger(__name__)

_TIMEOUT = 10.0


class Bridge:
    def __init__(self, base: str, token: str, *,
                 get_fn: Optional[Callable[..., Any]] = None,
                 post_fn: Optional[Callable[..., Any]] = None,
                 timeout: float = _TIMEOUT) -> None:
        self._base = str(base).rstrip("/")
        self._headers = {"Authorization": f"Bearer {token}"}
        self._timeout = timeout
        if get_fn is None or post_fn is None:
            import requests  # imported lazily so tests need no network stack
            get_fn = get_fn or requests.get
            post_fn = post_fn or requests.post
        self._get = get_fn
        self._post = post_fn

    def _read(self, path: str, params: Optional[Dict[str, Any]], empty: Any) -> Any:
        try:
            r = self._get(f"{self._base}{path}", headers=self._headers,
                          timeout=self._timeout, params=params or {})
            if getattr(r, "status_code", 0) != 200:
                _log.warning("bridge GET %s -> %s", path, getattr(r, "status_code", "?"))
                return empty
            return r.json()
        except Exception as exc:  # noqa: BLE001 - fail-soft contract
            _log.warning("bridge GET %s failed: %r", path, exc)
            return empty

    def feed(self) -> Dict[str, Any]:
        return self._read("/v1/desk/feed", None, {}) or {}

    def positions(self, tag: str, mode: str) -> Dict[str, Any]:
        return self._read("/v1/desk/positions", {"tag": tag, "mode": mode}, {}) or {}

    def chain(self, underlying: str, expiry: str) -> Dict[str, Any]:
        return self._read(f"/v1/desk/chain/{underlying}", {"expiry": expiry}, {}) or {}

    def trades(self, tag: str, mode: str, limit: int = 200) -> List[Dict[str, Any]]:
        out = self._read("/v1/desk/trades", {"tag": tag, "mode": mode, "limit": limit}, {})
        rows = out.get("trades") if isinstance(out, dict) else None
        return list(rows) if isinstance(rows, list) else []

    def books(self, mode: str) -> List[Dict[str, Any]]:
        out = self._read("/v1/desk/books/registry", {"mode": mode}, [])
        return list(out) if isinstance(out, list) else []

    def _write(self, path: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        try:
            r = self._post(f"{self._base}{path}", headers=self._headers,
                           timeout=self._timeout, json=payload)
            if getattr(r, "status_code", 0) != 200:
                _log.warning("bridge POST %s -> %s", path, getattr(r, "status_code", "?"))
                return {}
            return r.json() or {}
        except Exception as exc:  # noqa: BLE001
            _log.warning("bridge POST %s failed: %r", path, exc)
            return {}

    def actions(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        return self._write("/v1/desk/actions", payload)

    def declare(self, tag: str, symbol: str, legs: List[Dict[str, Any]]) -> None:
        self._write("/v1/desk/declare", {"tag": tag, "symbol": symbol, "legs": legs})

    def put_variants(self, rows: List[Dict[str, Any]]) -> None:
        self._write("/v1/desk/variants", {"variants": rows})

    def set_actual(self, tag: str, mode: str, actual: str,
                   last_mark_at: int, last_decision: str) -> None:
        self._write(f"/v1/desk/books/registry/{tag}/actual",
                    {"mode": mode, "actual": actual,
                     "lastMarkAt": last_mark_at, "lastDecision": last_decision})
```

`set_actual` needs a matching route — add `POST /v1/desk/books/registry/:tag/actual` to `apps/api/src/routes/books.ts` (phase 2, Task 5) as part of this task, with a test there too.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `.venv/bin/pytest tests/test_desk_bridge_client.py -v`
Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add sensibull_tools/live/desk/ tests/test_desk_bridge_client.py
git commit -m "feat(live): bridge HTTP client, fail-soft by contract

Every read returns empty on any failure and never raises. A driver that
dies on a transient 503 hands pm2 a restart into a half-written state."
```

---

### Task 2: `BridgeStore` — the six-method duck-type

**Files:**
- Create: `sensibull_tools/live/desk/store.py`
- Test: `tests/test_desk_bridge_store.py`

**Interfaces:**
- Consumes: `Bridge` (Task 1).
- Produces `class BridgeStore` with exactly the surface `mark_book`, `build_chain` and `margin` call:
  - `spot_ref(underlying, date, time)` → the **future** close (matching `GfdlStore.spot_ref` with `spot_source="future"`)
  - `future(underlying, date, time, series="I")` → `{"close", "oi", "volume", "time", "stale_days"}`
  - `raw_future(underlying, date, time, series="I")` → `{"close", "volume", "oi"}`
  - `mark(underlying, date, time, expiry, strike, opt_type)` → `{"close", "iv", "oi", "volume", "stale_days", "delta", "gamma", "theta", "vega"}`
  - `marks(underlying, date, time, expiry, strikes, sides=("CE","PE"))` → `{(strike, side): mark|None}`
  - `raw_chain(underlying, date, time, expiry=None)` → `{"expiry", "strikes": {strike: {side: {"close","volume","oi","d_oi_cp",...}}}}`
  - `refresh(as_of_ms: int) -> bool` — pull one chain snapshot; `False` when unusable
  - `stale_quotes() -> List[str]` — quotes rejected for age this mark

**This is spec §9 test 2, the second most load-bearing test in the project.** The same book through `GfdlStore` and `BridgeStore` must produce an identical `ctx`.

- [ ] **Step 1: Write the failing test**

Create `tests/test_desk_bridge_store.py`:

```python
"""BridgeStore conformance: the shapes sim's primitives actually consume."""
import math

from sensibull_tools.live.desk.store import BridgeStore

DATE, TIME, EXPIRY = "2026-08-03", "10:15", "2026-08-25"
NOW_MS = 1_754_200_500_000   # 2026-08-03 10:15 IST, epoch ms


def _chain_payload(price_asof=NOW_MS):
    return {
        "underlying": "BHEL", "expiry": EXPIRY, "spot": 417.0, "spotAsOf": price_asof,
        "future": 418.2, "futureAsOf": price_asof, "step": 2.5, "lotSize": 2625,
        "feedAlive": True,
        "rows": [
            {"strike": 415.0,
             "CE": {"price": 8.5, "oi": 1200, "volume": 90, "asOf": price_asof, "ageMs": 0},
             "PE": {"price": 6.2, "oi": 900, "volume": 40, "asOf": price_asof, "ageMs": 0}},
            {"strike": 420.0,
             "CE": {"price": 5.9, "oi": 2400, "volume": 150, "asOf": price_asof, "ageMs": 0},
             "PE": None},
        ],
    }


class _FakeBridge:
    def __init__(self, payload):
        self._payload = payload

    def chain(self, underlying, expiry):
        return self._payload


def _store(payload=None, now_ms=NOW_MS):
    s = BridgeStore(_FakeBridge(payload or _chain_payload()), "BHEL", EXPIRY)
    s.refresh(now_ms)
    return s


def test_spot_ref_returns_the_future_not_cash():
    # GfdlStore.spot_ref with spot_source="future" returns future["close"], and
    # mark() inverts IV with F = future = S. Returning cash spot here would price
    # every option off a different forward than the backtest did.
    assert _store().spot_ref("BHEL", DATE, TIME) == 418.2


def test_mark_returns_the_gfdl_field_set_with_locally_computed_greeks():
    m = _store().mark("BHEL", DATE, TIME, EXPIRY, 415.0, "CE")
    assert set(m) >= {"close", "iv", "oi", "volume", "stale_days",
                      "delta", "gamma", "theta", "vega"}
    assert m["close"] == 8.5
    assert m["oi"] == 1200
    assert 0.0 < m["iv"] < 5.0
    assert 0.0 < m["delta"] < 1.0          # an ITM call off F=418.2, K=415
    assert m["stale_days"] == 0


def test_an_unticked_strike_marks_none_rather_than_zero():
    assert _store().mark("BHEL", DATE, TIME, EXPIRY, 420.0, "PE") is None


def test_marks_returns_the_ladder_keyed_by_strike_and_side():
    out = _store().marks("BHEL", DATE, TIME, EXPIRY, [415.0, 420.0])
    assert out[(415.0, "CE")]["close"] == 8.5
    assert out[(420.0, "PE")] is None


def test_raw_chain_has_no_d_oi_on_the_first_mark_and_a_real_one_on_the_second():
    s = _store()
    first = s.raw_chain("BHEL", DATE, TIME, EXPIRY)
    assert first["strikes"][415.0]["CE"]["d_oi_cp"] is None

    s._bridge._payload["rows"][0]["CE"]["oi"] = 1500      # OI moved
    s.refresh(NOW_MS + 300_000)
    second = s.raw_chain("BHEL", DATE, "10:20", EXPIRY)
    assert second["strikes"][415.0]["CE"]["d_oi_cp"] == 300


def test_refresh_rejects_quotes_that_are_not_from_today():
    stale = _chain_payload(price_asof=NOW_MS - 20 * 3600 * 1000)   # yesterday
    s = BridgeStore(_FakeBridge(stale), "BHEL", EXPIRY)
    assert s.refresh(NOW_MS) is False
    assert s.mark("BHEL", DATE, TIME, EXPIRY, 415.0, "CE") is None


def test_refresh_rejects_a_dead_feed():
    payload = _chain_payload()
    payload["feedAlive"] = False
    s = BridgeStore(_FakeBridge(payload), "BHEL", EXPIRY)
    assert s.refresh(NOW_MS) is False
```

- [ ] **Step 2: Run it to verify it fails**

Run: `.venv/bin/pytest tests/test_desk_bridge_store.py -v`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `BridgeStore`**

Create `sensibull_tools/live/desk/store.py`. Key requirements, each of which a test above pins:

- IV and greeks come from `sensibull_tools.pricing` / the same `_gk` module `GfdlStore.mark` uses — **read `sensibull_tools/gfdl/store.py:174-197` and call the identical functions with the identical arguments** (`implied_vol(px, S, K, t, r, opt_type)` where `S` is the future, then `greeks(opt_type, S, K, t, r, iv)`). Copy the fallback too: `iv` falsy → zeroed greeks.
- `t` is `year_frac(date, expiry)` from `sensibull_tools.pricing`, the same call.
- `stale_days` is always `0` live — there is no prior-session backfill.
- `refresh(as_of_ms)` stores the new snapshot as `current` and the previous one as `prev`, so `raw_chain` can serve `d_oi_cp`. Returns `False` when `feedAlive` is false, when the payload is empty, or when **every** quote's `asOf` is older than the start of today IST — and in that case `current` is left unset so every `mark` returns `None`.
- Per-quote age: reject an individual quote whose `asOf` is before today's session start; record its name in `stale_quotes()`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `.venv/bin/pytest tests/test_desk_bridge_store.py -v`
Expected: 7 passing.

- [ ] **Step 5: Prove ctx conformance against the real engine**

Add `tests/test_desk_bridge_store_ctx.py`: build a two-leg book, mark it through `mark_book(book, BridgeStore(...), "BHEL", DATE, TIME)`, and assert the returned dict has the keys `sim/engine.py:266-272` reads — `spot`, `dte`, `legs`, `net`, `mtm`, `net_tv`, `breakevens` — with `net["delta"]` finite and non-zero.

```python
def test_mark_book_over_bridge_store_produces_a_usable_ctx():
    from sensibull_tools.sim.book import mark_book
    book = [{"id": 1, "instrument": "option", "opt_type": "CE", "strike": 415.0,
             "expiry": EXPIRY, "side": "Sell", "lots": 5, "lot_size": 2625,
             "entry": 9.0}]
    mb = mark_book(book, _store(), "BHEL", DATE, TIME)
    assert set(mb) >= {"spot", "dte", "legs", "net", "mtm", "net_tv", "breakevens"}
    assert mb["net"]["delta"] != 0.0
    assert mb["legs"][0]["ltp"] == 8.5
```

Match the real book-leg field names by reading `sensibull_tools/sim/book.py:240-315` and `sim/optimizer/legs.py` — do not guess `lots`/`lot_size`/`entry`.

- [ ] **Step 6: Commit**

```bash
git add sensibull_tools/live/desk/store.py tests/test_desk_bridge_store*.py
git commit -m "feat(live): BridgeStore duck-types GfdlStore over the bridge

Greeks computed locally, Black-76 off the future, with the identical
calls GfdlStore.mark makes — one marking implementation, so live ctx and
backtest ctx agree. Quotes not from today are refused."
```

---

### Task 3: Translation and realized accounting

**Files:**
- Create: `sensibull_tools/live/desk/translate.py`
- Test: `tests/test_desk_translate.py`

**Interfaces:**
- Produces:
  - `to_actions(decision: Dict, book: List[Dict]) -> List[Dict]`
  - `apply_fills(book: List[Dict], fills: List[Dict], lot_size: int) -> Tuple[List[Dict], float]` → `(new_book, realized_delta)`
  - `blocked_tags(response: Dict) -> Set[str]` — union of `skips` and `routeErrors`
  - `reconcile(book: List[Dict], trades: List[Dict]) -> Tuple[List[Dict], float]` → corrected book and a **realized restatement**

**The mapping** (spec §4.1):

| sim | bridge |
|---|---|
| `open_legs[]` | `open`, `ts` = the leg's own id |
| `close_ids[]` | `close` |
| `close_parts[] {id, lots}` | `resize`, **absolute** remaining qty |
| — | `roll` unused — `hold-recycle` never rolls |

- [ ] **Step 1: Write the failing test**

Create `tests/test_desk_translate.py`:

```python
from sensibull_tools.live.desk.translate import (
    to_actions, apply_fills, blocked_tags, reconcile,
)

LOT = 2625


def _book():
    return [
        {"id": 1, "instrument": "option", "opt_type": "CE", "strike": 420.0,
         "side": "Sell", "lots": 5, "lot_size": LOT, "entry": 15.0, "expiry": "2026-08-25"},
        {"id": 2, "instrument": "option", "opt_type": "PE", "strike": 415.0,
         "side": "Sell", "lots": 5, "lot_size": LOT, "entry": 14.0, "expiry": "2026-08-25"},
    ]


def test_open_legs_become_open_actions_with_contract_quantity():
    dec = {"action": "adjust", "open_legs": [
        {"id": 3, "opt_type": "CE", "strike": 425.0, "side": "Sell", "lots": 2, "lot_size": LOT}
    ], "close_ids": [], "close_parts": []}
    acts = to_actions(dec, _book())
    assert acts == [{"op": "open", "ts": "3", "strike": 425.0, "type": "CE",
                     "side": "Sell", "qty": 2 * LOT}]


def test_close_parts_become_an_absolute_resize_not_a_delta():
    # contract.ts:79 — qty is the ABSOLUTE new quantity. Sending the decrement
    # would resize a 5-lot leg to 2 lots when 3 were meant to close.
    dec = {"action": "adjust", "open_legs": [], "close_ids": [],
           "close_parts": [{"id": 1, "lots": 3}]}
    acts = to_actions(dec, _book())
    assert acts == [{"op": "resize", "ts": "1", "qty": 2 * LOT}]


def test_close_ids_become_close_actions():
    dec = {"action": "adjust", "open_legs": [], "close_ids": [2], "close_parts": []}
    assert to_actions(dec, _book()) == [{"op": "close", "ts": "2"}]


def test_a_hold_translates_to_no_actions():
    assert to_actions({"action": "hold"}, _book()) == []


def test_blocked_tags_unions_skips_and_route_errors():
    resp = {"skips": [{"action": {"ts": "3"}, "reason": "no mark"}],
            "routeErrors": [{"fill": {"deskTag": "4"}, "error": "not in live allowlist"}]}
    assert blocked_tags(resp) == {"3", "4"}


def test_a_close_fill_books_realized_with_sims_sign_convention():
    # short entry 15.0, bought back at 11.0 -> +4.0 per share on 5 lots
    book, realized = apply_fills(
        _book(),
        [{"op": "close", "deskTag": "1", "side": "Buy", "qty": 5 * LOT, "price": 11.0}],
        LOT,
    )
    assert realized == 4.0 * 5 * LOT
    assert [leg["id"] for leg in book] == [2]


def test_an_open_fill_books_at_the_bridge_price_not_our_own():
    book, realized = apply_fills(
        _book(),
        [{"op": "open", "deskTag": "3", "side": "Sell", "qty": 2 * LOT, "price": 6.4,
          "strike": 425.0, "type": "CE"}],
        LOT,
    )
    assert realized == 0.0
    opened = [leg for leg in book if leg["id"] == 3][0]
    assert opened["entry"] == 6.4


def test_reconcile_corrects_an_entry_price_and_restates_realized_on_a_close():
    book = _book()
    book[0]["entry"] = 15.0
    # the broker actually filled the OPEN of leg 1 at 15.4, not 15.0
    corrected, restated = reconcile(book, [
        {"desk_tag": "1", "desk_op": "open", "price": 15.4, "filled_quantity": 5 * LOT}
    ])
    assert [leg for leg in corrected if leg["id"] == 1][0]["entry"] == 15.4
    assert restated == 0.0


def test_reconcile_unbooks_a_rejected_fill():
    corrected, _ = reconcile(_book(), [
        {"desk_tag": "1", "desk_op": "open", "status": "REJECTED"}
    ])
    assert [leg["id"] for leg in corrected] == [2]
```

- [ ] **Step 2: Run it to verify it fails**

Run: `.venv/bin/pytest tests/test_desk_translate.py -v`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `translate.py`. Non-obvious requirements the tests pin:

- `to_actions` returns `[]` for `action == "hold"` and for a decision with all three lists empty.
- `resize` qty is `(current_lots - closing_lots) * lot_size` — **absolute**, per `contract.ts:79`.
- `apply_fills` books the **bridge's** price into `entry`, never a locally computed mark.
- Realized uses sim's convention, `sign * (exit - entry) * shares`, where `sign` is `+1` for a short being closed and `-1` for a long. Read `sensibull_tools/sim/execute.py:112-180` and match it exactly rather than re-deriving.
- `reconcile` handles three outcomes (spec §4.2): price differs → correct `entry` and restate realized if the fill was a close; `REJECTED`/`PARTIAL` → un-book or resize; no row → return unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `.venv/bin/pytest tests/test_desk_translate.py -v`
Expected: 9 passing.

- [ ] **Step 5: Commit**

```bash
git add sensibull_tools/live/desk/translate.py tests/test_desk_translate.py
git commit -m "feat(live): translate sim decisions to bridge actions

close_parts map to an ABSOLUTE resize, not a delta. Fills book at the
bridge's price. routeErrors count as blocked exactly like skips."
```

---

### Task 4: The session grid

**Files:**
- Create: `sensibull_tools/live/desk/session.py`
- Test: `tests/test_desk_session.py`

**Interfaces:**
- Produces:
  - `is_session(now_ist: datetime) -> bool` — 09:15–15:30 on a trading day
  - `mark_time(now_ist: datetime) -> str` — the `"HH:MM"` checkpoint this instant belongs to
  - `marks_between(last_iso: str, now_ist: datetime) -> List[str]` — every missed boundary, for recovery
  - `is_final_mark(now_ist: datetime, expiry: str) -> bool` — the settle trigger
  - `session_start_ms(now_ist: datetime) -> int`

**Why 5-minute marks:** it is the sim checkpoint grid (`sim/config.py:35`, 09:15–15:30), so live decisions and the research corpus are directly comparable.

- [ ] **Step 1: Write the failing test**

Create `tests/test_desk_session.py`:

```python
from datetime import datetime

from sensibull_tools.universe import IST
from sensibull_tools.live.desk.session import (
    is_session, mark_time, marks_between, is_final_mark,
)

EXPIRY = "2026-08-25"


def _ist(y, m, d, hh, mm):
    return datetime(y, m, d, hh, mm, tzinfo=IST)


def test_before_the_open_is_not_a_session():
    assert is_session(_ist(2026, 8, 3, 9, 10)) is False


def test_after_the_close_is_not_a_session():
    assert is_session(_ist(2026, 8, 3, 15, 35)) is False


def test_a_weekend_is_not_a_session():
    assert is_session(_ist(2026, 8, 1, 11, 0)) is False     # Saturday


def test_a_mark_floors_to_its_five_minute_boundary():
    assert mark_time(_ist(2026, 8, 3, 10, 17)) == "10:15"
    assert mark_time(_ist(2026, 8, 3, 10, 20)) == "10:20"


def test_marks_between_lists_every_boundary_missed_by_a_crash():
    missed = marks_between("2026-08-03T10:15", _ist(2026, 8, 3, 10, 31))
    assert missed == ["10:20", "10:25", "10:30"]


def test_the_last_mark_of_expiry_day_is_the_settle():
    assert is_final_mark(_ist(2026, 8, 25, 15, 30), EXPIRY) is True
    assert is_final_mark(_ist(2026, 8, 25, 15, 25), EXPIRY) is False
    assert is_final_mark(_ist(2026, 8, 24, 15, 30), EXPIRY) is False
```

- [ ] **Step 2: Run it to verify it fails**

Run: `.venv/bin/pytest tests/test_desk_session.py -v`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `session.py`, reusing `sensibull_tools.universe`'s `IST` and `is_trading_day` — **do not write a new holiday calendar**; read `sensibull_tools/universe.py` and use what is there.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `.venv/bin/pytest tests/test_desk_session.py -v`
Expected: 6 passing.

- [ ] **Step 5: Commit**

```bash
git add sensibull_tools/live/desk/session.py tests/test_desk_session.py
git commit -m "feat(live): IST session grid matching the sim checkpoints

Weekends and holidays are handled here, not left to the bridge's 120s
dead-feed window."
```

---

### Task 5: The driver

**Files:**
- Create: `sensibull_tools/live/desk/driver.py`
- Test: `tests/test_desk_driver.py`

**Interfaces:**
- Consumes: `Bridge`, `BridgeStore`, `translate`, `session`, plus `sensibull_tools.live.store` for persistence and `sim.variants.build_decider`, `sim.book.mark_book`, `sim.chain.build_chain`, `sim.throttle`, `sim.margin.portfolio_margin`.
- Produces `class BookDriver` with `tick(now_ist) -> Dict[str, Any]` and `recover(now_ist) -> None`.

**The state file** (spec §4.6), under `data/desk/<tag>.state.json`: `book` · `rule_state` · `throttle_state` · `cum_realized` · `prev_cp` · `last_decision_id` · `last_mark`.

- [ ] **Step 1: Write the failing test**

Create `tests/test_desk_driver.py` with fakes for `Bridge` and a real `BridgeStore` over a canned chain:

```python
def test_a_dead_feed_produces_no_decision():
    d = _driver(feed={"alive": False})
    out = d.tick(_ist(2026, 8, 3, 10, 15))
    assert out["decided"] is False
    assert "feed" in out["reason"]


def test_an_incomplete_book_produces_no_decision():
    d = _driver(positions={"complete": False, "legs": []})
    assert d.tick(_ist(2026, 8, 3, 10, 15))["decided"] is False


def test_a_stale_book_produces_no_decision():
    # complete:true with stale:true is the 09:15 gap-open trap — both of the
    # spec's original gates passed and the bridge filled at yesterday's premium.
    d = _driver(positions={"complete": True, "stale": True, "legs": []})
    assert d.tick(_ist(2026, 8, 3, 10, 15))["decided"] is False


def test_outside_the_session_there_is_no_mark_at_all():
    d = _driver()
    assert d.tick(_ist(2026, 8, 3, 8, 0))["decided"] is False


def test_the_decision_id_carries_tag_mode_and_mark():
    d = _driver()
    d.tick(_ist(2026, 8, 3, 10, 15))
    assert d.sent[-1]["decisionId"] == "BHEL-2026-08-25-hold-recycle-r:paper:2026-08-03T10:15"


def test_an_indeterminate_routing_response_does_not_advance_the_mark():
    d = _driver(actions_response={"status": "ROUTING", "fills": [], "skips": []})
    before = d.state.get("last_mark")
    d.tick(_ist(2026, 8, 3, 10, 15))
    assert d.state.get("last_mark") == before


def test_recovery_reposts_every_missed_mark_before_resuming():
    d = _driver()
    d.state["last_mark"] = "2026-08-03T10:15"
    d.recover(_ist(2026, 8, 3, 10, 31))
    assert [s["decisionId"].rsplit(":", 1)[1] for s in d.sent] == ["10:20", "10:25", "10:30"]


def test_the_settle_closes_every_leg_and_bypasses_the_throttle():
    d = _driver(book=[{"id": 1, ...}, {"id": 2, ...}])   # fill in from the helper
    out = d.tick(_ist(2026, 8, 25, 15, 30))
    ops = [a["op"] for a in d.sent[-1]["actions"]]
    assert ops == ["close", "close"]
    assert out["settled"] is True


def test_a_skipped_open_does_not_advance_the_corridor_anchor():
    d = _driver(actions_response={"status": "DONE", "fills": [],
                                  "skips": [{"action": {"ts": "3"}, "reason": "no mark"}]})
    anchor_before = d.state["rule_state"].get("hr_anchor")
    d.tick(_ist(2026, 8, 3, 10, 15))
    assert d.state["rule_state"].get("hr_anchor") == anchor_before
```

Write the `_driver` helper in the same file, injecting fakes — no network, no disk outside `tmp_path`.

- [ ] **Step 2: Run it to verify it fails**

Run: `.venv/bin/pytest tests/test_desk_driver.py -v`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the tick**

`driver.py`'s `tick` follows spec §4 exactly, in order:

0. `session.is_session(now)` → else return `{"decided": False, "reason": "outside session"}`
1. `bridge.feed()` not alive → hold
2. `reconcile` the previous mark against `bridge.trades(tag, mode)`; fold the realized restatement into `cum_realized`
3. `bridge.positions(tag, mode)`; `complete is False` or `stale is True` → hold
4. `store.refresh(now_ms)` → `False` → hold
5. `mark_book(book, store, symbol, date, time)`; `build_chain(store, symbol, date, time, expiry=expiry, prev_cp_time=prev_cp)`
6. build `ctx` with **exactly** the keys `sim/engine.py:266-272` uses; `table` is `{"spot": spot, "expiry": expiry, "rows": [], "picks": [], "warnings": []}`
7. `decider.decide(ctx)`
8. `throttle.submit(throttle_state, dec, book, budget)` — **except** on the settle mark, where the decision is `_close_all_decision(book)`-shaped and the throttle is bypassed outright
9. `translate.to_actions` → `bridge.actions(payload)` with `decisionId = f"{tag}:{mode}:{date}T{cp}"`
10. `status == "ROUTING"` or empty response → **return without saving state or advancing the mark**
11. `apply_fills`; fold `blocked_tags` into state; save state, ledger and mark rows
12. `bridge.declare(tag, symbol, legs)`

`recover(now_ist)` walks `session.marks_between(state["last_mark"], now)` and re-POSTs each id, folding the returned fills and **discarding** any fresh decision for those marks.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `.venv/bin/pytest tests/test_desk_driver.py -v`
Expected: 9 passing.

- [ ] **Step 5: Run the whole Python suite**

Run: `.venv/bin/pytest tests/ -q`
Expected: no regressions. The existing ~150 test files must stay green — this plan adds a package and modifies no engine code.

- [ ] **Step 6: Commit**

```bash
git add sensibull_tools/live/desk/driver.py tests/test_desk_driver.py
git commit -m "feat(live): the book driver — session gates, settle, recovery

Replaces run_cycle's loop, including what the loop owned and the playbook
does not: the expiry settle, cum_realized, and the throttle queue.
ROUTING never advances the mark."
```

---

### Task 6: Parity harness

**Files:**
- Create: `tests/test_desk_parity.py`, `sensibull_tools/live/desk/record.py`
- Test: itself

**Interfaces:** `record.py` provides `replay_store(path) -> BridgeStore`-compatible object over recorded chain snapshots.

**This is spec §9 test 1 — the test that makes D1 true or false.** If a replay through the driver does not reproduce `run_cycle`'s decisions on the same marks, the live desk is not the desk that was researched.

- [ ] **Step 1: Record a day**

Add a `--record <dir>` flag to the driver that writes each mark's raw chain payload to `<dir>/<date>/<cp>.json`. Run it for one full session against the live bridge.

- [ ] **Step 2: Write the parity test**

```python
def test_the_driver_reproduces_run_cycle_decisions_over_the_same_marks(tmp_path):
    """Same book, same marks, same variant -> same decisions.

    Not a mock test: both sides run the real RuleEngine. Only the store differs.
    """
    recorded = replay_store("tests/fixtures/desk-replay/BHEL-2026-08-03")
    driver_decisions = _run_driver_over(recorded)
    cycle_decisions = _run_cycle_over(recorded)
    assert [d["action"] for d in driver_decisions] == [d["action"] for d in cycle_decisions]
    assert [d["reason"] for d in driver_decisions] == [d["reason"] for d in cycle_decisions]
```

Determinism requirements, all of which must hold or the test flaps: the replay store returns byte-identical payloads per `(date, cp)`; no wall-clock call inside the compared path (pass `now` in); `build_decider` is called with the identical variant config on both sides.

- [ ] **Step 3: Run it**

Run: `.venv/bin/pytest tests/test_desk_parity.py -v`
Expected: PASS. **A failure here is a real finding, not a broken test** — investigate the divergence before touching the assertion.

- [ ] **Step 4: Commit**

```bash
git add tests/test_desk_parity.py tests/fixtures/desk-replay sensibull_tools/live/desk/record.py
git commit -m "test(live): parity harness — driver decisions match run_cycle

The test that makes D1 true or false. A failure is a finding."
```

---

### Task 7: The supervisor

**Files:**
- Create: `sensibull_tools/live/desk/supervisor.py`
- Modify: `ecosystem.config.js`
- Test: `tests/test_desk_supervisor.py`

**Interfaces:** `class Supervisor` with `converge(now_ist) -> Dict[str, int]`, `publish_catalogue() -> None`.

- [ ] **Step 1: Write the failing test**

```python
def test_converge_starts_books_the_registry_wants_running():
    s = _supervisor(rows=[{"tag": "T1", "mode": "paper", "desired": "running", ...}])
    s.converge(_ist(2026, 8, 3, 10, 15))
    assert "T1:paper" in s.workers


def test_converge_stops_a_book_switched_off():
    s = _supervisor(rows=[{"tag": "T1", "mode": "paper", "desired": "stopped", ...}])
    s.workers["T1:paper"] = object()
    s.converge(_ist(2026, 8, 3, 10, 15))
    assert "T1:paper" not in s.workers


def test_it_refuses_a_book_the_old_live_loop_already_manages(tmp_path):
    # Same failure as running xtsOrder.js beside the gateway: two loops on one
    # book double every action.
    (tmp_path / "BHEL").mkdir(parents=True)
    (tmp_path / "BHEL" / "hold-recycle-r.state.json").write_text("{}")
    s = _supervisor(rows=[{"tag": "BHEL-2026-08-25-hold-recycle-r", "symbol": "BHEL",
                           "variant": "hold-recycle-r", "mode": "paper", "desired": "running"}],
                    legacy_dir=tmp_path)
    s.converge(_ist(2026, 8, 3, 10, 15))
    assert s.workers == {}
    assert "already managed" in s.refusals[0]


def test_its_own_state_root_does_not_trip_the_guard(tmp_path):
    # The guard reads the OLD loop's data/live root. Reading its own would make
    # it refuse every book it manages on the first restart.
    desk = tmp_path / "desk"
    (desk / "BHEL").mkdir(parents=True)
    (desk / "BHEL" / "hold-recycle-r.state.json").write_text("{}")
    s = _supervisor(rows=[...], legacy_dir=tmp_path / "live", state_dir=desk)
    s.converge(_ist(2026, 8, 3, 10, 15))
    assert s.workers != {}


def test_the_published_catalogue_is_rule_engine_only():
    s = _supervisor()
    s.publish_catalogue()
    keys = {v["key"] for v in s.bridge.published}
    assert "hold-recycle-r" in keys
    assert "delta2" not in keys        # hybrid: shells out to the claude CLI
```

- [ ] **Step 2: Run it to verify it fails**

Run: `.venv/bin/pytest tests/test_desk_supervisor.py -v`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`publish_catalogue` reads `sim.variants.BUILTIN` (and `list_variants()`), keeps only `decider == "rule-engine"`, and posts `{key, decider, playbook, defaults: {target_pnl, margin_cap}}` from each config's `default_target_pnl`/`default_margin_cap`. `converge` diffs registry `desired` against `self.workers`, honours the legacy-dir refusal, and reports `actual` back with `bridge.set_actual`.

- [ ] **Step 4: Add the pm2 app**

In `ecosystem.config.js`, beside `sensibull-live`:

```js
    {
      name: "desk-supervisor",
      script: path.join(__dirname, "scripts/desk-supervisor.sh"),
      autorestart: true,
      // A DAEMON, not a cron_restart one-shot like sensibull-live: it holds
      // per-book engine state in memory between marks and converges the
      // registry continuously.
      env: { SENSIBULL_DESK_STATE_DIR: path.join(__dirname, "data/desk") },
    },
```

Write `scripts/desk-supervisor.sh` following `scripts/live-tick.sh`'s venv guard and `.env` loading.

- [ ] **Step 5: Run the suite**

Run: `.venv/bin/pytest tests/ -q`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add sensibull_tools/live/desk/supervisor.py scripts/desk-supervisor.sh ecosystem.config.js tests/test_desk_supervisor.py
git commit -m "feat(live): supervisor converging the registry to workers

Refuses a book the old sensibull-live loop already manages — two loops
on one book double every action. Publishes the rule-engine catalogue."
```

---

## Phase exit condition

```bash
.venv/bin/pytest tests/ -q
.venv/bin/python -m sensibull_tools.live.desk.driver --tag BHEL-2026-08-25-hold-recycle-r --once
pm2 start ecosystem.config.js --only desk-supervisor && pm2 logs desk-supervisor --lines 40
```

Expected: suite green; the single tick prints a decision with a `hold-recycle:` reason and either zero actions (inside the corridor — the expected steady state) or one merged sell; the supervisor logs the book as running and reports `actual` back to the registry.

Phase 4 is done when the supervisor survives `pm2 restart desk-supervisor` mid-session and the driver resumes from its state file without re-POSTing a mark it already completed.

## Self-review

**Spec coverage:** implements §3.2 (all five modules), §3.2.1 (six methods, ΔOI memoization), §4 (the eleven-step mark), §4.1 (translation), §4.2 (three-sided reconcile), §4.3 (routeErrors), §4.4 (session + freshness), §4.5 (settle), §4.6 (state inventory + realized), §6 (recovery, ROUTING, the guard), and spec §9 tests 1–6 and 11–17.

**Not covered here, by design:** §7.3's live cutover procedure and §7.5's pre-expiry flatten dial. Both are live-rail operations; the dial is specified as shipping **off**, and this phase runs paper only.

**Type consistency:** `blocked_tags` returns a `Set[str]` of desk tags, and desk tags are Python leg ids **stringified** — `to_actions` emits `"3"`, and `apply_fills` matches `fill["deskTag"]` against `str(leg["id"])`. Getting this wrong silently matches nothing, so Task 3's tests assert the string form explicitly.

**Riskiest task:** Task 6. The parity harness depends on a recorded session, so it cannot be written before Task 5 runs live once. If parity fails, the likely culprits in order are: the forward (cash vs future), `year_frac` day-count, and ΔOI being `None` on the first mark after a restart where the backtest had a real previous checkpoint.
