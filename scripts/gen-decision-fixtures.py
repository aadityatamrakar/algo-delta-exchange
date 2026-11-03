#!/usr/bin/env python3
"""Emit DECISION PARITY FIXTURES: what the Python recenter playbooks decide.

WHY this exists: `packages/desk-engine` is a TypeScript port of the recenter
family of rule playbooks, which live in a DIFFERENT repo
(`~/Documents/dev/algo-engine/sensibull-desk`, `sensibull_tools/sim/rules/
playbooks.py`). Those twelve presets are what actually manages live short-
premium books, so the port is only worth anything if it answers every mark the
same way the original does — and "the same way" has to mean a checked-in file,
not a memory of having eyeballed it once. So this script runs the Python
originals over a small, deterministic, hard-coded grid and writes their
decisions to `packages/desk-engine/test/fixtures/decisions/<key>.json`. The TS
tests replay the recorded `ctx` through the TS port and diff the decision.

Run it from the SENSIBULL-DESK repo (that is where `sensibull_tools`, its tests
and its venv live); this repo is only the destination:

    cd ~/Documents/dev/algo-engine/sensibull-desk && .venv/bin/python \
      <algomaker>/scripts/gen-decision-fixtures.py

The output directory defaults to this script's own repo, resolved from
``__file__``, so the invocation above needs no arguments; ``--out`` overrides it.

READ-ONLY with respect to the Python repo: this script imports it, never writes
to it.

DETERMINISM. Nothing here reads a lake, a network, a clock or a random source.
Every input is a literal or a pure function of one: the mark TIMES are literals,
`ctx["date"]` is the literal the test builder hard-codes, and the synthetic
chain/book come from the Python test-suite builders (`_ctx`, `_chain_rows`,
`_sold_book` in `tests/test_sim_hold_recycle.py`) which are themselves pure. Two
runs on any machine on any day produce byte-identical files.

WHAT A FIXTURE IS. One file per playbook key; the file is a bare JSON array of
SEQUENCES, and a sequence is six consecutive 5-minute marks with the rule's own
``ctx["state"]`` threaded from each mark into the next:

    [ { "seed": {...}, "marks": [ {"ctx", "decision", "state_after"} x 6 ] } ]

The seed carries the playbook key AND its dial dict, so each sequence is a
self-contained replay unit: the TS side needs no table of Python defaults.

THE LEGS ARE THE SOURCE OF TRUTH. `marked_book.net.delta` and `.gamma` are the
SUM of the legs' own deltas and gammas on every mark, never independent inputs —
see the DELTA_LO/HI block for how the book is built to make that so, and why a
fixture where the declared aggregate and the legs disagree silently verifies a
different port depending on which of the two it happens to read.

THE MARKET IS HELD FROZEN ACROSS A SEQUENCE — same spot, same chain, same book
at all six marks; only `ctx["time"]` and `ctx["state"]` move. That is deliberate
and it is the whole point of recording sequences rather than single marks: with
the inputs pinned, ANY difference between mark 1 and mark 6 is the rule's own
state and nothing else. It is what makes these fixtures able to catch a port
that forgets to persist `rc_seen`, re-arms the once-per-session EOD sweep, or
drops the `rc_credit` bank — a bug that a single-mark fixture cannot see and
that a moving market would disguise as an input difference.
"""
from __future__ import annotations

import argparse
import copy
import json
import math
import os
import pathlib
import sys
from typing import Any, Dict, List, Optional

# The Python desk is a sibling checkout, not a package this repo depends on.
# `tests/` goes on the path too because the synthetic context builders live in
# the test suite, which is not an importable package.
PY = pathlib.Path.home() / "Documents/dev/algo-engine/sensibull-desk"
sys.path.insert(0, str(PY))
sys.path.insert(0, str(PY / "tests"))

from test_sim_hold_recycle import _ctx, _chain_rows, _sold_book  # noqa: E402
from sensibull_tools.sim.rules import playbooks as P  # noqa: E402

# The registry is `P.REGISTRY` (key -> playbook function); `P.DEFAULTS` holds the
# dial dict per key. Twelve keys start with "recenter" and they are exactly the
# twelve presets `packages/desk-engine` ports. Six of them run `recenter`, six
# run `recenter_shift`.
KEYS: List[str] = [k for k in P.REGISTRY if k.startswith("recenter")]

# Six consecutive 5-minute marks, the cadence the live supervisor runs at.
TIMES = ["09:20", "09:25", "09:30", "09:35", "09:40", "09:45"]
# The same six shifted into the EOD window, so `eod_flat_min` (15:15 on
# recenter-eod / -eod3) is crossed INSIDE a sequence: marks 1-2 are ordinary,
# mark 3 sweeps, and marks 4-6 must NOT sweep again because the first eligible
# mark consumed the session via `state["rc_eod_day"]`.
TIMES_EOD = ["15:05", "15:10", "15:15", "15:20", "15:25", "15:30"]

# --------------------------------------------------------------------------
# The gamma the test builders do not supply
# --------------------------------------------------------------------------
# `_ctx` hard-codes `marked_book.net.gamma` to 0.0 and `_chain_rows` emits price
# and delta only. Every recenter variant steers by `allowed = |netΓ| x tol x
# spot`, so at gamma 0 the allowance is 0, the under-one-lot convexity floor
# trips on every input, and all twelve playbooks answer "no convexity to centre"
# to every mark in the grid — a fixture set that verifies nothing. Gamma has to
# come from somewhere, so it is computed here, as a literal-driven pure
# function, and written into BOTH the chain rows and the book legs.
#
# The shape is Black-Scholes gamma at the money-forward, Γ = φ(d1)/(S σ√T),
# widened into a strike profile by the same φ: with W = S σ √T the ATM value is
# φ(0)/W and a strike K carries φ((K-S)/W)/W. Using the real relation rather
# than an invented bell is what makes the fixtures exercise `tol_ref_dte`
# honestly — that dial exists because gamma grows like 1/√T into expiry, and
# here it actually does.
IV = 0.18                    # flat vol for the synthetic surface, a literal
PHI0 = 0.3989422804014327    # 1/sqrt(2*pi) = phi(0)
# dte 0 is in the grid (expiry session) and √0 is a zero-width surface, so the
# clock floors at half a session rather than dividing by zero. The resulting
# gamma is ~0 for strikes 10 away, which is the correct answer for an expiry-day
# book of OTM strikes and is exactly the "no convexity" input we want recorded.
MIN_DTE_YEARS = 0.5 / 365.0
GREEK_DP = 6                 # rounding, so the JSON is stable and readable

# --------------------------------------------------------------------------
# The delta the test builders do not make add up
# --------------------------------------------------------------------------
# `_ctx` takes `net_delta` as a FREE parameter and writes it straight into
# `marked_book.net.delta`, while `_sold_book`'s two legs carry fixed per-share
# deltas of ∓0.30 that always sum to zero. The declared aggregate and the legs
# therefore disagree, and which of the two a port reads changes its answer:
# Python's `K.net_delta` reads the aggregate, but nothing stops a port summing
# the legs, and `_rc_unwind` DOES size off per-leg `K.dps`. So the book has to
# be built the other way round — the legs are the source of truth and the
# aggregate is their sum.
#
# Each leg's per-share delta is its builder base (0.30) plus a uniform per-share
# SKEW `k` in the delta-increasing direction, chosen so the leg sum lands
# exactly on the row's `net_delta`:
#
#     net(k) = Σ sign_i x (base_i + sign_i x k) x shares_i
#            = natural + k x Σ shares_i            (sign² = 1)
#     =>  k  = (net_delta − natural) / Σ shares_i
#
# with `sign` −1 for a short CE (short calls carry negative delta) and +1 for a
# short PE. Linear, closed-form, exact. Every resulting per-share delta must
# land inside [0.02, 0.98] — the same clamp `_chain_rows` uses — because a short
# call whose delta came out positive is not a book, it is a typo, and a grid row
# that needs one is a row asking for more delta than its lots can carry. The
# generator REFUSES such a row by name rather than emitting it.
#
# Leg deltas are deliberately NOT pinned to the chain's delta at the same
# strike: on the live desk a leg's greeks come from the marked book and the
# chain's from the chain snapshot, and the rules read them from those two
# separate places (`K.dps` for a held leg, `_chain_delta` for a strike being
# sold into). Forcing them equal would hide a port that confuses the two.
DELTA_LO, DELTA_HI = 0.02, 0.98

# Strikes either side of spot in the synthetic chain (`_chain_rows` defaults to
# 10, i.e. 21 rows). The chain is ~three quarters of every recorded ctx and the
# ctx is recorded 1,152 times, so this number sets the size of the whole fixture
# set. 6 is the smallest value that changes NO decision against the builder's
# own default — verified by regenerating at both and diffing every decision —
# because no recenter rule reaches further: it sells at ATM±2, the recycle
# pushes at most two strikes past that, and the deepest shift lands at ATM+2.
CHAIN_N = 6


def gamma_per_share(strike: float, spot: float, dte: int) -> float:
    """Long-option gamma per share at ``strike``, seen from ``spot``/``dte``."""
    t = max(float(dte) / 365.0, MIN_DTE_YEARS)
    w = spot * IV * math.sqrt(t)
    return (PHI0 / w) * math.exp(-0.5 * ((strike - spot) / w) ** 2)


# --------------------------------------------------------------------------
# The grid
# --------------------------------------------------------------------------
# Rows 1-8 are the brief's grid in (spot, dte, lots); rows 9+ are additions,
# each with the branch it exists to reach named in its note — a preset whose
# distinguishing rule never fires in any fixture is a preset the parity test
# cannot tell apart from plain `recenter`. The remaining fields are the ones the
# brief tells us to choose (margin, so the relief keys see both sides of their
# 0.60 gate) plus the two the builders do not parameterise (the book shape and
# its mark).
#
# NET_DELTA IS NOT THE BRIEF'S. Its grid asked for ±900 and +2500 on books of
# 800 shares, which no arrangement of two short options can carry — |netΔ| is
# bounded by the shares in the book, and a leg would have to price at 1.1 delta
# per share to get there. Since the legs are now the source of truth (see the
# DELTA_LO/HI block) those targets are not merely unrealistic, they are
# unbuildable, and the generator refuses them by name. Each has been lowered to
# the nearest value that keeps its row's SCENARIO — inside the band, past the
# band, and on which side — with the original in the note. The rally rows also
# change SIGN: a 10% rally drives a short 310CE deep ITM, so the book it leaves
# behind is net SHORT delta, and the brief's +2500 pointed the wrong way.
#
#   margin_frac  -> ctx["margin"] = margin_frac x margin_cap. Only the four
#                   relief keys read it (`shift_margin_frac` 0.60).
#   margin_cap   -> ctx["margin_cap"]. 0.0 means an UNCAPPED book, which is its
#                   own branch: no ceiling to be a fraction of, so no shift.
#   lots         -> lots per leg, overriding `_sold_book`'s 10.
#   ltp_mult     -> leg ltp as a multiple of entry. >1 puts the shorts under
#                   water, which is what funds the reshift/crossfill recycle.
#   book         -> "strangle" (both `_sold_book` legs) or "pe_only" (calls
#                   removed, so `recenter`'s balance tier has a side to rebuild).
#   times        -> which six marks.
GRID: List[Dict[str, Any]] = [
    # ---- the brief's eight ----------------------------------------------
    {"case": "flat-inside-band", "spot": 300.0, "net_delta": 0, "dte": 20,
     "lots": 4, "margin_frac": 0.30,
     "note": "netΔ 0: inside the band, the plain hold"},
    {"case": "up-delta-past-band", "spot": 300.0, "net_delta": +200, "dte": 20,
     "lots": 4, "margin_frac": 0.30,
     "note": "past the band (allowance ~111), book leans long -> sell CE at "
             "ATM+2. Brief asked +900; 800 shares cannot carry it"},
    {"case": "down-delta-past-band", "spot": 300.0, "net_delta": -200, "dte": 20,
     "lots": 4, "margin_frac": 0.85,
     "note": "past the band, book leans short -> sell PE at ATM-2. Brief "
             "asked -900"},
    {"case": "near-expiry-dte3", "spot": 300.0, "net_delta": +200, "dte": 3,
     "lots": 4, "margin_frac": 0.85,
     "note": "dte 3: tol_ref_dte shrinks the band while gamma inflates it. "
             "Brief asked +900"},
    {"case": "rally-itm-margin-armed", "spot": 330.0, "net_delta": -200,
     "dte": 20, "lots": 4, "margin_frac": 0.85,
     "note": "10% rally: the 310CE is 4 steps ITM and margin is ABOVE the "
             "0.60 gate -> the relief/atm/otm shift fires. Brief asked +2500; "
             "a rally leaves the book net SHORT delta, so the sign is flipped "
             "and the size cut to what 800 shares can hold"},
    {"case": "one-lot-book", "spot": 300.0, "net_delta": +50, "dte": 20,
     "lots": 1, "margin_frac": 0.30,
     "note": "1 lot: the allowance cannot be expressed in tradeable units. "
             "Brief asked +900 against a 200-share book"},
    {"case": "tiny-delta-in-band", "spot": 300.0, "net_delta": +50, "dte": 20,
     "lots": 4, "margin_frac": 0.85,
     "note": "netΔ well inside the band, margin armed but nothing ITM"},
    {"case": "expiry-day-dte0", "spot": 300.0, "net_delta": +200, "dte": 0,
     "lots": 4, "margin_frac": 0.30,
     "note": "expiry session: min_sell_dte and a collapsed surface. Brief "
             "asked +900"},
    # ---- additions, each naming the branch it reaches --------------------
    {"case": "rally-itm-margin-below-gate", "spot": 330.0, "net_delta": -200,
     "dte": 20, "lots": 4, "margin_frac": 0.30,
     "note": "THE OTHER SIDE OF THE 0.60 GATE: same ITM book as "
             "rally-itm-margin-armed, margin at 30% of cap -> the shift is "
             "suppressed and relief degrades to plain recenter"},
    {"case": "rally-itm-uncapped", "spot": 330.0, "net_delta": -200, "dte": 20,
     "lots": 4, "margin_frac": 0.85, "margin_cap": 0.0,
     "note": "uncapped book: a margin FRACTION has no meaning without a cap, "
             "and the safe reading is 'do not shift'"},
    {"case": "big-book-up-unwind", "spot": 300.0, "net_delta": +550, "dte": 20,
     "lots": 10, "margin_frac": 0.30, "ltp_mult": 2.0,
     "note": "10 lots leaves |netΓ| far enough above the gamma floor for the "
             "unwind to buy the PE stack back; the shorts are under water, so "
             "reshift/crossfill have a realized loss to recycle. +550 is the "
             "most 2,000 shares can carry at this skew, and it is what gives "
             "recenter-trend's wider shed budget a whole leg to take"},
    {"case": "big-book-down-unwind", "spot": 300.0, "net_delta": -550, "dte": 20,
     "lots": 10, "margin_frac": 0.85, "ltp_mult": 2.0,
     "note": "the same, with the stack on the CE side"},
    {"case": "big-book-flat-mark", "spot": 300.0, "net_delta": +550, "dte": 20,
     "lots": 10, "margin_frac": 0.30,
     "note": "unwind fires but the book is marked flat: max(0, -gross_mtm) is "
             "0, so the recycle funds nothing and must emit nothing"},
    {"case": "small-excess-partial-unwind", "spot": 300.0, "net_delta": +280,
     "dte": 20, "lots": 10, "margin_frac": 0.30, "ltp_mult": 3.0,
     "note": "netΔ a few shares past the band. One lot of the stack sheds ten "
             "times the excess, so the unwind takes a PARTIAL lot (close_parts) "
             "and overshoots INSIDE the band — which is the only geometry that "
             "leaves recenter-reshift's closed-side recycle any room to sell "
             "into. Every other row lands on the near edge, where that arm is "
             "clipped to zero by construction"},
    {"case": "one-sided-pe-book", "spot": 300.0, "net_delta": +80, "dte": 20,
     "lots": 1, "margin_frac": 0.30, "book": "pe_only",
     "note": "a book that has LOST a side under the convexity floor -> "
             "recenter's balance tier sells the missing side back on. Brief "
             "asked -900: a lone short PUT is LONG delta, so no negative net "
             "exists for this book at all, at any size"},
    {"case": "eod-window-big-book", "spot": 300.0, "net_delta": +550, "dte": 20,
     "lots": 10, "margin_frac": 0.30, "ltp_mult": 2.0, "times": TIMES_EOD,
     "note": "crosses eod_flat_min INSIDE the sequence: mark 3 sweeps the whole "
             "netΔ at tolerance 0, marks 4-6 must not sweep again"},
]

# The cap every capped row is a fraction of. A literal, so `margin` and
# `margin_cap` are both readable numbers in the fixture rather than a ratio the
# TS side has to reverse-engineer.
MARGIN_CAP = 10_000_000.0


def build_ctx(row: Dict[str, Any], state: Dict[str, Any], time: str,
              key: str) -> Dict[str, Any]:
    """One mark's `rules_ctx`, from the Python test suite's own builders.

    Everything the builders parameterise goes through them; the three things
    they do not are patched on afterwards and are called out below.
    """
    spot = float(row["spot"])
    dte = int(row["dte"])
    lots = int(row["lots"])

    # (1) The chain gets a gamma column. `_chain_rows` emits price + delta only;
    #     `recenter_shift` rolls a shifted leg's gamma forward off the chain at
    #     the landing strike, and with no gamma there that roll-forward is a
    #     silent no-op the TS port would never be tested on.
    rows = _chain_rows(spot=spot, n=CHAIN_N)
    for r in rows:
        g = round(gamma_per_share(float(r["strike"]), spot, dte), GREEK_DP)
        r["CE"]["gamma"] = g
        r["PE"]["gamma"] = g

    legs = _sold_book(spot=spot)
    if row.get("book") == "pe_only":
        legs = [l for l in legs if l.get("opt_type") == "PE"]

    ltp_mult = float(row.get("ltp_mult", 1.0))
    target = float(row["net_delta"])

    # `_sold_book` is fixed at 10 lots; the grid varies the size, so each leg's
    # BASE per-share delta is recovered from the builder's own leg and re-applied
    # at the grid's lot count.
    signs = [-1.0 if l["opt_type"] == "CE" else 1.0 for l in legs]
    bases = [abs(float(l["delta"])) / (int(l["lots"]) * float(l["lot_size"]))
             for l in legs]
    shares = [lots * float(l["lot_size"]) for l in legs]
    natural = sum(sg * b * sh for sg, b, sh in zip(signs, bases, shares))
    skew = (target - natural) / sum(shares)

    net_delta = 0.0
    net_gamma = 0.0
    book_mtm = 0.0
    for l, sg, base, sh in zip(legs, signs, bases, shares):
        # CE: base − skew, PE: base + skew. See the DELTA_LO/HI block above for
        # why this is the construction and why the bound is not negotiable.
        dps = base + sg * skew
        if not (DELTA_LO <= dps <= DELTA_HI):
            raise SystemExit(
                f"grid row {row['case']!r}: net_delta {target:+.0f} needs the "
                f"{l['opt_type']} leg at {dps:+.4f} delta/share, outside "
                f"[{DELTA_LO}, {DELTA_HI}] — the book does not have the shares "
                f"to carry that much net delta. Lower the target or raise lots.")
        l["lots"] = lots
        # Side-adjusted, as the marked book carries it: short CE negative, short
        # PE positive. Rounded FIRST so the aggregate below is the sum of the
        # numbers actually written to the fixture, not of their un-rounded
        # ancestors.
        l["delta"] = round(sg * dps * sh, GREEK_DP)
        # (2) Leg gamma, absent from `_leg`. Short options are short gamma, so
        #     the sign is negative for both legs.
        l["gamma"] = round(-gamma_per_share(float(l["strike"]), spot, dte)
                           * sh, GREEK_DP)
        # (3) `gross_mtm`, absent from `_leg` and the ONLY thing the recycle
        #     funds itself from (`_rc_recycle_loss` reads it per leg, never
        #     entry/ltp). A short is under water when ltp > entry.
        l["ltp"] = round(float(l["entry"]) * ltp_mult, 2)
        l["gross_mtm"] = round((float(l["entry"]) - float(l["ltp"])) * sh, 2)
        net_delta += l["delta"]
        net_gamma += l["gamma"]
        book_mtm += l["gross_mtm"]

    if abs(net_delta - target) > 1e-6:
        raise SystemExit(f"grid row {row['case']!r}: leg deltas sum to "
                         f"{net_delta} against a target of {target}")

    cap = float(row.get("margin_cap", MARGIN_CAP))
    ctx = _ctx(legs, state=state, spot=spot, dte=dte, rows=rows,
               mtm=round(book_mtm, 2), net_delta=round(net_delta, GREEK_DP),
               margin=round(float(row["margin_frac"]) * cap, 2), margin_cap=cap)
    # `_ctx` hard-codes net gamma to 0.0 and the mark time to "10:00"; both are
    # inputs this grid varies, so both are set here. `ctx["date"]` is left at
    # the builder's literal — one session, which is what makes the once-per-
    # session EOD sweep observable across a sequence.
    ctx["marked_book"]["net"]["gamma"] = round(net_gamma, GREEK_DP)
    ctx["time"] = time
    # The engine stamps the running playbook's key; `recenter_shift` reads it
    # for its reason label, and without it recenter-relief mislabels itself
    # "recenter-otm" and every reason string diffs.
    ctx["playbook"] = key
    return ctx


def sequence(key: str, row: Dict[str, Any]) -> Dict[str, Any]:
    """Six marks of one playbook against one grid row, state threaded."""
    fn = P.REGISTRY[key]
    params = P.DEFAULTS[key]
    times = row.get("times", TIMES)

    state: Dict[str, Any] = {}
    marks: List[Dict[str, Any]] = []
    for t in times:
        ctx = build_ctx(row, state, t, key)
        # The playbook is handed a DEEP COPY and mutates it freely (`_rc_seen`
        # writes the provenance ledger, the EOD sweep stamps `rc_eod_day`, the
        # recycle bank grows `rc_credit`). `ctx` itself therefore stays the
        # pristine input the TS port will be replayed against, while the copy's
        # `state` — the mutated one — is what threads into the next mark.
        call_ctx = copy.deepcopy(ctx)
        decision = fn(call_ctx, copy.deepcopy(params))
        state = call_ctx["state"]
        marks.append({"ctx": ctx, "decision": decision,
                      "state_after": copy.deepcopy(state)})

    seed = {k: v for k, v in row.items() if k != "times"}
    seed.update({
        "playbook": key,
        "fn": fn.__name__,
        # The dial dict travels WITH the sequence so the fixture is a
        # self-contained replay unit: the TS side never has to keep its own copy
        # of the Python defaults, and a dial changing in Python shows up here as
        # a real parity diff instead of silently disagreeing.
        "params": params,
        "margin_cap": float(row.get("margin_cap", MARGIN_CAP)),
        "iv": IV,
        "times": times,
    })
    return {"seed": seed, "marks": marks}


def main() -> None:
    here = pathlib.Path(__file__).resolve().parent.parent
    default_out = here / "packages/desk-engine/test/fixtures/decisions"
    ap = argparse.ArgumentParser(
        description="Freeze the Python recenter playbooks' decisions as JSON "
                    "parity fixtures, one file per preset.")
    ap.add_argument("--out", default=str(default_out),
                    help=f"destination fixtures directory (default: {default_out})")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    if len(KEYS) != 12:
        raise SystemExit(f"expected 12 recenter presets in P.REGISTRY, found "
                         f"{len(KEYS)}: {KEYS}")

    total_marks = 0
    total_acts = 0
    for key in KEYS:
        seqs = [sequence(key, row) for row in GRID]
        path = os.path.join(args.out, f"{key}.json")
        with open(path, "w") as fh:
            # allow_nan=False: a NaN would serialize as the bare token `NaN`,
            # which is not JSON and which JSON.parse rejects — better to fail
            # here, loudly, than to ship a fixture the TS side cannot read.
            json.dump(seqs, fh, indent=2, sort_keys=True, allow_nan=False,
                      ensure_ascii=False)
            fh.write("\n")
        n_marks = sum(len(s["marks"]) for s in seqs)
        n_act = sum(1 for s in seqs for m in s["marks"]
                    if m["decision"]["action"] != "hold")
        total_marks += n_marks
        total_acts += n_act
        print(f"{path}: {len(seqs)} sequences, {n_marks} marks, "
              f"{n_act} non-hold")
    print(f"-- {len(KEYS)} files, {total_marks} marks, {total_acts} non-hold")


if __name__ == "__main__":
    main()
