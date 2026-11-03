"""Tests for nse_vol_job.py: fixtures in scripts/fixtures/nse_vol, injected fetchers, no network.

Run from the repo root:  python3 -I scripts/test_nse_vol_job.py -v
"""
import importlib.util
import json
import sys
import tempfile
import unittest
from datetime import date, datetime, timezone
from pathlib import Path
from unittest import mock

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
FIX = HERE / 'fixtures' / 'nse_vol'
spec = importlib.util.spec_from_file_location('nse_vol_job', HERE / 'nse_vol_job.py')
job = importlib.util.module_from_spec(spec)
sys.modules['nse_vol_job'] = job
spec.loader.exec_module(job)

DAY = date(2026, 10, 22)  # a Thursday: 27 Oct is 5 days out, short of the 7-day tenor, so near is November
FO_NAME = 'BhavCopy_NSE_FO_0_0_0_20261022_F_0000.csv'
CMVOLT_URL = 'https://nsearchives.nseindia.com/archives/nsccl/volt/CMVOLT_22102026.CSV'
V3_NOV = 'https://www.nseindia.com/api/option-chain-v3?type=Equity&symbol=TCS&expiry=23-Nov-2026'
V3_DEC = 'https://www.nseindia.com/api/option-chain-v3?type=Equity&symbol=TCS&expiry=29-Dec-2026'
WRITTEN_AT = 1_792_670_000.25  # seconds; written as epoch ms


def fixture(name: str) -> str:
    return (FIX / name).read_text()


class Json:
    """A fake NSE JSON fetcher: url -> payload, or an exception to raise."""

    def __init__(self, served: dict):
        self.served = served
        self.urls: list[str] = []

    def __call__(self, url: str):
        self.urls.append(url)
        v = self.served.get(url)
        if isinstance(v, Exception):
            raise v
        if v is None:
            raise RuntimeError(f'nsefetch {url}: HTTP 404')
        return v


class Bytes:
    def __init__(self, served: dict):
        self.served = served
        self.urls: list[str] = []

    def __call__(self, url: str):
        self.urls.append(url)
        v = self.served.get(url)
        if isinstance(v, Exception):
            raise v
        return v


def nse_served() -> dict:
    return {V3_NOV: json.loads(fixture('v3_TCS_23-Nov-2026.json')),
            V3_DEC: json.loads(fixture('v3_TCS_29-Dec-2026.json'))}


class ExpiryRules(unittest.TestCase):
    def test_near_is_the_first_expiry_a_week_or_more_out_and_next_the_following_month(self):
        months = [date(2026, 10, 27), date(2026, 11, 23), date(2026, 12, 29)]
        self.assertEqual(job.near_next(date(2026, 10, 22), months), (date(2026, 11, 23), date(2026, 12, 29), True))
        self.assertEqual(job.near_next(date(2026, 10, 20), months), (date(2026, 10, 27), date(2026, 11, 23), False))
        self.assertEqual(job.near_next(date(2026, 10, 22), months[:2]), (date(2026, 11, 23), None, True))
        self.assertEqual(job.near_next(date(2026, 10, 22), []), (None, None, False))

    def test_an_index_weekly_a_week_out_is_near_and_next_is_the_next_months_last(self):
        listed = [date(2026, 10, 20), date(2026, 10, 27), date(2026, 11, 3), date(2026, 11, 10), date(2026, 11, 24), date(2026, 12, 29)]
        self.assertEqual(job.near_next(date(2026, 10, 19), listed), (date(2026, 10, 27), date(2026, 11, 24), True))


class Parsers(unittest.TestCase):
    def test_fo_bhavcopy_keeps_the_asked_symbols_and_only_traded_closes(self):
        fo = job.parse_fo(fixture('fo.csv'), {'TCS'})
        self.assertEqual(set(fo), {'TCS'})
        t = fo['TCS']
        self.assertEqual(t['spot'], 2506.46)
        # an untraded future is read at its settlement price, a traded one at its close
        self.assertEqual(t['fut'], {date(2026, 10, 27): 2505.2, date(2026, 11, 23): 2521.0, date(2026, 12, 29): 2536.5})
        nov = t['opt'][date(2026, 11, 23)]
        self.assertEqual(nov[2500.0], [85.0, 62.0])
        self.assertEqual(nov[2520.0], [None, 71.0])  # the CE did not trade: its close is yesterday's, not today's
        self.assertEqual(nov[2300.0], [None, 19.5])

    def test_cmvolt_reads_daily_and_annual_by_header_and_skips_dashes(self):
        v = job.parse_cmvolt(fixture('cmvolt.csv'))
        self.assertEqual(v['TCS'], [0.0181, 0.3458])
        self.assertEqual(v['M&M'], [0.015, 0.2866])
        self.assertNotIn('ZEL', v)

    def test_cmvolt_without_the_columns_is_refused(self):
        with self.assertRaises(ValueError):
            job.parse_cmvolt('Date,Symbol,Close\n22-OCT-2026,TCS,1\n')

    def test_v3_ivs_are_decimals_and_a_zero_is_no_iv(self):
        ivs, spot = job.parse_v3(json.loads(fixture('v3_TCS_23-Nov-2026.json')), date(2026, 11, 23), DAY)
        self.assertEqual(spot, 2506.9)
        self.assertEqual(ivs[2500.0], [0.231, 0.269])
        self.assertEqual(ivs[2520.0], [None, 0.274])
        self.assertEqual(ivs[2300.0], [None, 0.312])
        self.assertEqual(len(ivs), 4, 'the October row in the payload is not November\'s')

    def test_v3_from_another_day_is_refused(self):
        with self.assertRaisesRegex(ValueError, 'chain is for 2026-10-22'):
            job.parse_v3(json.loads(fixture('v3_TCS_23-Nov-2026.json')), date(2026, 11, 23), date(2026, 10, 23))

    def test_urls(self):
        self.assertEqual(job.v3_url('TCS', date(2026, 11, 23)), V3_NOV)
        self.assertEqual(job.v3_url('M&M', date(2026, 11, 23)),
                         'https://www.nseindia.com/api/option-chain-v3?type=Equity&symbol=M%26M&expiry=23-Nov-2026')
        self.assertEqual(job.v3_url('NIFTY', date(2026, 11, 24)),
                         'https://www.nseindia.com/api/option-chain-v3?type=Indices&symbol=NIFTY&expiry=24-Nov-2026')
        self.assertEqual(job.cmvolt_url(DAY), CMVOLT_URL)


class Run(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        self.lines: list[str] = []
        (self.root / '2026-10-22').mkdir()
        (self.root / '2026-10-22' / FO_NAME).write_text(fixture('fo.csv'))

    def run_job(self, nse=None, archive=None, symbols=('TCS',), live=True, dry_run=False, expiries=None):
        self.nse = Json(nse_served() if nse is None else nse)
        self.archive = Bytes({CMVOLT_URL: fixture('cmvolt.csv').encode()} if archive is None else archive)
        self.expiries = Json(expiries or {})
        return job.run(DAY, root=self.root, symbols=list(symbols), fetch_json=self.nse, fetch_bytes=self.archive,
                       fetch_expiries=self.expiries, now=lambda: WRITTEN_AT, log=self.lines.append,
                       live=live, dry_run=dry_run, sleep=lambda s: None)

    def written(self) -> dict:
        return json.loads((self.root / 'vol' / '2026-10-22.json').read_text())

    def test_writes_near_and_next_from_the_bhavcopy_and_nse(self):
        self.run_job()
        doc = self.written()
        self.assertEqual(doc['v'], 1)
        self.assertEqual(doc['date'], '2026-10-22')
        self.assertEqual(doc['writtenAt'], 1_792_670_000_250)
        self.assertEqual(doc['cmvolt']['file'], 'CMVOLT_22102026.CSV')
        self.assertEqual(doc['cmvolt']['symbols']['TCS'], [0.0181, 0.3458])
        t = doc['stocks']['TCS']
        self.assertEqual(t['spot'], 2506.46)
        self.assertEqual(t['sources'], ['bhavcopy', 'nse'])
        self.assertEqual(t['errors'], [])
        self.assertEqual([t['near']['expiry'], t['near']['rolled'], t['near']['future']], ['2026-11-23', True, 2521.0])
        self.assertEqual(t['next']['expiry'], '2026-12-29')
        # [strike, CE close, PE close, CE IV, PE IV], strikes within 30% of the future, ascending
        self.assertEqual(t['near']['strikes'], [
            [2300.0, None, 19.5, None, 0.312],
            [2500.0, 85.0, 62.0, 0.231, 0.269],
            [2520.0, None, 71.0, None, 0.274],
            [2700.0, 21.0, None, 0.225, None],
        ])
        self.assertEqual(t['next']['strikes'], [[2500.0, 118.0, 88.0, None, None]], 'the next month: the bhavcopy alone')
        self.assertEqual(self.nse.urls, [V3_NOV], 'one NSE call a stock: the near expiry')
        self.assertEqual(list((self.root / 'vol').iterdir()), [self.root / 'vol' / '2026-10-22.json'], 'no tmp file left')

    def test_one_symbol_failing_at_nse_keeps_its_bhavcopy_and_the_others(self):
        served = nse_served()
        served['https://www.nseindia.com/api/option-chain-v3?type=Equity&symbol=INFY&expiry=23-Nov-2026'] = RuntimeError('nsefetch: HTTP 403')
        self.run_job(nse=served, symbols=('INFY', 'TCS'))
        doc = self.written()
        self.assertEqual(doc['stocks']['TCS']['sources'], ['bhavcopy', 'nse'])
        infy = doc['stocks']['INFY']
        self.assertEqual(infy['sources'], ['bhavcopy'])
        self.assertTrue(any('HTTP 403' in e for e in infy['errors']), infy['errors'])

    def test_nse_stops_after_three_failures_in_a_row(self):
        # TCS's chain refused, INFY's not served, M&M's expiry list refused: three in a row; SBIN is never asked
        self.run_job(nse={V3_NOV: RuntimeError('nsefetch: HTTP 403')}, symbols=('TCS', 'INFY', 'M&M', 'SBIN'))
        self.assertEqual(len(self.nse.urls), 2)
        self.assertEqual(self.expiries.urls, ['M&M'])
        self.assertTrue(any('skipped' in e for e in self.written()['stocks']['SBIN']['errors']))
        self.assertTrue(any('3 NSE failures in a row' in line for line in self.lines), self.lines)

    def test_a_soft_block_answer_counts_as_a_failure(self):
        # NSE answers 200 with {} (Akamai's soft block): unusable, so it counts toward the trip like a 403
        infy = 'https://www.nseindia.com/api/option-chain-v3?type=Equity&symbol=INFY&expiry=23-Nov-2026'
        self.run_job(nse={V3_NOV: {}, infy: {}}, symbols=('INFY', 'M&M', 'SBIN', 'TCS'), expiries={'M&M': []})
        # INFY's {}, M&M's empty expiry list and SBIN's unserved one make three in a row: TCS is never asked
        self.assertEqual(self.nse.urls, [infy])
        self.assertEqual(self.expiries.urls, ['M&M', 'SBIN'])
        self.assertTrue(any('no records' in e for e in self.written()['stocks']['INFY']['errors']))
        self.assertTrue(any('no expiries' in e for e in self.written()['stocks']['M&M']['errors']))
        self.assertTrue(any('skipped' in e for e in self.written()['stocks']['TCS']['errors']))

    def test_a_stale_chain_stops_nse_for_everyone_at_once(self):
        # a weekday holiday: the chain is the last session's, for every symbol, so one is enough to know
        stale = json.loads(fixture('v3_TCS_23-Nov-2026.json'))
        stale['records']['timestamp'] = '21-Oct-2026 15:40:00'
        self.run_job(nse={'https://www.nseindia.com/api/option-chain-v3?type=Equity&symbol=INFY&expiry=23-Nov-2026': stale},
                     symbols=('INFY', 'TCS'))
        self.assertEqual(len(self.nse.urls), 1)
        doc = self.written()
        self.assertTrue(any('chain is for 2026-10-21' in e for e in doc['stocks']['INFY']['errors']))
        self.assertTrue(any('skipped' in e for e in doc['stocks']['TCS']['errors']))
        self.assertEqual(doc['stocks']['TCS']['sources'], ['bhavcopy'])

    def test_nse_is_asked_about_40_stocks_at_most(self):
        with mock.patch.object(job, 'NSE_MAX_STOCKS', 1):
            self.run_job(symbols=('INFY', 'TCS'))
        self.assertEqual(self.nse.urls, ['https://www.nseindia.com/api/option-chain-v3?type=Equity&symbol=INFY&expiry=23-Nov-2026'])
        doc = self.written()
        self.assertEqual(doc['stocks']['TCS']['sources'], ['bhavcopy'])
        self.assertTrue(any('over the 1-stock NSE cap' in e and 'TCS' in e for e in doc['errors']), doc['errors'])

    def test_not_live_reads_no_nse_chain(self):
        self.run_job(live=False)
        self.assertEqual(self.nse.urls, [])
        t = self.written()['stocks']['TCS']
        self.assertEqual(t['sources'], ['bhavcopy'])
        self.assertEqual(t['near']['strikes'][1], [2500.0, 85.0, 62.0, None, None])

    def test_without_the_bhavcopy_nse_gives_the_expiries_and_ivs(self):
        (self.root / '2026-10-22' / FO_NAME).unlink()
        exp = {'TCS': [date(2026, 10, 27), date(2026, 11, 23), date(2026, 12, 29)]}
        self.run_job(expiries=exp)
        t = self.written()['stocks']['TCS']
        self.assertEqual(t['sources'], ['nse'])
        self.assertEqual(t['spot'], 2506.9)
        self.assertEqual(t['near']['future'], None)
        self.assertEqual(t['near']['strikes'][1], [2500.0, None, None, 0.231, 0.269])
        self.assertTrue(any('bhavcopy' in line for line in self.lines))

    def test_cmvolt_missing_is_an_error_not_a_crash(self):
        self.run_job(archive={})
        doc = self.written()
        self.assertIsNone(doc['cmvolt'])
        self.assertTrue(any('CMVOLT' in e for e in doc['errors']), doc['errors'])
        self.assertEqual(doc['stocks']['TCS']['sources'], ['bhavcopy', 'nse'])

    def test_dry_run_writes_nothing(self):
        doc = self.run_job(dry_run=True)
        self.assertFalse((self.root / 'vol').exists())
        self.assertEqual(doc['stocks']['TCS']['near']['expiry'], '2026-11-23')
        self.assertTrue(any(line.startswith('TCS:') for line in self.lines), self.lines)

    def test_nothing_found_writes_nothing(self):
        (self.root / '2026-10-22' / FO_NAME).unlink()
        doc = self.run_job(nse={}, archive={}, live=False)
        self.assertIsNone(doc)
        self.assertFalse((self.root / 'vol').exists())

    def test_the_document_is_the_golden_file_the_app_reads(self):
        # apps/traders/test/vol-store.test.ts reads this same file: the two sides of the contract are pinned together
        golden = json.loads((HERE.parent / 'apps/traders/test/fixtures/vol/2026-10-22.json').read_text())
        doc = self.run_job(symbols=('INFY', 'TCS'), dry_run=True)
        self.assertEqual(json.loads(json.dumps(doc)), golden)

    def test_a_symbol_the_bhavcopy_lacks_is_an_error_for_that_symbol(self):
        self.run_job(symbols=('TCS', 'NOPE'), live=False)
        doc = self.written()
        self.assertEqual(doc['stocks']['NOPE']['sources'], [])
        self.assertTrue(doc['stocks']['NOPE']['errors'])


class Held(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        self.lines: list[str] = []

    def test_reads_held_stocks_and_drops_bad_names(self):
        (self.root / 'held.json').write_text(json.dumps({'asOf': '2026-10-22T14:00:00.000Z', 'stocks': ['TCS', 'M&M', '../x', 7, 'tcs']}))
        self.assertEqual(job.read_held(self.root, self.lines.append), ['M&M', 'TCS'])

    def test_missing_or_bad_held_file_is_an_empty_list(self):
        self.assertEqual(job.read_held(self.root, self.lines.append), [])
        (self.root / 'held.json').write_text('{')
        self.assertEqual(job.read_held(self.root, self.lines.append), [])
        self.assertTrue(self.lines)


class Prune(unittest.TestCase):
    def test_keeps_recent_files_and_leaves_other_names(self):
        with tempfile.TemporaryDirectory() as d:
            vol = Path(d) / 'vol'
            vol.mkdir()
            for n in ['2025-01-01.json', '2026-10-01.json', 'notes.txt', '2025-13-01.json']:
                (vol / n).write_text('{}')
            self.assertEqual(job.prune_vol(Path(d), DAY, keep_days=400), ['2025-01-01.json'])
            self.assertEqual(sorted(p.name for p in vol.iterdir()), ['2025-13-01.json', '2026-10-01.json', 'notes.txt'])


NOW = datetime(2026, 10, 24, 9, 30, tzinfo=timezone.utc)
CAL_URL = 'https://www.nseindia.com/api/event-calendar?index=equities'


def bm_url(sym: str) -> str:
    return (f'https://www.nseindia.com/api/corporate-board-meetings?index=equities&symbol={sym}'
            f'&from_date=19-09-2025&to_date=24-10-2026')


class Events(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        self.lines: list[str] = []
        self.cal = json.loads(fixture('events-calendar.json'))
        self.bm = json.loads(fixture('events-board-meetings-TCS.json'))

    def step(self, served, symbols=('TCS',), now=NOW, dry_run=False):
        self.nse = Json(served)
        return job.events_step(self.root, list(symbols), fetch_json=self.nse, now=now, log=self.lines.append,
                               dry_run=dry_run, sleep=lambda s: None)

    def file(self) -> dict:
        return json.loads((self.root / 'events.json').read_text())

    def history(self, *syms):
        (self.root / 'history').mkdir(exist_ok=True)
        (self.root / 'history' / '2026-10-23.json').write_text(json.dumps({'date': '2026-10-23', 'symbols': {s: {} for s in syms}}))

    def test_calendar_keeps_results_rows_with_iso_dates_sorted_and_deduped(self):
        self.cal.append(dict(self.cal[0]))                                                       # same symbol and date again
        self.cal.append({**self.cal[0], 'purpose': 'Financial Results/Dividend', 'date': '25-Oct-2026'})  # same day, other wording
        self.cal.append({**self.cal[0], 'date': '24-Oct-2026'})
        doc = self.step({CAL_URL: self.cal, bm_url('TCS'): self.bm})
        self.assertEqual([r['date'] for r in doc['upcoming']['MARUTI']], ['2026-10-24', '2026-10-25', '2026-10-27'])
        self.assertEqual(doc['upcoming']['M&M'], [{'date': '2026-11-05', 'purpose': 'Financial Results/Other business matters'}])
        self.assertEqual(doc['upcoming']['BHARATCOAL'], [{'date': '2026-10-25', 'purpose': 'Financial Results'}])
        self.assertNotIn('NDTV', doc['upcoming'])    # Fund Raising
        self.assertNotIn('NAUKRI', doc['upcoming'])  # Dividend
        self.assertEqual(list(doc['upcoming']), sorted(doc['upcoming']))

    def test_calendar_is_restricted_to_the_symbols_of_the_newest_history_file(self):
        self.history('MARUTI', 'M&M')
        (self.root / 'history' / '2026-10-01.json').write_text(json.dumps({'symbols': {'ABREL': {}}}))  # older: ignored
        doc = self.step({CAL_URL: self.cal, bm_url('TCS'): self.bm})
        self.assertEqual(sorted(doc['upcoming']), ['M&M', 'MARUTI'])

    def test_without_a_history_file_every_symbol_is_kept(self):
        doc = self.step({CAL_URL: self.cal, bm_url('TCS'): self.bm})
        self.assertIn('ABREL', doc['upcoming'])

    def test_past_has_one_entry_per_date_and_the_intimation_rows_drop(self):
        doc = self.step({CAL_URL: self.cal, bm_url('TCS'): self.bm})
        self.assertEqual(doc['past']['TCS'], {'fetched': '2026-10-24T09:30:00Z', 'meetings': [
            {'date': '2025-10-09', 'purpose': 'Financial Results/Dividend'},
            {'date': '2026-01-12', 'purpose': 'Financial Results/Dividend'},
            {'date': '2026-04-09', 'purpose': 'Financial Results/Dividend'},
            {'date': '2026-07-09', 'purpose': 'Financial Results/Dividend'},
            {'date': '2026-10-08', 'purpose': 'Financial Results/Dividend'}]})
        self.assertEqual(doc['v'], 1)
        self.assertEqual(doc['writtenAt'], '2026-10-24T09:30:00Z')
        self.assertEqual(doc['errors'], [])
        self.assertEqual(self.nse.urls, [CAL_URL, bm_url('TCS')])

    def test_indices_are_skipped_symbols_are_encoded_and_40_stocks_is_the_cap(self):
        syms = ['NIFTY', 'BANKNIFTY', 'M&M'] + [f'S{i:02d}' for i in range(45)]
        served = {CAL_URL: self.cal, bm_url('M%26M'): []}
        served.update({bm_url(f'S{i:02d}'): [] for i in range(45)})
        doc = self.step(served, symbols=syms)
        self.assertEqual(len(self.nse.urls), 1 + 40)
        self.assertIn(bm_url('M%26M'), self.nse.urls)
        self.assertNotIn('NIFTY', doc['past'])
        self.assertEqual(doc['errors'], ['6 held stocks over the 40-stock cap'])

    def test_a_fresh_entry_is_reused_without_a_request_and_an_old_one_is_refetched(self):
        fresh = {'fetched': '2026-10-18T09:30:00Z', 'meetings': [{'date': '2026-07-09', 'purpose': 'Financial Results'}]}
        old = {'fetched': '2026-10-17T09:30:00Z', 'meetings': []}  # 7 days exactly: stale
        (self.root / 'events.json').write_text(json.dumps({'v': 1, 'upcoming': {}, 'past': {'INFY': fresh, 'TCS': old}, 'errors': []}))
        doc = self.step({CAL_URL: self.cal, bm_url('TCS'): self.bm}, symbols=('INFY', 'TCS'))
        self.assertEqual(self.nse.urls, [CAL_URL, bm_url('TCS')])
        self.assertEqual(doc['past']['INFY'], fresh)
        self.assertEqual(len(doc['past']['TCS']['meetings']), 5)

    def test_three_failures_in_a_row_stop_nse_and_keep_the_previous_entries(self):
        prev = {s: {'fetched': '2026-10-01T00:00:00Z', 'meetings': [{'date': '2026-07-09', 'purpose': 'Financial Results'}]}
                for s in ('A', 'B', 'C', 'D')}
        prev_up = {'MARUTI': [{'date': '2026-10-20', 'purpose': 'Financial Results'}]}
        (self.root / 'events.json').write_text(json.dumps({'v': 1, 'upcoming': prev_up, 'past': prev, 'errors': []}))
        secret = RuntimeError('<html>secret body</html>')
        doc = self.step({CAL_URL: secret, bm_url('A'): secret, bm_url('B'): secret, bm_url('C'): secret, bm_url('D'): self.bm},
                        symbols=('A', 'B', 'C', 'D'))
        self.assertEqual(self.nse.urls, [CAL_URL, bm_url('A'), bm_url('B')])  # calendar + A + B = 3 in a row
        self.assertEqual(doc['upcoming'], prev_up)
        self.assertEqual(doc['past'], prev)
        self.assertEqual(doc['errors'], ['event calendar failed', 'board meetings failed: A', 'board meetings failed: B',
                                         'NSE stopped after 3 failures in a row: 2 stocks not refreshed'])
        self.assertNotIn('secret', json.dumps(doc) + ''.join(self.lines))

    def test_a_success_resets_the_failure_count(self):
        served = {CAL_URL: RuntimeError('x'), bm_url('A'): self.bm, bm_url('B'): RuntimeError('x'),
                  bm_url('C'): RuntimeError('x'), bm_url('D'): self.bm}
        doc = self.step(served, symbols=('A', 'B', 'C', 'D'))
        self.assertEqual(len(self.nse.urls), 5)
        self.assertEqual(sorted(doc['past']), ['A', 'D'])

    def test_an_answer_that_is_not_a_list_is_a_failure(self):
        doc = self.step({CAL_URL: {}, bm_url('TCS'): {}})
        self.assertEqual(doc['errors'], ['event calendar failed', 'board meetings failed: TCS'])
        self.assertEqual(doc['past'], {})

    def test_the_file_is_written_atomically_and_nothing_else_is_left(self):
        with mock.patch.object(job._span_job(), '_write_atomic', wraps=job._span_job()._write_atomic) as w:
            self.step({CAL_URL: self.cal, bm_url('TCS'): self.bm})
        self.assertEqual(w.call_args.args[0], self.root / 'events.json')
        self.assertEqual(sorted(p.name for p in self.root.iterdir()), ['events.json'])
        self.assertEqual(self.file()['past']['TCS']['fetched'], '2026-10-24T09:30:00Z')

    def test_dry_run_prints_and_writes_nothing(self):
        doc = self.step({CAL_URL: self.cal, bm_url('TCS'): self.bm}, dry_run=True)
        self.assertFalse((self.root / 'events.json').exists())
        self.assertIn('MARUTI', doc['upcoming'])
        self.assertTrue(any('"MARUTI"' in l for l in self.lines))


class EventsMain(unittest.TestCase):
    EVENING = datetime(2026, 10, 22, 15, 0, tzinfo=timezone.utc)  # 20:30 IST

    def go(self, args, run_side=None, step_side=None):
        with tempfile.TemporaryDirectory() as d, \
                mock.patch.object(job, '_now_utc', return_value=self.EVENING), \
                mock.patch.object(job, 'run', side_effect=run_side, return_value=None) as run, \
                mock.patch.object(job, 'events_step', side_effect=step_side, return_value={}) as step, \
                mock.patch.object(job, '_fetchers', return_value=(lambda u: None, None, None)):
            rc = job.main(['--dir', d, '--symbols', 'TCS'] + args)
        return rc, run, step

    def test_the_events_step_runs_after_the_vol_step(self):
        order = []
        rc, run, step = self.go([], run_side=lambda *a, **k: order.append('vol'), step_side=lambda *a, **k: order.append('events'))
        self.assertEqual((rc, order), (0, ['vol', 'events']))

    def test_events_only_skips_the_vol_step_and_the_close_gate(self):
        with tempfile.TemporaryDirectory() as d, \
                mock.patch.object(job, '_now_utc', return_value=datetime(2026, 10, 22, 6, 30, tzinfo=timezone.utc)), \
                mock.patch.object(job, 'run') as run, mock.patch.object(job, 'events_step', return_value={}) as step, \
                mock.patch.object(job, '_fetchers', return_value=(lambda u: None, None, None)):
            self.assertEqual(job.main(['--dir', d, '--symbols', 'TCS', '--events-only']), 0)
        run.assert_not_called()
        self.assertEqual(step.call_args.args[1], ['TCS'])

    def test_the_vol_run_is_unaffected_when_the_events_step_raises(self):
        rc, run, step = self.go([], step_side=RuntimeError('boom'))
        self.assertEqual(rc, 0)
        run.assert_called_once()

    def test_dry_run_is_passed_to_both_steps(self):
        rc, run, step = self.go(['--dry-run'])
        self.assertEqual((run.call_args.kwargs['dry_run'], step.call_args.kwargs['dry_run']), (True, True))

    def test_the_events_step_still_runs_when_the_vol_step_fails(self):
        rc, run, step = self.go([], run_side=RuntimeError('vol broke'))
        self.assertEqual(rc, 1)
        step.assert_called_once()


class Main(unittest.TestCase):
    def test_before_the_close_today_does_nothing(self):
        with tempfile.TemporaryDirectory() as d:
            ist_noon = datetime(2026, 10, 22, 6, 30, tzinfo=timezone.utc)  # 12:00 IST
            with mock.patch.object(job, '_now_utc', return_value=ist_noon), mock.patch.object(job, 'run') as run:
                self.assertEqual(job.main(['--dir', d]), 0)
                run.assert_not_called()

    def test_symbols_flag_overrides_the_held_list_and_a_past_date_is_not_live(self):
        with tempfile.TemporaryDirectory() as d:
            evening = datetime(2026, 10, 22, 15, 0, tzinfo=timezone.utc)  # 20:30 IST
            with mock.patch.object(job, '_now_utc', return_value=evening), \
                    mock.patch.object(job, 'run', return_value=None) as run, \
                    mock.patch.object(job, '_fetchers', return_value=(None, None, None)):
                self.assertEqual(job.main(['--dir', d, '--date', '2026-10-21', '--symbols', 'tcs,M&M', '--dry-run']), 0)
                kw = run.call_args.kwargs
                self.assertEqual(run.call_args.args[0], date(2026, 10, 21))
                self.assertEqual([kw['symbols'], kw['live'], kw['dry_run']], [['M&M', 'TCS'], False, True])


if __name__ == '__main__':
    unittest.main()
