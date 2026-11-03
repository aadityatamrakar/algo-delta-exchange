#!/usr/bin/env python3
"""Emit GOLDEN PARITY FIXTURES: the Python desk's own answers, frozen as JSON.

WHY this exists: `packages/greeks` and (from Task 3) `packages/payoff` are ports
of the pure-Python option desk that lives in a DIFFERENT repo
(`/Users/aaditya/Documents/dev/algo-engine/sensibull-desk`). A port is only worth
anything if it agrees with the original number-for-number, and "agrees" has to
mean a checked-in file, not a memory of having eyeballed it once. So this script
runs the Python originals over a small, deterministic, hard-coded set of inputs
and writes their outputs to `packages/payoff/test/fixtures/parity/*.json`. The TS
tests then replay the same inputs through the TS port and diff.

Run it from the SENSIBULL-DESK repo (that is where `sensibull_tools` and its venv
live); this repo is only the destination:

    cd /Users/aaditya/Documents/dev/algo-engine/sensibull-desk && .venv/bin/python \
      <algomaker>/scripts/gen-parity-fixtures.py \
      --out <algomaker>/packages/payoff/test/fixtures/parity

Nothing here reads a lake, a network, or a clock — every input below is a
literal, so re-running the script on any machine on any day reproduces the
committed files byte for byte, with ONE named exception: `iv_roundtrip`, see
`black76_fixture`.

READ-ONLY with respect to the Python repo: this script imports it, never writes
to it.
"""
from __future__ import annotations

import argparse
import json
import os
from typing import Any, Dict, List, Optional

from sensibull_tools.gfdl import greeks as gk
from sensibull_tools.sim import book as sim_book
from sensibull_tools.sim import margin as sim_margin
from sensibull_tools.sim.optimizer.surface import build_surface

# --------------------------------------------------------------------------
# Black-76 grid
# --------------------------------------------------------------------------

# Three price scales, because the pricer is used on a ~100-rupee stock, a
# ~750-rupee stock and a ~25000-point index in the same session, and scale is
# exactly where a float port drifts.
FUTURES = [100.0, 750.5, 24800.0]
# Strike as a fraction of the future: deep ITM through deep OTM, both wings.
MONEYNESS = [0.85, 0.95, 1.0, 1.05, 1.2]
# Years to expiry: ~0.7 days (expiry session), ~7 days, ~29 days, ~110 days.
TIMES = [0.002, 0.02, 0.08, 0.3]
VOLS = [0.12, 0.25, 0.6]
OPT_TYPES = ["CE", "PE"]
# Pinned as a literal, NOT read from `pricing.RISK_FREE`, and passed EXPLICITLY
# to every engine below rather than left to default. A fixture generated off a
# default is a fixture that silently regenerates to different numbers the day
# somebody edits that default; pinning it means such a change shows up as a real
# parity failure with a name on it. Same value as `pricing.RISK_FREE` today.
RATE = 0.065

# The other engine defaults, likewise pinned and likewise passed explicitly. They
# are recorded into surface.json / margin.json alongside each result so the TS
# ports can be configured from the fixture instead of from eight magic numbers
# rediscovered by reading Python.
SURFACE_KW = {"r": RATE, "band": 0.10, "steps": 10}
MARGIN_KW = {"default_iv": 0.35, "price_scan_pct": 0.21, "vol_scan": 0.25,
             "exposure_pct": 0.05, "min_short_pct": 0.05, "r": RATE}


def _implied_vol_bisect(px: float, F: float, K: float, t: float,
                        opt_type: str) -> Optional[float]:
    """``gk.implied_vol`` with the native backend switched OFF for the call.

    Not a reimplementation — the same function, forced down its pure-Python
    bisection branch by flipping the module's own backend flag, then restored.
    See :func:`black76_fixture` for why both answers are recorded.
    """
    saved = gk.BACKEND
    gk.BACKEND = "python"
    try:
        return gk.implied_vol(px, F, K, t, RATE, opt_type)
    finally:
        gk.BACKEND = saved


def black76_fixture() -> Dict[str, Any]:
    """Price, greeks and TWO implied-vol round-trips per grid point.

    Why two IV columns:

    ``iv_roundtrip`` is whatever ``implied_vol`` answers on the machine that
    generated the file — the Rust ``opengreeks`` root-finder when that wheel is
    importable, which is the number the live Python desk actually sees. It is
    the ONE value in these fixtures that is not machine-independent, so the TS
    test only holds it to null-agreement.

    ``iv_roundtrip_bisect`` is the pure-Python bisection fallback, which is the
    algorithm ``b76ImpliedVol`` is a line-for-line port of, so THAT is what the
    TS test compares values against.

    They disagree on 20 of these 360 points, all deep in a wing, where the
    option is worth either ~intrinsic or ~nothing and vega has collapsed: the
    price is then flat in vol, so bisection's "priced within 1e-6 of the quote"
    exit fires at a vol far from the one that generated the quote. Both answers
    reprice onto the same quote; neither solver is wrong; there is simply no
    well-conditioned root for them to agree on. Recording both is what makes
    that visible instead of looking like a port bug.

    ``None`` is a REAL answer (a deep-ITM near-expiry quote sits on discounted
    intrinsic and has no recoverable vol at all), so it is kept rather than
    filtered out — the TS port has to agree about the nulls too. Both columns
    are null on exactly the same 56 points.

    Returns a WRAPPER object rather than a bare list so that ``backend`` — the
    provenance of the machine-dependent column, i.e. which solver ``iv_roundtrip``
    actually came from — travels with the data instead of living only in a
    commit message.
    """
    out: List[Dict[str, Any]] = []
    for F in FUTURES:
        for m in MONEYNESS:
            K = F * m
            for t in TIMES:
                for sig in VOLS:
                    for opt_type in OPT_TYPES:
                        px = gk.price(opt_type, F, K, t, RATE, sig)
                        out.append({
                            "in": {"opt_type": opt_type, "F": F, "K": K,
                                   "t": t, "r": RATE, "sig": sig},
                            "price": px,
                            "greeks": gk.greeks(opt_type, F, K, t, RATE, sig),
                            "iv_roundtrip": gk.implied_vol(px, F, K, t, RATE, opt_type),
                            "iv_roundtrip_bisect": _implied_vol_bisect(px, F, K, t, opt_type),
                        })
    # "opengreeks" = the Rust wheel was importable on the generating machine and
    # `iv_roundtrip` is its answer; "python" = it was not, and the two IV columns
    # are then identical.
    return {"backend": gk.BACKEND, "cases": out}


# --------------------------------------------------------------------------
# Books — the leg dicts the Python desk actually passes around
# --------------------------------------------------------------------------

EXPIRY = "2026-08-25"
SPOT = 660.0
# Two sessions before expiry, one, and expiry itself: the surface's time decay
# has to land on all three.
DATES = ["2026-08-19", "2026-08-22", "2026-08-25"]
MARGIN_DATE = "2026-08-19"
# P&L already banked, as `expiry_breakevens` takes it: non-zero on purpose, so a
# port that silently drops the argument shifts every crossing and gets caught.
REALIZED = 125000.0


def _opt(side: str, lots: int, strike: float, opt_type: str, entry: float,
         iv: float, leg_id: str) -> Dict[str, Any]:
    return {"instrument": "option", "side": side, "lots": lots, "lot_size": 1000,
            "strike": strike, "opt_type": opt_type, "expiry": EXPIRY,
            "entry": entry, "iv": iv, "id": leg_id}


def _future(side: str, lots: int, entry: float, leg_id: str) -> Dict[str, Any]:
    return {"instrument": "future", "side": side, "lots": lots, "lot_size": 1000,
            "strike": None, "opt_type": None, "expiry": EXPIRY,
            "entry": entry, "iv": None, "id": leg_id}


# (a) the plain short strangle every stock book on this desk starts life as.
STRANGLE = [
    _opt("Sell", 2, 700.0, "CE", 8.4, 0.28, "s_ce_700"),
    _opt("Sell", 2, 620.0, "PE", 6.1, 0.31, "s_pe_620"),
]
# (b) the same book after a repair: a long wing above the tested call and one
# more short put below. Mixed long/short is where margin's hedge benefit and the
# surface's kinked payoff both stop being trivial.
REPAIRED = STRANGLE + [
    _opt("Buy", 1, 730.0, "CE", 2.1, 0.26, "b_ce_730"),
    _opt("Sell", 1, 600.0, "PE", 3.3, 0.33, "s_pe_600"),
]
# (c) a delta hedge on top: futures legs price linearly and carry no vega, so
# they exercise the "not every leg is an option" branch of all three engines.
WITH_FUTURE = STRANGLE + [_future("Buy", 1, 662.0, "b_fut")]

BOOKS = [("strangle", STRANGLE), ("repaired", REPAIRED), ("with-future", WITH_FUTURE)]

# Expiry-payoff probe prices. Hand-picked rather than an even ladder so that
# every KINK (600 / 620 / 700 / 730) is hit exactly, plus a point either side of
# each, plus the degenerate 0.0 and a price far above the highest strike where
# the payoff is on its outer linear arm.
EXPIRY_PRICES = [0.0, 500.0, 590.0, 600.0, 610.0, 620.0, 640.0, 660.0,
                 680.0, 700.0, 710.0, 730.0, 800.0, 1000.0]


def expiry_cases() -> List[Dict[str, Any]]:
    """Expiry payoff probes + breakevens.

    MIND THE ASYMMETRY, because it is a trap and it is not a bug: ``realized``
    reaches ``breakevens`` and does NOT reach ``pnl_at``. `expiry_breakevens`
    takes it and shifts the whole payoff curve by P&L already banked, so the
    crossings answer "where does the RUN break even". `expiry_pnl_at` has no such
    argument at all — every number under ``pnl_at`` is open-legs-only, measured
    against each leg's own entry.

    So a TS port must NOT add ``realized`` into its `expiryPnlAt`, and MUST add
    it in its breakeven solve. Reading these two fields as though they shared a
    baseline is how you end up with breakevens that do not sit on the payoff
    curve you plotted. Concretely, for `strangle`: ``pnl_at["543.0"]`` would be
    -125000, not 0, even though 543.0 is the recorded down breakeven.
    """
    return [{
        "name": name,
        "legs": legs,
        "spot": SPOT,
        "realized": REALIZED,
        # Keys are the price as a plain float string ("660.0"); the TS side reads
        # them back with Number(). Open-legs-only — see the docstring.
        "pnl_at": {str(p): sim_book.expiry_pnl_at(legs, p) for p in EXPIRY_PRICES},
        # Shifted by REALIZED — see the docstring.
        "breakevens": sim_book.expiry_breakevens(legs, SPOT, realized=REALIZED),
    } for name, legs in BOOKS]


def surface_cases() -> List[Dict[str, Any]]:
    return [{
        "name": name,
        "legs": legs,
        "spot": SPOT,
        "dates": DATES,
        # Every knob the surface was built with, recorded next to the answer it
        # produced: the price ladder is spot*(1 ± band*i/steps) for i in 0..steps,
        # so a TS port that guesses a different band or step count builds a
        # different ladder and lands different max_profit/max_loss/breakevens.
        "kwargs": SURFACE_KW,
        "out": build_surface(legs, spot=SPOT, dates=DATES, **SURFACE_KW),
    } for name, legs in BOOKS]


def margin_cases() -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for name, legs in BOOKS:
        # per_leg=False: the per-leg-naked breakdown is a separate feature and is
        # not part of what the TS port promises, so freezing it here would freeze
        # a shape nothing checks.
        res = sim_margin.portfolio_margin(legs, SPOT, MARGIN_DATE,
                                          per_leg=False, **MARGIN_KW)
        out.append({
            "name": name, "legs": legs, "spot": SPOT, "date": MARGIN_DATE,
            # The SPAN-lite scenario grid IS these five numbers: 7 price shocks
            # at ±price_scan_pct x 3 vol multipliers at ±vol_scan, floored at
            # min_short_pct of short notional, plus exposure_pct of (short +
            # futures) notional. Recorded so Tasks 4/5 configure the port from
            # the fixture rather than from eight numbers copied out of Python.
            "kwargs": MARGIN_KW,
            "out": {k: res[k] for k in ("span", "exposure", "total",
                                        "worst_scenario", "short_notional",
                                        "n_short_lots")},
        })
    return out


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Freeze the Python desk's Black-76 / expiry / surface / "
                    "margin answers as JSON parity fixtures.")
    ap.add_argument("--out", required=True, help="destination fixtures directory")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    files: Dict[str, Any] = {
        # black76.json is the one wrapper object (it carries `backend`
        # provenance); the other three are bare lists of records.
        "black76.json": black76_fixture(),
        "expiry.json": expiry_cases(),
        "surface.json": surface_cases(),
        "margin.json": margin_cases(),
    }
    for name, payload in files.items():
        path = os.path.join(args.out, name)
        with open(path, "w") as fh:
            # allow_nan=False: a NaN would serialize as the bare token `NaN`,
            # which is not JSON and which JSON.parse rejects — better to fail
            # here, loudly, than to ship a fixture the TS side cannot read.
            json.dump(payload, fh, indent=2, sort_keys=True, allow_nan=False)
            fh.write("\n")
        cases = payload["cases"] if isinstance(payload, dict) else payload
        print(f"{path}: {len(cases)} cases")


if __name__ == "__main__":
    main()
