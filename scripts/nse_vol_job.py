#!/usr/bin/env python3
"""After the F&O close, save each held stock's near and next-month option chains and NSE's daily volatility file.

Writes <root>/vol/<YYYY-MM-DD>.json (atomic). The traders app (apps/traders, VolStore and vol-metrics) reads it
and computes every figure; this job only gathers and reduces. Spec:
docs/superpowers/specs/2026-10-23-traders-vol-addendum.md.

  .venv-nse/bin/python scripts/nse_vol_job.py [--dir DIR] [--date YYYY-MM-DD] [--symbols TCS,INFY] [--dry-run] [--events-only]

Sources, each fail-soft:
  - the day's FO bhavcopy that span_job.py saved in <root>/<date>/ (no network): futures, and option closes of
    contracts that traded that day (an untraded contract's close is an older day's, so it is dropped);
  - NSE's option-chain-v3 API, only for today's run and only for the near expiry: NSE's impliedVolatility per strike
    (one request per stock, at most 40 stocks, through nsepythonserver's Chrome-impersonating session). 3 failures in a
    row stop it for the run, an unusable answer (no records, no expiries) counting as one; a chain stamped another day
    (NSE closed today) stops it at once. The next month is solved from the bhavcopy alone;
  - NSE's CMVOLT_<DDMMYYYY>.CSV archive: each symbol's daily and annualised (EWMA, x sqrt 365) volatility.

The stocks are <root>/held.json (written each minute by desk-traders: every trader's open books, symbols only),
or --symbols. After the vol step, the events step writes <root>/events.json: results dates (R9 of
docs/superpowers/specs/2026-10-24-traders-risk-design.md); --events-only runs just that. Root: --dir, else env TRADERS_NSE_DIR, else <repo>/data/nse. Stdlib only at import time.
"""
import argparse
import csv
import importlib.util
import io
import json
import os
import re
import sys
import time
import urllib.parse
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, Optional

IST = timezone(timedelta(hours=5, minutes=30))
API = 'https://www.nseindia.com/api'
ARCHIVES = 'https://nsearchives.nseindia.com'
SYMBOL_RE = re.compile(r'^[A-Z0-9&-]{1,20}$')
INDICES = {'NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'NIFTYNXT50'}
STRIKE_BAND = 0.30     # strikes kept within ±30% of the future (or the spot)
NSE_TRIP = 3           # NSE failures in a row (an unusable 200 included) that stop NSE calls for the rest of the run
NSE_MAX_STOCKS = 40    # held stocks per run that NSE is asked about; the rest are read from the bhavcopy only
NSE_DELAY_S = 1.0      # between NSE API calls
AFTER_CLOSE = (15, 45)  # IST: today's run waits for the 15:40 F&O close
KEEP_DAYS = 400

Fetch = Callable[[str], object]


def _span_job():
    """span_job.py, loaded by path (works under python -I too): its atomic write and archive fetcher."""
    mod = sys.modules.get('span_job')
    if mod is None:
        spec = importlib.util.spec_from_file_location('span_job', Path(__file__).resolve().parent / 'span_job.py')
        mod = importlib.util.module_from_spec(spec)
        sys.modules['span_job'] = mod
        spec.loader.exec_module(mod)
    return mod


# ---------------------------------------------------------------- expiries
# The ranked IV's expiry is span_job's: the first expiry at least 7 calendar days out (a fixed tenor), as its history
# step writes; "next" is the following calendar month's last expiry. One rule for the snapshots and the history.
iv_expiry = _span_job().iv_expiry
next_month_expiry = _span_job().next_month_expiry


def near_next(day: date, expiries: list[date]) -> tuple[Optional[date], Optional[date], bool]:
    """(near, next, rolled): near = the first expiry 7 or more calendar days out; rolled = it is not the first listed."""
    near = iv_expiry(expiries, day)
    if near is None:
        return None, None, False
    first = min((e for e in expiries if e > day), default=None)
    return near, next_month_expiry(expiries, near), near != first


# ---------------------------------------------------------------- parsers

def _num(s: Optional[str]) -> Optional[float]:
    try:
        v = float((s or '').strip())
    except ValueError:
        return None
    return v if v == v and v not in (float('inf'), float('-inf')) else None


def parse_fo(text: str, symbols: set[str]) -> dict[str, dict]:
    """{sym: {spot, fut: {expiry: price}, opt: {expiry: {strike: [ce, pe]}}}} from a UDiFF FO bhavcopy.

    An option's close counts only when it traded that day (TtlTradgVol > 0). A future is read at its close when it
    traded, else at its settlement price (always published)."""
    out: dict[str, dict] = {}
    for r in csv.DictReader(io.StringIO(text)):
        sym = (r.get('TckrSymb') or '').strip()
        if sym not in symbols:
            continue
        tp = (r.get('FinInstrmTp') or '').strip()
        try:
            exp = date.fromisoformat((r.get('XpryDt') or '').strip())
        except ValueError:
            continue
        s = out.setdefault(sym, {'spot': None, 'fut': {}, 'opt': {}})
        spot = _num(r.get('UndrlygPric'))
        if s['spot'] is None and spot is not None and spot > 0:
            s['spot'] = spot
        traded = (_num(r.get('TtlTradgVol')) or 0) > 0
        close = _num(r.get('ClsPric'))
        if tp in ('STF', 'IDF'):
            px = close if traded else _num(r.get('SttlmPric'))
            if px is not None and px > 0:
                s['fut'][exp] = px
        elif tp in ('STO', 'IDO'):
            k = _num(r.get('StrkPric'))
            side = (r.get('OptnTp') or '').strip()
            if k is None or k <= 0 or side not in ('CE', 'PE'):
                continue
            row = s['opt'].setdefault(exp, {}).setdefault(k, [None, None])
            if traded and close is not None and close > 0:
                row[0 if side == 'CE' else 1] = close
    return out


def parse_cmvolt(text: str) -> dict[str, list[float]]:
    """{sym: [daily, annual]} from CMVOLT_<DDMMYYYY>.CSV, columns found by their header's start; '-' rows skipped."""
    rows = csv.reader(io.StringIO(text))
    head = [h.strip() for h in next(rows, [])]

    def col(prefix: str) -> int:
        for i, h in enumerate(head):
            if h.startswith(prefix):
                return i
        raise ValueError(f'CMVOLT has no "{prefix}" column')

    si, di, ai = col('Symbol'), col('Current Day Underlying Daily Volatility'), col('Underlying Annualised Volatility')
    out: dict[str, list[float]] = {}
    for r in rows:
        if len(r) <= max(si, di, ai):
            continue
        d, a = _num(r[di]), _num(r[ai])
        sym = r[si].strip()
        if sym and d is not None and a is not None and d > 0 and a > 0:
            out[sym] = [d, a]
    return out


def _iv(leaf) -> Optional[float]:
    if not isinstance(leaf, dict):
        return None
    v = leaf.get('impliedVolatility')
    if not isinstance(v, (int, float)) or isinstance(v, bool) or not (0 < v < 1000):
        return None
    return round(v / 100, 6)


class StaleChain(ValueError):
    """The chain is stamped another day: NSE did not trade today, for every symbol alike."""


def parse_v3(payload: dict, expiry: date, day: date) -> tuple[dict[float, list], Optional[float]]:
    """({strike: [ceIv, peIv]}, underlyingValue) for one expiry; IVs decimal, NSE's 0 is no IV.

    Raises ValueError for an answer with no records (a soft block's `{}`), StaleChain when the chain's timestamp is not
    `day` (a holiday's chain is the last session's)."""
    rec = payload.get('records') if isinstance(payload, dict) else None
    if not isinstance(rec, dict):
        raise ValueError('no records in the chain')
    try:
        stamp = datetime.strptime(str(rec.get('timestamp', '')).strip(), '%d-%b-%Y %H:%M:%S').date()
    except ValueError:
        raise ValueError('the chain has no readable timestamp')
    if stamp != day:
        raise StaleChain(f'chain is for {stamp.isoformat()}, not {day.isoformat()}')
    want = expiry.strftime('%d-%b-%Y')
    out: dict[float, list] = {}
    for e in rec.get('data') or []:
        if not isinstance(e, dict) or e.get('expiryDates') != want:
            continue
        k = e.get('strikePrice')
        if not isinstance(k, (int, float)) or isinstance(k, bool) or k <= 0:
            continue
        out[float(k)] = [_iv(e.get('CE')), _iv(e.get('PE'))]
    spot = rec.get('underlyingValue')
    return out, (float(spot) if isinstance(spot, (int, float)) and not isinstance(spot, bool) and spot > 0 else None)


def v3_url(symbol: str, expiry: date) -> str:
    kind = 'Indices' if symbol in INDICES else 'Equity'
    return f'{API}/option-chain-v3?type={kind}&symbol={urllib.parse.quote(symbol, safe="")}&expiry={expiry.strftime("%d-%b-%Y")}'


def cmvolt_name(day: date) -> str:
    return f'CMVOLT_{day.strftime("%d%m%Y")}.CSV'


def cmvolt_url(day: date) -> str:
    return f'{ARCHIVES}/archives/nsccl/volt/{cmvolt_name(day)}'


def fo_name(day: date) -> str:
    return f'BhavCopy_NSE_FO_0_0_0_{day.strftime("%Y%m%d")}_F_0000.csv'


def read_held(root: Path, log: Callable[[str], None]) -> list[str]:
    """The stocks in <root>/held.json, valid symbols only, sorted; [] when the file is missing or unreadable."""
    p = root / 'held.json'
    try:
        doc = json.loads(p.read_text())
    except FileNotFoundError:
        log(f'{p}: not found — no held stocks (CMVOLT only)')
        return []
    except (OSError, ValueError) as e:
        log(f'{p}: unreadable ({e}) — no held stocks (CMVOLT only)')
        return []
    stocks = doc.get('stocks') if isinstance(doc, dict) else None
    if not isinstance(stocks, list):
        log(f'{p}: no stocks list — no held stocks (CMVOLT only)')
        return []
    return sorted({s for s in stocks if isinstance(s, str) and SYMBOL_RE.match(s)})


# ---------------------------------------------------------------- the run

def _side(fo_exp: Optional[dict], ivs: Optional[dict], future: Optional[float], spot: Optional[float]) -> list[list]:
    ref = future or spot
    strikes = set((fo_exp or {}).keys()) | set((ivs or {}).keys())
    rows = []
    for k in sorted(strikes):
        if ref is not None and abs(k / ref - 1) > STRIKE_BAND:
            continue
        ce, pe = (fo_exp or {}).get(k, [None, None])
        civ, piv = (ivs or {}).get(k, [None, None])
        if ce is None and pe is None and civ is None and piv is None:
            continue
        rows.append([k, ce, pe, civ, piv])
    return rows


def run(day: date, *, root: Path, symbols: list[str], fetch_json: Fetch, fetch_bytes: Fetch, fetch_expiries: Fetch,
        now: Callable[[], float], log: Callable[[str], None], live: bool, dry_run: bool = False,
        sleep: Callable[[float], None] = time.sleep) -> Optional[dict]:
    """Gather, reduce and (unless dry_run) write <root>/vol/<day>.json. None = nothing found, nothing written."""
    errors: list[str] = []
    # the bhavcopy span_job saved (no network)
    fo: dict[str, dict] = {}
    fo_path = root / day.isoformat() / fo_name(day)
    try:
        fo = parse_fo(fo_path.read_text(), set(symbols))
    except FileNotFoundError:
        log(f'{fo_path.name}: no FO bhavcopy for {day.isoformat()} — closes and futures unknown, NSE IVs only')
        errors.append('FO bhavcopy missing')
    except (OSError, ValueError, csv.Error) as e:
        log(f'{fo_path.name}: unreadable ({e})')
        errors.append('FO bhavcopy unreadable')

    nse_fails = 0
    nse_calls = 0
    nse_stop: Optional[str] = None

    def nse(call: Callable[[], object]) -> object:
        """One NSE request AND its parse: an answer that cannot be used fails like a refused one."""
        nonlocal nse_fails, nse_calls, nse_stop
        if nse_stop is not None:
            raise RuntimeError(f'skipped: {nse_stop}')
        if nse_calls > 0:
            sleep(NSE_DELAY_S)
        nse_calls += 1
        try:
            v = call()
        except StaleChain as e:
            nse_stop = f'{e}: NSE did not trade today'
            log(f'NSE: {nse_stop} — no more NSE calls this run')
            raise
        except Exception:
            nse_fails += 1
            if nse_fails >= NSE_TRIP:
                nse_stop = f'{NSE_TRIP} NSE failures in a row'
                log(f'NSE: {nse_stop} — no more NSE calls this run')
            raise
        nse_fails = 0
        return v

    def listed(sym: str) -> list[date]:
        got = sorted(d for d in (fetch_expiries(sym) or []) if isinstance(d, date))
        if not got:
            raise ValueError('NSE listed no expiries')
        return got

    over = symbols[NSE_MAX_STOCKS:] if live else []
    if over:
        msg = f'{len(over)} held stocks over the {NSE_MAX_STOCKS}-stock NSE cap, bhavcopy only: {", ".join(over)}'
        log(msg)
        errors.append(msg)

    stocks: dict[str, dict] = {}
    for i, sym in enumerate(symbols):
        ask_nse = live and i < NSE_MAX_STOCKS
        errs: list[str] = []
        sources: list[str] = []
        f = fo.get(sym)
        if f is None and fo:
            errs.append('not in the FO bhavcopy')
        expiries: list[date] = sorted(set((f or {}).get('opt', {}).keys()))
        if not expiries and ask_nse:
            try:
                expiries = nse(lambda: listed(sym))
            except Exception as e:
                errs.append(f'nse expiries: {e}')
        near, nxt, rolled = near_next(day, expiries)
        spot = (f or {}).get('spot')
        sides: dict[str, Optional[dict]] = {'near': None, 'next': None}
        used_nse = False
        for name, exp in (('near', near), ('next', nxt)):
            if exp is None:
                continue
            ivs = None
            if ask_nse and name == 'near':   # the next month is solved from the bhavcopy: one NSE call a stock
                try:
                    ivs, nse_spot = nse(lambda: parse_v3(fetch_json(v3_url(sym, exp)), exp, day))
                    used_nse = used_nse or any(a is not None or b is not None for a, b in ivs.values())
                    spot = spot or nse_spot
                except Exception as e:
                    errs.append(f'nse {exp.isoformat()}: {e}')
            future = (f or {}).get('fut', {}).get(exp)
            sides[name] = {
                'expiry': exp.isoformat(), 'rolled': rolled, 'future': future,
                'strikes': _side((f or {}).get('opt', {}).get(exp), ivs, future, spot),
            }
        if f is not None and (sides['near'] or sides['next']):
            sources.append('bhavcopy')
        if used_nse:
            sources.append('nse')
        if near is None and not errs:
            errs.append('no expiry a week or more out listed')
        stocks[sym] = {'spot': spot, 'sources': sources, 'near': sides['near'], 'next': sides['next'], 'errors': errs}
        n = sum(len(s['strikes']) for s in sides.values() if s)
        log(f'{sym}: near {near.isoformat() if near else "-"}{" (rolled)" if rolled else ""} '
            f'next {nxt.isoformat() if nxt else "-"} [{"+".join(sources) or "no source"}] {n} strikes'
            + (f' — {"; ".join(errs)}' if errs else ''))

    cmvolt = None
    try:
        blob = fetch_bytes(cmvolt_url(day))
        if blob is None:
            errors.append(f'{cmvolt_name(day)} not published yet')
        else:
            cmvolt = {'file': cmvolt_name(day), 'symbols': parse_cmvolt(bytes(blob).decode('utf-8', 'replace'))}
            log(f'{cmvolt_name(day)}: {len(cmvolt["symbols"])} symbols')
    except Exception as e:
        errors.append(f'{cmvolt_name(day)}: {e}')
    for e in errors:
        log(e)

    if cmvolt is None and not any(s['sources'] for s in stocks.values()):
        log(f'nothing for {day.isoformat()}: no file written')
        return None
    doc = {'v': 1, 'date': day.isoformat(), 'writtenAt': int(now() * 1000), 'cmvolt': cmvolt, 'stocks': stocks, 'errors': errors}
    if dry_run:
        log('dry run: nothing written')
        return doc
    folder = root / 'vol'
    folder.mkdir(parents=True, exist_ok=True)
    _span_job()._write_atomic(folder / f'{day.isoformat()}.json', json.dumps(doc, separators=(',', ':')).encode())
    log(f'wrote {folder / (day.isoformat() + ".json")}')
    return doc


def prune_vol(root: Path, today: date, keep_days: int = KEEP_DAYS) -> list[str]:
    """Remove vol/<YYYY-MM-DD>.json older than today - keep_days; other names are left alone."""
    cutoff = today - timedelta(days=keep_days)
    folder = root / 'vol'
    removed = []
    if not folder.is_dir():
        return removed
    for p in sorted(folder.iterdir()):
        m = re.fullmatch(r'(\d{4}-\d{2}-\d{2})\.json', p.name)
        if m is None or p.is_symlink() or not p.is_file():
            continue
        try:
            d = date.fromisoformat(m.group(1))
        except ValueError:
            continue
        if d < cutoff:
            p.unlink()
            removed.append(p.name)
    return removed


# ---------------------------------------------------------------- the events step (results dates, R9)

EVENTS_FILE = 'events.json'
EVENTS_CACHE_DAYS = 7
EVENTS_LOOKBACK_DAYS = 400
RESULTS_RE = re.compile(r'financial results', re.I)
CALENDAR_URL = f'{API}/event-calendar?index=equities'


def board_meetings_url(symbol: str, today: date) -> str:
    frm = (today - timedelta(days=EVENTS_LOOKBACK_DAYS)).strftime('%d-%m-%Y')
    return (f'{API}/corporate-board-meetings?index=equities&symbol={urllib.parse.quote(symbol, safe="")}'
            f'&from_date={frm}&to_date={today.strftime("%d-%m-%Y")}')


def _nse_date(s: object) -> Optional[str]:
    try:
        return datetime.strptime(str(s).strip(), '%d-%b-%Y').date().isoformat()
    except ValueError:
        return None


def parse_calendar(payload: object, fno: Optional[set[str]]) -> dict[str, list[dict]]:
    """{symbol: [{date, purpose}]} of the results rows, ISO dates sorted, one per date; F&O symbols only when `fno`."""
    if not isinstance(payload, list):
        raise ValueError('calendar is not a list')
    out: dict[str, dict[str, str]] = {}
    for r in payload:
        if not isinstance(r, dict):
            continue
        sym, purpose, d = r.get('symbol'), r.get('purpose'), _nse_date(r.get('date'))
        if not isinstance(sym, str) or not isinstance(purpose, str) or d is None or not RESULTS_RE.search(purpose):
            continue
        if fno is not None and sym not in fno:
            continue
        out.setdefault(sym, {}).setdefault(d, purpose.strip())
    return {s: [{'date': d, 'purpose': p} for d, p in sorted(m.items())] for s, m in sorted(out.items())}


def parse_board_meetings(payload: object) -> list[dict]:
    """[{date, purpose}] of the results meetings, ISO dates sorted, one per date (an intimation row is a duplicate)."""
    if not isinstance(payload, list):
        raise ValueError('board meetings is not a list')
    m: dict[str, str] = {}
    for r in payload:
        if not isinstance(r, dict):
            continue
        purpose, d = r.get('bm_purpose'), _nse_date(r.get('bm_date'))
        if isinstance(purpose, str) and d is not None and RESULTS_RE.search(purpose):
            m.setdefault(d, purpose.strip())
    return [{'date': d, 'purpose': p} for d, p in sorted(m.items())]


def _history_symbols(root: Path) -> Optional[set[str]]:
    """The symbols of the newest <root>/history/<date>.json; None when there is none (keep every symbol)."""
    folder = root / 'history'
    names = sorted(p.name for p in folder.iterdir() if re.fullmatch(r'\d{4}-\d{2}-\d{2}\.json', p.name)) \
        if folder.is_dir() else []
    for name in reversed(names):
        try:
            syms = json.loads((folder / name).read_text()).get('symbols')
        except (OSError, ValueError, AttributeError):
            continue
        if isinstance(syms, dict) and syms:
            return set(syms)
    return None


def _iso_z(t: datetime) -> str:
    return t.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def _fresh(fetched: object, t: datetime) -> bool:
    try:
        f = datetime.strptime(str(fetched), '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=timezone.utc)
    except ValueError:
        return False
    return timedelta(0) <= t - f < timedelta(days=EVENTS_CACHE_DAYS)


def events_step(root: Path, symbols: list[str], *, fetch_json: Fetch, now: datetime, log: Callable[[str], None],
                dry_run: bool = False, sleep: Callable[[float], None] = time.sleep) -> dict:
    """Write <root>/events.json (atomic): the results calendar (one request) and each held stock's past results dates
    (one request each, at most 40, cached 7 days). Fail-soft: 3 failures in a row stop NSE for the run, and a failed
    part keeps the previous file's entries. Errors are short fixed strings, never a response body."""
    path = root / EVENTS_FILE
    try:
        prev = json.loads(path.read_text())
    except (OSError, ValueError):
        prev = {}
    if not isinstance(prev, dict):
        prev = {}
    prev_up = prev.get('upcoming') if isinstance(prev.get('upcoming'), dict) else {}
    prev_past = prev.get('past') if isinstance(prev.get('past'), dict) else {}
    today = now.astimezone(IST).date()
    errors: list[str] = []
    fails = 0
    calls = 0
    stopped = False

    def ask(url: str, parse: Callable[[object], object]) -> object:
        nonlocal fails, calls, stopped
        if calls:
            sleep(NSE_DELAY_S)
        calls += 1
        try:
            v = parse(fetch_json(url))
        except Exception:
            fails += 1
            if fails >= NSE_TRIP:
                stopped = True
                log(f'events: {NSE_TRIP} NSE failures in a row — no more NSE calls this run')
            raise
        fails = 0
        return v

    upcoming = prev_up
    try:
        fno = _history_symbols(root)
        upcoming = ask(CALENDAR_URL, lambda p: parse_calendar(p, fno))
        log(f'events: {len(upcoming)} F&O symbols report results soon')
    except Exception:
        errors.append('event calendar failed')
        log('events: the event calendar failed — previous entries kept')

    held = [s for s in symbols if s not in INDICES]
    if len(held) > NSE_MAX_STOCKS:
        errors.append(f'{len(held) - NSE_MAX_STOCKS} held stocks over the {NSE_MAX_STOCKS}-stock cap')
        held = held[:NSE_MAX_STOCKS]
    past: dict[str, dict] = {}
    skipped = 0
    for sym in held:
        old = prev_past.get(sym)
        if isinstance(old, dict) and _fresh(old.get('fetched'), now) and isinstance(old.get('meetings'), list):
            past[sym] = old
            continue
        if stopped:
            skipped += 1
            if isinstance(old, dict):
                past[sym] = old
            continue
        try:
            meetings = ask(board_meetings_url(sym, today), parse_board_meetings)
            past[sym] = {'fetched': _iso_z(now), 'meetings': meetings}
        except Exception:
            errors.append(f'board meetings failed: {sym}')
            if isinstance(old, dict):
                past[sym] = old
    if skipped:
        errors.append(f'NSE stopped after {NSE_TRIP} failures in a row: {skipped} stocks not refreshed')
    for e in errors:
        log(f'events: {e}')

    doc = {'v': 1, 'writtenAt': _iso_z(now), 'upcoming': upcoming, 'past': past, 'errors': errors}
    if dry_run:
        log('events dry run: nothing written')
        log(json.dumps(doc, indent=1))
        return doc
    root.mkdir(parents=True, exist_ok=True)
    _span_job()._write_atomic(path, json.dumps(doc, separators=(',', ':')).encode())
    log(f'wrote {path}')
    return doc


# ---------------------------------------------------------------- wiring

def _fetchers() -> tuple[Fetch, Fetch, Fetch]:
    """(NSE JSON, archive bytes, NSE expiry list), built lazily: the venv has nsepythonserver, the tests do not."""
    import nsepythonserver  # curl_cffi Chrome session, warmed with NSE's cookies; re-warms once on a 403/404

    def expiries(sym: str) -> list[date]:
        out = []
        for s in nsepythonserver.expiry_list(sym, type='list') or []:
            try:
                out.append(datetime.strptime(s, '%d-%b-%Y').date())
            except ValueError:
                continue
        return out

    return nsepythonserver.nsefetch, _span_job().nse_fetcher(), expiries


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _default_root() -> Path:
    return Path(os.environ.get('TRADERS_NSE_DIR') or Path(__file__).resolve().parent.parent / 'data' / 'nse')


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--dir', type=Path, default=None)
    ap.add_argument('--date', type=date.fromisoformat, default=None)
    ap.add_argument('--symbols', default=None, help='comma-separated; replaces held.json')
    ap.add_argument('--dry-run', action='store_true', help='fetch and print, write nothing')
    ap.add_argument('--events-only', action='store_true', help='run only the events step (results dates)')
    args = ap.parse_args(argv)
    root = args.dir or _default_root()
    now_ist = _now_utc().astimezone(IST)
    today = now_ist.date()
    day = args.date or today

    def log(msg: str) -> None:
        print(msg, flush=True)

    if not args.events_only and day == today and (now_ist.hour, now_ist.minute) < AFTER_CLOSE:
        log(f'{now_ist:%H:%M} IST is before the F&O close: nothing to snapshot yet')
        return 0
    if args.symbols is not None:
        symbols = sorted({s.strip().upper() for s in args.symbols.split(',') if SYMBOL_RE.match(s.strip().upper())})
    else:
        symbols = read_held(root, log)
    rc = 0
    fetch_json = None
    try:
        fetch_json, fetch_bytes, fetch_expiries = _fetchers()
        if not args.events_only:
            run(day, root=root, symbols=symbols, fetch_json=fetch_json, fetch_bytes=fetch_bytes,
                fetch_expiries=fetch_expiries, now=time.time, log=log, live=day == today, dry_run=args.dry_run)
            if not args.dry_run:
                for name in prune_vol(root, today):
                    log(f'pruned vol/{name}')
    except Exception as e:
        log(f'unexpected: {e!r}')
        rc = 1
    # the events step: after the vol step, and never a reason for it to fail
    if fetch_json is not None or args.events_only:
        try:
            events_step(root, symbols, fetch_json=fetch_json, now=_now_utc(), log=log, dry_run=args.dry_run)
        except Exception as e:
            log(f'events: unexpected {e!r}')
            if args.events_only:
                rc = 1
    return rc


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
