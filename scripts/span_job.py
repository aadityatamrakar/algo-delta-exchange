#!/usr/bin/env python3
"""Download and save NSE's SPAN, exposure-margin and end-of-day files, and a daily summary of the bhavcopies.

Each file lands in the folder of its own business date, <root>/<YYYY-MM-DD>/, next to a
manifest.json ({key: {name, url, savedAt, bytes, sha256}}); a key already in the manifest is
not fetched again. The traders app (apps/traders, EodStore and the SPAN reader) reads the files.

Once a day's CM and FO bhavcopies are both saved, the history step writes <root>/history/<YYYY-MM-DD>.json:
one entry per F&O underlying (cash OHLC and volume, the near future's close and OI, the near expiry's OI,
ATM closes, OI walls and max pain, the fixed-tenor IV's ATM closes, and NSE's previous close for corporate actions),
which the traders app's HistoryStore reads for chart history, levels and IV rank. An index's entry (no cash row: its
OHLC is the near future's) also carries "ic", the index's own closing value from the FO bhavcopy's UndrlygPric, which
is what an expired index option settles at; a stock's "c" is the cash close and its entry has no "ic".
The dated folders are pruned after a week; the history folder is not (prune only touches YYYY-MM-DD names).

  .venv-nse/bin/python scripts/span_job.py [--dir DIR] [--date YYYY-MM-DD]
  .venv-nse/bin/python scripts/span_job.py --backfill-history N [--delay SECONDS] [--date END] [--rewrite]

--backfill-history N writes the summaries of the last N trading days up to --date (default today, IST),
downloading each day's CM and FO bhavcopies into memory only (nothing but the summary is saved); a day
already summarised is skipped, one whose files are still on disk is read from there. It runs nothing else.

--rewrite (with --backfill-history) also visits the days already summarised whose file has no "ic" yet: it re-reads the
day's two bhavcopies (the dated folder first, else NSE) and adds "ic" to the index entries of the file, leaving every
other field as it was. A day whose file has an "ic" is left alone, so a run that stopped can simply be started again.

Root: --dir, else env TRADERS_NSE_DIR, else <repo>/data/nse. Stdlib only at import time;
nsepythonserver is imported lazily inside nse_fetcher().
"""
import argparse
import csv
import gzip
import hashlib
import io
import json
import math
import os
import re
import shutil
import sys
import time
import zipfile
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, NamedTuple, Optional

MAX_BYTES = 200 * 1024 * 1024
ARCHIVES = 'https://nsearchives.nseindia.com'
IST = timezone(timedelta(hours=5, minutes=30))
# Of the previous weekday only the end-of-day files are wanted (yesterday's close and OI).
PREVIOUS_KEYS = ('s', 'fo', 'cm')


class FileSpec(NamedTuple):
    key: str
    name: str  # the name it is saved under
    url: str
    member: Optional[str]  # suffix of the ONE zip member to extract; None = save as is


def files_for(day: date) -> list[FileSpec]:
    """Every file NSE publishes for one business day (V-J2)."""
    ymd = day.strftime('%Y%m%d')
    dmy = day.strftime('%d%m%Y')
    span = f'{ARCHIVES}/archives/nsccl/span/nsccl.{ymd}'
    fo = f'BhavCopy_NSE_FO_0_0_0_{ymd}_F_0000.csv'
    cm = f'BhavCopy_NSE_CM_0_0_0_{ymd}_F_0000.csv'
    out = [FileSpec('s', f'nsccl.{ymd}.s.spn', f'{span}.s.zip', '.spn')]
    out += [FileSpec(f'i{i}', f'nsccl.{ymd}.i{i}.spn', f'{span}.i{i}.zip', '.spn') for i in range(1, 6)]
    out += [
        FileSpec('ael', f'ael_{dmy}.csv', f'{ARCHIVES}/archives/exp_lim/ael_{dmy}.csv', None),
        FileSpec('fo', fo, f'{ARCHIVES}/content/fo/{fo}.zip', '.csv'),
        FileSpec('cm', cm, f'{ARCHIVES}/content/cm/{cm}.zip', '.csv'),
    ]
    return out


def previous_weekday(day: date) -> date:
    d = day - timedelta(days=1)
    while d.weekday() >= 5:
        d -= timedelta(days=1)
    return d


def _plan(day: date) -> list[tuple[date, FileSpec]]:
    prev = previous_weekday(day)
    return [(day, f) for f in files_for(day)] + [(prev, f) for f in files_for(prev) if f.key in PREVIOUS_KEYS]


def _write_atomic(path: Path, data: bytes) -> None:
    tmp = path.with_name(path.name + '.tmp')
    try:
        tmp.write_bytes(data)
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def _gunzip(blob: bytes) -> bytes:
    """A gzip body unpacked; raises ValueError when it is corrupt or unpacks past MAX_BYTES."""
    try:
        with gzip.GzipFile(fileobj=io.BytesIO(blob)) as fh:
            data = fh.read(MAX_BYTES + 1)
    except (OSError, EOFError) as e:
        raise ValueError(f'not a gzip: {e}')
    if len(data) > MAX_BYTES:
        raise ValueError(f'unpacked file is over {MAX_BYTES} bytes')
    return data


def _extract(blob: bytes, suffix: str) -> bytes:
    """The bytes of the one member whose name ends with `suffix`; raises ValueError otherwise."""
    try:
        zf = zipfile.ZipFile(io.BytesIO(blob))
    except zipfile.BadZipFile as e:
        raise ValueError(f'not a zip: {e}')
    with zf:
        hits = [i for i in zf.infolist() if i.filename.endswith(suffix) and not i.is_dir()]
        if len(hits) != 1:
            raise ValueError(f'expected one {suffix} member, found {len(hits)}')
        info = hits[0]
        n = info.filename
        if '/' in n or '\\' in n or '..' in n:
            raise ValueError(f'refusing member name {n!r}')
        if info.file_size > MAX_BYTES:
            raise ValueError(f'member is {info.file_size} bytes, over {MAX_BYTES}')
        with zf.open(info) as fh:
            data = fh.read(MAX_BYTES + 1)  # the header size can lie
        if len(data) > MAX_BYTES:
            raise ValueError(f'member is over {MAX_BYTES} bytes')
        return data


def _load_manifest(path: Path, log: Callable[[str], None]) -> dict:
    if not path.exists():
        return {}
    try:
        m = json.loads(path.read_text())
        if isinstance(m, dict):
            return m
    except (OSError, ValueError):
        pass
    log(f'manifest {path} unreadable — starting empty')
    return {}


def run_once(day: date, fetch: Callable[[str], Optional[bytes]], root: Path,
             now: Callable[[], float], log: Callable[[str], None]) -> int:
    """Fetch what is not yet saved; returns the number of files saved. None from `fetch` = not yet."""
    saved = 0
    manifests: dict[date, dict] = {}
    for d, f in _plan(day):
        folder = root / d.isoformat()
        if d not in manifests:
            mp = folder / 'manifest.json'
            manifests[d] = _load_manifest(mp, log)
        manifest = manifests[d]
        if f.key in manifest:
            continue
        label = f'{d.isoformat()} {f.name}'
        try:
            blob = fetch(f.url)
            if blob is None:
                log(f'{label}: not yet')
                continue
            data = blob if f.member is None else _extract(blob, f.member)
            if f.member is None and data[:2] == b'\x1f\x8b':
                data = _gunzip(data)  # NSE serves ael_*.csv gzipped; files are saved unpacked
            if len(data) > MAX_BYTES:
                raise ValueError(f'file is {len(data)} bytes, over {MAX_BYTES}')
            folder.mkdir(parents=True, exist_ok=True)
            _write_atomic(folder / f.name, data)
            manifest[f.key] = {'name': f.name, 'url': f.url, 'savedAt': int(now() * 1000),
                               'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
            _write_atomic(folder / 'manifest.json', json.dumps(manifest, indent=2).encode())
            saved += 1
            log(f'{label}: saved')
        except Exception as e:  # one bad file must not stop the others
            manifest.pop(f.key, None)
            log(f'{label}: failed: {e}')
    for d in sorted({d for d, _ in _plan(day)}):
        history_step(root, d, log)
    return saved


# ---------------------------------------------------------------------------------------------------------------
# The daily history: one summary per trading day of the two bhavcopies (the UDiFF layout files_for names).

HISTORY = 'history'
FUTURES = ('STF', 'IDF')  # FinInstrmTp of a stock / index future in the F&O bhavcopy
OPTIONS = ('STO', 'IDO')
INDEX_TYPES = ('IDF', 'IDO')  # an index's futures and options: the symbols that get an "ic"
# The rows of one index all carry the same UndrlygPric (its closing value); they may differ by this much (a rounding
# of the last digit) before the day's "ic" is judged unreliable and left out.
IC_TOLERANCE = 0.01
FO_COLUMNS = ('FinInstrmTp', 'TckrSymb', 'XpryDt', 'StrkPric', 'OptnTp', 'OpnPric', 'HghPric', 'LwPric', 'ClsPric',
              'UndrlygPric', 'OpnIntrst', 'TtlTradgVol', 'NewBrdLotQty')
CM_COLUMNS = ('FinInstrmTp', 'TckrSymb', 'SctySrs', 'OpnPric', 'HghPric', 'LwPric', 'ClsPric', 'TtlTradgVol')
WALLS = 3
ISO_DAY = re.compile(r'\d{4}-\d{2}-\d{2}')
# A backfill looks at N + N/4 + 20 weekdays at most (NSE closes on ~15 weekdays a year) and stops after this many
# failed days in a row: a client NSE refuses fails every request, and asking on would not change that.
BACKFILL_MAX_FAILURES = 5
# Not-published (404) weekdays in a row after which a backfill stops: past UDiFF's first day (Jul 2024), or a client
# NSE answers 404 to, asking on changes nothing. NSE never closes this many weekdays running.
BACKFILL_MAX_UNPUBLISHED = 10
# Every IV that is ranked (the history's, the market context's live one, the vol job's) is the ATM IV of the first
# expiry at least this many calendar days out: a fixed tenor, so an expiry-eve option or an index's 1-day weekly never
# enters the series (docs/superpowers/specs/2026-10-23-traders-vol-addendum.md). scripts/nse_vol_job.py uses these.
IV_MIN_DAYS = 7


def iv_expiry(expiries, day: date) -> Optional[date]:
    """The first listed expiry at least IV_MIN_DAYS calendar days after `day`."""
    later = sorted(e for e in expiries if (e - day).days >= IV_MIN_DAYS)
    return later[0] if later else None


def next_month_expiry(expiries, near: date) -> Optional[date]:
    """The last listed expiry of the first calendar month after `near`'s: the term structure's second point."""
    y, m = (near.year + 1, 1) if near.month == 12 else (near.year, near.month + 1)
    same = [e for e in expiries if (e.year, e.month) == (y, m)]
    return max(same) if same else None


def _num(s: Optional[str]) -> Optional[float]:
    if s is None or s.strip() == '':
        return None
    try:
        x = float(s)
    except ValueError:
        return None
    return x if math.isfinite(x) else None


def _int(s: Optional[str]) -> int:
    x = _num(s)
    return int(x) if x is not None and x > 0 else 0


def _compact(x: float):
    """420.0 -> 420: whole strikes and prices are written as integers."""
    return int(x) if x == int(x) else x


def _csv(data: bytes, columns: tuple[str, ...], what: str) -> csv.DictReader:
    reader = csv.DictReader(io.StringIO(data.decode('utf-8-sig')))
    missing = [c for c in columns if c not in (reader.fieldnames or [])]
    if missing:
        raise ValueError(f'the {what} bhavcopy has no {", ".join(missing)} column')
    return reader


def _ohlc(r: dict) -> Optional[list[float]]:
    xs = [_num(r.get(c)) for c in ('OpnPric', 'HghPric', 'LwPric', 'ClsPric')]
    return [x for x in xs if x is not None] if all(x is not None and x > 0 for x in xs) else None


def _traded_close(r: dict):
    """An option's close only when it traded that day: an untraded row repeats an older close."""
    if _int(r.get('TtlTradgVol')) <= 0:
        return None
    c = _num(r.get('ClsPric'))
    return _compact(c) if c is not None and c > 0 else None


def _max_pain(chain: dict) -> Optional[float]:
    """The strike at which the expiry's open options would pay their holders least; a tie goes to the lower strike."""
    ce = [(k, _int(s['CE'].get('OpnIntrst'))) for k, s in chain.items() if 'CE' in s]
    pe = [(k, _int(s['PE'].get('OpnIntrst'))) for k, s in chain.items() if 'PE' in s]
    if sum(oi for _, oi in ce) + sum(oi for _, oi in pe) == 0:
        return None
    best = None
    for at in sorted(chain):
        pay = sum(oi * max(0.0, at - k) for k, oi in ce) + sum(oi * max(0.0, k - at) for k, oi in pe)
        if best is None or pay < best[1]:
            best = (at, pay)
    return best[0]


def _options(chain: dict, expiry: str, ref: Optional[float]) -> dict:
    """One expiry's OI totals, ATM closes (the strike listed both sides nearest `ref`), top OI strikes and max pain."""
    both = [k for k, s in chain.items() if 'CE' in s and 'PE' in s]
    atm = None
    if both and ref is not None:
        k = min(both, key=lambda x: (abs(x - ref), x))
        atm = {'strike': _compact(k), 'ce': _traded_close(chain[k]['CE']), 'pe': _traded_close(chain[k]['PE'])}
    walls = {}
    for side in ('CE', 'PE'):
        ois = [(k, _int(s[side].get('OpnIntrst'))) for k, s in chain.items() if side in s]
        top = sorted((x for x in ois if x[1] > 0), key=lambda x: (-x[1], x[0]))[:WALLS]
        walls[side.lower()] = [[_compact(k), oi] for k, oi in top]
    mp = _max_pain(chain)
    return {
        'expiry': expiry,
        'ceOi': sum(_int(s['CE'].get('OpnIntrst')) for s in chain.values() if 'CE' in s),
        'peOi': sum(_int(s['PE'].get('OpnIntrst')) for s in chain.values() if 'PE' in s),
        'atm': atm, 'walls': walls, 'maxPain': None if mp is None else _compact(mp),
    }


def _iv_atm(day: date, chains: dict, futs: Optional[list], ref: Optional[float]) -> Optional[dict]:
    """The fixed-tenor IV's ATM closes (the first expiry IV_MIN_DAYS or more out): the strike listed both sides nearest
    that expiry's own future close (else `ref`), with that close as `fut` (null when it lists no future: a weekly)."""
    near = iv_expiry([date.fromisoformat(e) for e in chains], day)
    if near is None:
        return None
    exp = near.isoformat()
    fc = None
    for e, r in futs or []:
        c = _num(r.get('ClsPric')) if e == exp else None
        if c is not None and c > 0:
            fc = _compact(c)
    at = fc if fc is not None else ref
    both = [k for k, s in chains[exp].items() if 'CE' in s and 'PE' in s]
    if not both or at is None:
        return None
    k = min(both, key=lambda x: (abs(x - at), x))
    return {'expiry': exp, 'strike': _compact(k), 'ce': _traded_close(chains[exp][k]['CE']),
            'pe': _traded_close(chains[exp][k]['PE']), 'fut': fc}


def summarize_day(day: date, cm: bytes, fo: bytes, log: Callable[[str], None] = lambda msg: None) -> dict:
    """One trading day's summary of every F&O underlying; ValueError when a file lacks a UDiFF column it reads.

    "Near" is the first expiry AFTER the trade date: on an expiry day the expiring series is gone by the time
    anyone reads the file, so its OI and its last-hours premium would describe nothing. An underlying with no
    cash row (an index: the CM file lists none) takes the near future's OHLC, marked "src": "fut", its volume in
    shares (contracts x lot, as the cash volume is). One with neither is left out: nothing is invented.

    An index entry also gets "ic", the index's closing value: the UndrlygPric of the index's own rows (futures and
    options, the expiring series too), which are all the same number. Rows that differ by more than IC_TOLERANCE, or
    that carry no price, give no "ic" and a line to `log`. "c" and every other field are as before.
    """
    trade = day.isoformat()
    futs: dict[str, list[tuple[str, dict]]] = {}
    opts: dict[str, dict[str, dict[float, dict[str, dict]]]] = {}
    under: dict[str, float] = {}
    index_rows: set[str] = set()
    index_close: dict[str, list[float]] = {}  # index -> [first, lowest, highest] UndrlygPric over its rows
    for r in _csv(fo, FO_COLUMNS, 'FO'):
        sym = (r.get('TckrSymb') or '').strip()
        exp = (r.get('XpryDt') or '').strip()
        tp = (r.get('FinInstrmTp') or '').strip()
        if sym != '' and tp in INDEX_TYPES:  # before the expiry test: the expiring series carries the close too
            index_rows.add(sym)
            iu = _num(r.get('UndrlygPric'))
            if iu is not None and iu > 0:
                seen = index_close.setdefault(sym, [iu, iu, iu])
                seen[1], seen[2] = min(seen[1], iu), max(seen[2], iu)
        if sym == '' or not ISO_DAY.fullmatch(exp) or exp <= trade:
            continue
        u = _num(r.get('UndrlygPric'))
        if u is not None and u > 0:
            under.setdefault(sym, u)
        if tp in FUTURES:
            futs.setdefault(sym, []).append((exp, r))
        elif tp in OPTIONS:
            k = _num(r.get('StrkPric'))
            side = (r.get('OptnTp') or '').strip()
            if k is not None and k > 0 and side in ('CE', 'PE'):
                opts.setdefault(sym, {}).setdefault(exp, {}).setdefault(k, {})[side] = r
    symbols = set(futs) | set(opts)

    cash: dict[str, dict] = {}
    for r in _csv(cm, CM_COLUMNS, 'CM'):
        sym = (r.get('TckrSymb') or '').strip()
        if (r.get('FinInstrmTp') or '').strip() != 'STK' or sym not in symbols:
            continue
        # the EQ series wins; with none, the first row seen
        if sym not in cash or ((r.get('SctySrs') or '').strip() == 'EQ' and (cash[sym].get('SctySrs') or '').strip() != 'EQ'):
            cash[sym] = r

    ic: dict[str, float] = {}
    for sym in sorted(index_rows & symbols):
        seen = index_close.get(sym)
        if seen is None:
            log(f'history {trade}: {sym}: no UndrlygPric in its rows - no ic')
        elif seen[2] - seen[1] > IC_TOLERANCE + 1e-9:
            log(f'history {trade}: {sym}: UndrlygPric differs between rows ({seen[1]} to {seen[2]}) - no ic')
        else:
            ic[sym] = _compact(seen[0])

    out: dict[str, dict] = {}
    for sym in sorted(symbols):
        near_fut = min(futs[sym], key=lambda x: x[0]) if sym in futs else None
        fut = None
        if near_fut is not None:
            fc = _num(near_fut[1].get('ClsPric'))
            if fc is not None and fc > 0:
                fut = {'expiry': near_fut[0], 'c': _compact(fc), 'oi': _int(near_fut[1].get('OpnIntrst'))}
        cash_ohlc = _ohlc(cash[sym]) if sym in cash else None
        fut_ohlc = _ohlc(near_fut[1]) if near_fut is not None else None
        if cash_ohlc is not None:
            o, h, l, c = cash_ohlc
            entry: dict = {'o': _compact(o), 'h': _compact(h), 'l': _compact(l), 'c': _compact(c),
                           'v': _int(cash[sym].get('TtlTradgVol'))}
            pc = _num(cash[sym].get('PrvsClsgPric'))
        elif fut_ohlc is not None:
            o, h, l, c = fut_ohlc
            lot = _int(near_fut[1].get('NewBrdLotQty'))
            entry = {'o': _compact(o), 'h': _compact(h), 'l': _compact(l), 'c': _compact(c),
                     'v': _int(near_fut[1].get('TtlTradgVol')) * lot, 'src': 'fut'}
            pc = _num(near_fut[1].get('PrvsClsgPric'))
        else:
            continue
        # NSE's previous close: adjusted on an ex-date, and a future's is its own contract's. HistoryStore back-adjusts
        # the older bars when it is not the previous day's close.
        if pc is not None and pc > 0:
            entry['pc'] = _compact(pc)
        entry['fut'] = fut
        chains = opts.get(sym)
        if chains:
            exp = min(chains)
            ref = fut['c'] if fut is not None else under.get(sym, entry['c'])
            entry['opt'] = _options(chains[exp], exp, ref)
            entry['ivAtm'] = _iv_atm(day, chains, futs.get(sym), under.get(sym, entry['c']))
        else:
            entry['opt'] = None
            entry['ivAtm'] = None
        if sym in ic:
            entry['ic'] = ic[sym]
        out[sym] = entry
    return {'date': trade, 'symbols': out}


def _bhav_specs(d: date) -> tuple[FileSpec, FileSpec]:
    """The day's CM and FO bhavcopies, as files_for names them."""
    by_key = {f.key: f for f in files_for(d)}
    return by_key['cm'], by_key['fo']


def _write_history(root: Path, summary: dict) -> Path:
    folder = root / HISTORY
    folder.mkdir(parents=True, exist_ok=True)
    out = folder / f"{summary['date']}.json"
    _write_atomic(out, json.dumps(summary, separators=(',', ':')).encode())
    return out


def _history_doc(path: Path) -> Optional[dict]:
    """A history file's document; None when it is missing, unreadable or not a day's summary."""
    try:
        doc = json.loads(path.read_text())
    except (OSError, ValueError):
        return None
    return doc if isinstance(doc, dict) and isinstance(doc.get('symbols'), dict) else None


def _has_index_close(path: Path) -> bool:
    """True when some entry of the history file carries an "ic": the file is already as the rewrite would leave it."""
    doc = _history_doc(path)
    return doc is not None and any(isinstance(e, dict) and 'ic' in e for e in doc['symbols'].values())


def _add_index_close(root: Path, summary: dict, log: Callable[[str], None]) -> int:
    """Add the fresh `summary`'s "ic" to the day's existing history file; returns how many entries got one.

    Only the "ic" of entries the file already has is touched: "c" and every other field stay exactly as they were
    written, whichever version of this job wrote them. A file that cannot be read, or that is not that day's, is
    replaced by the fresh summary. When the summary has no "ic" at all the file is left alone.
    """
    label = summary['date']
    path = root / HISTORY / f'{label}.json'
    fresh = {sym: e['ic'] for sym, e in summary['symbols'].items() if 'ic' in e}
    doc = _history_doc(path)
    if doc is None or doc.get('date') != label:
        log(f'history {label}: the file on disk is not a day summary - replaced')
        _write_history(root, summary)
        return len(fresh)
    added = 0
    for sym, ic in fresh.items():
        entry = doc['symbols'].get(sym)
        if isinstance(entry, dict):
            entry['ic'] = ic
            added += 1
    if added:
        _write_history(root, doc)
    return added


def history_step(root: Path, d: date, log: Callable[[str], None]) -> bool:
    """history/<d>.json from the day's two saved bhavcopies, once both are there; True when written. Never raises."""
    try:
        if (root / HISTORY / f'{d.isoformat()}.json').exists():
            return False
        cm, fo = (root / d.isoformat() / f.name for f in _bhav_specs(d))
        if not (cm.is_file() and fo.is_file()):
            return False
        summary = summarize_day(d, cm.read_bytes(), fo.read_bytes(), log)
        _write_history(root, summary)
        log(f"history {d.isoformat()}: written, {len(summary['symbols'])} symbols")
        return True
    except Exception as e:  # the downloads above are saved either way; the next run tries again
        log(f'history {d.isoformat()}: failed: {e}')
        return False


UNPUBLISHED = 'unpublished.json'
# A day recorded as not published is asked again only this close to the backfill's end: a recent one may come late.
UNPUBLISHED_RECHECK_DAYS = 7


def read_unpublished(root: Path) -> set[str]:
    """history/unpublished.json's days: weekdays NSE published no bhavcopy for (holidays), which HistoryStore treats as
    no session when it decides whether two bars are consecutive trading days."""
    try:
        doc = json.loads((root / HISTORY / UNPUBLISHED).read_text())
        days = doc.get('days') if isinstance(doc, dict) else None
        return {d for d in (days or []) if isinstance(d, str) and ISO_DAY.fullmatch(d)}
    except (OSError, ValueError):
        return set()


def _write_unpublished(root: Path, days: set[str]) -> None:
    folder = root / HISTORY
    folder.mkdir(parents=True, exist_ok=True)
    _write_atomic(folder / UNPUBLISHED, json.dumps({'days': sorted(days)}, separators=(',', ':')).encode())


class Backfill(NamedTuple):
    written: int
    #: why it stopped short (failed days, or not-published days, in a row); None when it ran its course
    stopped: Optional[str]


def backfill_history(n: int, fetch: Callable[[str], Optional[bytes]], root: Path, end: date,
                     log: Callable[[str], None], sleep: Callable[[float], None], delay: float = 1.0,
                     rewrite: bool = False) -> Backfill:
    """The summaries of the last `n` trading days up to `end`: how many it wrote, and why it stopped short if it did.

    Weekdays are walked back from `end`. A day already summarised counts and costs nothing; one whose two
    bhavcopies are still in its dated folder is read from disk; otherwise both are downloaded, CM first: a 404
    there is a holiday (or a day not yet published) and its FO file is not asked for. Such a day is recorded in
    history/unpublished.json and not asked for again unless it is within a week of `end`. The downloads stay in
    memory. `sleep(delay)` comes before every request but the first. BACKFILL_MAX_UNPUBLISHED not-published weekdays
    in a row stop it; a day it already has breaks the row, so scattered holidays never add up across a re-run.

    With `rewrite`, a day already summarised whose file has no "ic" is read again the same way (disk first, then
    NSE, the same pauses and the same stops) and the file gets its "ic" (_add_index_close); it counts as written.
    One whose bhavcopies NSE does not serve now is kept as it is, and not recorded as unpublished: it has a file.
    A file that already has an "ic" costs nothing, so a stopped run is started again where it left off.
    """
    known = read_unpublished(root)
    record = set(known)
    have = written = scanned = failures = unpublished = kept = 0
    stopped: Optional[str] = None
    limit = n + n // 4 + 20
    asked = False
    d = end
    while have < n and scanned < limit:
        if d.weekday() >= 5:
            d -= timedelta(days=1)
            continue
        scanned += 1
        label = d.isoformat()
        try:
            on_disk = (root / HISTORY / f'{label}.json').exists()
            if on_disk and not (rewrite and not _has_index_close(root / HISTORY / f'{label}.json')):
                have += 1
                unpublished = 0
            elif not on_disk and label in known and (end - d).days > UNPUBLISHED_RECHECK_DAYS:
                unpublished += 1
                log(f'{label}: not published (recorded) - skipped')
                if unpublished >= BACKFILL_MAX_UNPUBLISHED:
                    stopped = f'{unpublished} weekdays in a row not published (before UDiFF, or NSE answering 404?)'
                    log(f'backfill: stopping: {stopped}')
                    break
            else:
                blobs: dict[str, bytes] = {}
                for f in _bhav_specs(d):
                    local = root / label / f.name
                    if local.is_file():
                        blobs[f.key] = local.read_bytes()
                        continue
                    if asked:
                        sleep(delay)
                    asked = True
                    blob = fetch(f.url)
                    if blob is None:
                        break
                    blobs[f.key] = _extract(blob, f.member or '.csv')
                if len(blobs) < 2 and on_disk:
                    kept += 1
                    have += 1
                    unpublished = 0
                    log(f'{label}: bhavcopies not available - history kept as it is, no ic')
                elif len(blobs) < 2:
                    unpublished += 1
                    record.add(label)
                    log(f'{label}: not published (a holiday?) - skipped')
                    if unpublished >= BACKFILL_MAX_UNPUBLISHED:
                        stopped = f'{unpublished} weekdays in a row not published (before UDiFF, or NSE answering 404?)'
                        log(f'backfill: stopping: {stopped}')
                        break
                else:
                    unpublished = 0
                    record.discard(label)
                    summary = summarize_day(d, blobs['cm'], blobs['fo'], log)
                    have += 1
                    if not on_disk:
                        _write_history(root, summary)
                        written += 1
                        log(f"{label}: written, {len(summary['symbols'])} symbols ({have} of {n})")
                    elif _add_index_close(root, summary, log):
                        written += 1
                        log(f'{label}: rewritten with ic ({have} of {n})')
                    else:
                        log(f'{label}: no ic to add, history kept as it is ({have} of {n})')
            failures = 0
        except Exception as e:
            failures += 1
            log(f'{label}: failed: {e}')
            if failures >= BACKFILL_MAX_FAILURES:
                stopped = f'{failures} failed days in a row (is NSE refusing this client?)'
                log(f'backfill: stopping after {stopped}')
                break
        d -= timedelta(days=1)
    if record != known:
        try:
            _write_unpublished(root, record)
        except OSError as e:
            log(f'{UNPUBLISHED}: not written: {e}')
    log(f'backfill: {have} of {n} days present ({written} written, {scanned} weekdays looked at)'
        + (f', {kept} kept without ic' if kept else ''))
    return Backfill(written, stopped)


def prune(root: Path, today: date, keep_days: int = 7) -> list[str]:
    """Remove dated folders older than today - keep_days; anything not named YYYY-MM-DD is left alone."""
    cutoff = today - timedelta(days=keep_days)
    removed = []
    if not root.is_dir():
        return removed
    for p in sorted(root.iterdir()):
        if p.is_symlink() or not p.is_dir() or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', p.name):
            continue
        try:
            d = date.fromisoformat(p.name)
        except ValueError:
            continue
        if d < cutoff:
            shutil.rmtree(p)
            removed.append(p.name)
    return removed


def nse_fetcher() -> Callable[[str], Optional[bytes]]:
    """GET raw bytes with the session headers nsepythonserver carries (V-J1: verify on the first manual run)."""
    import urllib.error
    import urllib.request

    import nsepythonserver  # lazy: the venv has it, the tests do not

    headers = dict(getattr(nsepythonserver, 'headers', None) or {'User-Agent': 'Mozilla/5.0'})

    def fetch(url: str) -> Optional[bytes]:
        req = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read(MAX_BYTES + 1)
        except urllib.error.HTTPError as e:
            if e.code == 404:  # not published yet; a 403 is a blocked client and must read as a failure
                return None
            raise RuntimeError(f'HTTP {e.code}') from e

    return fetch


def _default_root() -> Path:
    return Path(os.environ.get('TRADERS_NSE_DIR') or Path(__file__).resolve().parent.parent / 'data' / 'nse')


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--dir', type=Path, default=None)
    ap.add_argument('--date', type=date.fromisoformat, default=None)
    ap.add_argument('--backfill-history', type=int, default=None, metavar='N',
                    help='write the history summaries of the last N trading days up to --date, and nothing else')
    ap.add_argument('--delay', type=float, default=1.0, help='seconds between two backfill requests (default 1)')
    ap.add_argument('--rewrite', action='store_true',
                    help='with --backfill-history: also re-read the days already summarised that have no ic, and add it')
    args = ap.parse_args(argv)
    root = args.dir or _default_root()
    day = args.date or datetime.now(IST).date()

    def log(msg: str) -> None:
        print(msg, flush=True)

    if args.rewrite and args.backfill_history is None:
        log('--rewrite goes with --backfill-history N')
        return 2
    if args.backfill_history is not None:
        if args.backfill_history < 1 or args.delay < 0:
            log('--backfill-history takes N >= 1, and --delay a number of seconds >= 0')
            return 2
        try:
            result = backfill_history(args.backfill_history, nse_fetcher(), root, day, log, time.sleep,
                                      delay=args.delay, rewrite=args.rewrite)
        except Exception as e:
            log(f'unexpected: {e!r}')
            return 1
        return 0 if result.stopped is None else 1

    try:
        run_once(day, nse_fetcher(), root, time.time, log)
        for name in prune(root, day):
            log(f'pruned {name}')
    except Exception as e:
        log(f'unexpected: {e!r}')
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
