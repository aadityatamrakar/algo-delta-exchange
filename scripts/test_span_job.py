"""Tests for span_job.py: download-and-save only, with an injected fetcher (no network).

Run from the repo root:  python3 -I scripts/test_span_job.py -v
"""
import gzip
import hashlib
import importlib.util
import io
import json
import sys
import os
import tempfile
import types
import unittest
import urllib.error
from unittest import mock
import zipfile
from datetime import date, timedelta
from pathlib import Path

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('span_job', HERE / 'span_job.py')
span_job = importlib.util.module_from_spec(spec)
sys.modules['span_job'] = span_job
spec.loader.exec_module(span_job)

DAY = date(2026, 10, 19)
FIX = HERE / 'fixtures' / 'span_history'   # rows cut verbatim from the 22 Oct 2026 CM and FO bhavcopies
I1_URL = 'https://nsearchives.nseindia.com/archives/nsccl/span/nsccl.20261019.i1.zip'
AEL_URL = 'https://nsearchives.nseindia.com/archives/exp_lim/ael_19102026.csv'


def make_zip(members: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w') as z:
        for name, data in members.items():
            z.writestr(name, data)
    return buf.getvalue()


def shutil_rmtree(p):
    import shutil
    shutil.rmtree(p, ignore_errors=True)


class Fetcher:
    def __init__(self, served: dict[str, bytes]):
        self.served = served
        self.urls: list[str] = []

    def __call__(self, url: str):
        self.urls.append(url)
        return self.served.get(url)


class SpanJobTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.lines: list[str] = []
        self.addCleanup(self._tmp.cleanup)

    def run_once(self, fetch, day=DAY, now=lambda: 1_792_400_000.5):
        return span_job.run_once(day, fetch, self.root, now, self.lines.append)

    def test_files_for_names(self):
        by_name = {f.name: f for f in span_job.files_for(DAY)}
        for n in ['nsccl.20261019.s.spn', 'nsccl.20261019.i1.spn', 'nsccl.20261019.i5.spn',
                  'ael_19102026.csv',
                  'BhavCopy_NSE_FO_0_0_0_20261019_F_0000.csv', 'BhavCopy_NSE_CM_0_0_0_20261019_F_0000.csv']:
            self.assertIn(n, by_name)
        urls = {f.url for f in span_job.files_for(DAY)}
        self.assertIn('https://nsearchives.nseindia.com/archives/nsccl/span/nsccl.20261019.s.zip', urls)
        for i in range(1, 6):
            self.assertIn(f'https://nsearchives.nseindia.com/archives/nsccl/span/nsccl.20261019.i{i}.zip', urls)
        self.assertIn(AEL_URL, urls)
        self.assertIn('https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_20261019_F_0000.csv.zip', urls)
        self.assertIn('https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_20261019_F_0000.csv.zip', urls)
        self.assertEqual(by_name['ael_19102026.csv'].member, None)
        self.assertEqual(by_name['nsccl.20261019.i1.spn'].member, '.spn')
        self.assertEqual(by_name['BhavCopy_NSE_FO_0_0_0_20261019_F_0000.csv'].member, '.csv')

    def test_previous_day_files_go_to_their_own_folder(self):
        fo = 'https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_20261016_F_0000.csv.zip'
        cm = 'https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_20261016_F_0000.csv.zip'
        f = Fetcher({
            fo: make_zip({'BhavCopy_NSE_FO_0_0_0_20261016_F_0000.csv': b'TckrSymb\nA\n'}),
            cm: make_zip({'BhavCopy_NSE_CM_0_0_0_20261016_F_0000.csv': b'TckrSymb\nB\n'}),
        })
        self.assertEqual(self.run_once(f), 2)
        d = self.root / '2026-10-16'
        self.assertEqual((d / 'BhavCopy_NSE_FO_0_0_0_20261016_F_0000.csv').read_bytes(), b'TckrSymb\nA\n')
        self.assertEqual((d / 'BhavCopy_NSE_CM_0_0_0_20261016_F_0000.csv').read_bytes(), b'TckrSymb\nB\n')
        self.assertFalse((self.root / '2026-10-19' / 'BhavCopy_NSE_FO_0_0_0_20261016_F_0000.csv').exists())

    def test_saves_into_dated_folder(self):
        spn = b'<spanFile/>'
        csv = b'a,b\n1,2\n'
        f = Fetcher({I1_URL: make_zip({'nsccl.20261019.i1.spn': spn}), AEL_URL: csv})
        self.assertEqual(self.run_once(f), 2)
        d = self.root / '2026-10-19'
        self.assertEqual((d / 'nsccl.20261019.i1.spn').read_bytes(), spn)
        self.assertEqual((d / 'ael_19102026.csv').read_bytes(), csv)
        m = json.loads((d / 'manifest.json').read_text())
        self.assertEqual(sorted(m), ['ael', 'i1'])
        self.assertEqual(m['i1']['sha256'], hashlib.sha256(spn).hexdigest())
        self.assertEqual(m['ael']['sha256'], hashlib.sha256(csv).hexdigest())
        self.assertEqual(m['ael']['bytes'], len(csv))
        self.assertEqual(m['ael']['name'], 'ael_19102026.csv')
        self.assertEqual(m['ael']['url'], AEL_URL)

    def test_gzipped_csv_is_saved_unpacked(self):
        # NSE serves ael_DDMMYYYY.csv gzipped (seen 20 Oct 2026); the manifest describes what is on disk
        csv = b'Sr No.,Symbol,Instrument Type,Normal ELM Margin%,Total applicable ELM%\n1,ABB,OTH,3.5,3.5\n'
        f = Fetcher({AEL_URL: gzip.compress(csv)})
        self.assertEqual(self.run_once(f), 1)
        d = self.root / '2026-10-19'
        self.assertEqual((d / 'ael_19102026.csv').read_bytes(), csv)
        m = json.loads((d / 'manifest.json').read_text())
        self.assertEqual(m['ael']['bytes'], len(csv))
        self.assertEqual(m['ael']['sha256'], hashlib.sha256(csv).hexdigest())

    def test_corrupt_gzip_fails_that_file_only(self):
        f = Fetcher({AEL_URL: b'\x1f\x8b' + b'not really gzip'})
        self.run_once(f)
        self.assertFalse((self.root / '2026-10-19' / 'ael_19102026.csv').exists())
        self.assertTrue(any('ael_19102026.csv: failed' in l for l in self.lines), self.lines)

    def test_saved_at_is_epoch_milliseconds_int(self):
        f = Fetcher({AEL_URL: b'x'})
        self.run_once(f, now=lambda: 1_792_400_000.5)
        m = json.loads((self.root / '2026-10-19' / 'manifest.json').read_text())
        self.assertIs(type(m['ael']['savedAt']), int)
        self.assertEqual(m['ael']['savedAt'], 1_792_400_000_500)

    def test_idempotent(self):
        f = Fetcher({I1_URL: make_zip({'nsccl.20261019.i1.spn': b'x'}), AEL_URL: b'y'})
        self.assertEqual(self.run_once(f), 2)
        f2 = Fetcher({I1_URL: make_zip({'nsccl.20261019.i1.spn': b'x'}), AEL_URL: b'y'})
        self.assertEqual(self.run_once(f2), 0)
        self.assertNotIn(I1_URL, f2.urls)
        self.assertNotIn(AEL_URL, f2.urls)

    def test_not_yet_is_not_an_error(self):
        self.assertEqual(self.run_once(Fetcher({})), 0)
        self.assertTrue(self.lines)
        self.assertTrue(all('not yet' in line for line in self.lines), self.lines)
        data = [p for p in self.root.rglob('*') if p.is_file() and p.name != 'manifest.json']
        self.assertEqual(data, [])

    def test_refuses_traversal(self):
        f = Fetcher({I1_URL: make_zip({'../evil.spn': b'x'})})
        self.assertEqual(self.run_once(f), 0)
        self.assertTrue(any('failed' in line for line in self.lines), self.lines)
        self.assertFalse((self.root / 'evil.spn').exists())
        self.assertFalse((self.root / '2026-10-19' / 'nsccl.20261019.i1.spn').exists())
        mp = self.root / '2026-10-19' / 'manifest.json'
        m = json.loads(mp.read_text()) if mp.exists() else {}
        self.assertNotIn('i1', m)

    def test_refuses_oversize(self):
        f = Fetcher({I1_URL: make_zip({'nsccl.20261019.i1.spn': b'x' * 100})})
        old = span_job.MAX_BYTES
        span_job.MAX_BYTES = 10
        self.addCleanup(setattr, span_job, 'MAX_BYTES', old)
        self.assertEqual(self.run_once(f), 0)
        self.assertTrue(any('failed' in line for line in self.lines), self.lines)
        self.assertFalse((self.root / '2026-10-19' / 'nsccl.20261019.i1.spn').exists())

    def test_no_tmp_left(self):
        f = Fetcher({I1_URL: make_zip({'nsccl.20261019.i1.spn': b'x'}), AEL_URL: b'y'})
        self.run_once(f)
        self.assertEqual(list(self.root.rglob('*.tmp')), [])

    def test_prune(self):
        for n in ['2026-10-11', '2026-10-12', '2026-10-19']:
            (self.root / n).mkdir()
            (self.root / n / 'x').write_text('x')
        (self.root / 'notes').mkdir()
        removed = span_job.prune(self.root, DAY)
        self.assertEqual(removed, ['2026-10-11'])
        self.assertFalse((self.root / '2026-10-11').exists())
        self.assertTrue((self.root / '2026-10-12').exists())
        self.assertTrue((self.root / 'notes').exists())

    def test_prune_only_touches_real_dated_dirs(self):
        for n in ['2026-10-11', '20261001', '2026-W41-1', 'notes']:
            (self.root / n).mkdir()
        (self.root / '2026-09-01.txt').write_text('x')
        elsewhere = Path(self._tmp.name + '-target')
        elsewhere.mkdir()
        self.addCleanup(shutil_rmtree, elsewhere)
        (self.root / '2026-09-02').symlink_to(elsewhere, target_is_directory=True)
        self.assertEqual(span_job.prune(self.root, DAY), ['2026-10-11'])
        for n in ['20261001', '2026-W41-1', 'notes', '2026-09-01.txt', '2026-09-02']:
            self.assertTrue(os.path.lexists(self.root / n), n)
        self.assertTrue(elsewhere.exists())

    def test_write_failure_leaves_no_tmp_and_no_key(self):
        f = Fetcher({AEL_URL: b'y'})
        with mock.patch.object(span_job.os, 'replace', side_effect=OSError('disk')):
            self.assertEqual(self.run_once(f), 0)
        self.assertTrue(any('failed' in line for line in self.lines), self.lines)
        self.assertEqual(list(self.root.rglob('*.tmp')), [])
        self.assertFalse((self.root / '2026-10-19' / 'ael_19102026.csv').exists())

    def test_manifest_write_failure_leaves_no_tmp_and_no_key(self):
        real = os.replace

        def replace(src, dst):
            if Path(dst).name == 'manifest.json':
                raise OSError('disk')
            real(src, dst)

        f = Fetcher({AEL_URL: b'y'})
        with mock.patch.object(span_job.os, 'replace', side_effect=replace):
            self.assertEqual(self.run_once(f), 0)
        self.assertTrue(any('failed' in line for line in self.lines), self.lines)
        self.assertEqual(list(self.root.rglob('*.tmp')), [])
        mp = self.root / '2026-10-19' / 'manifest.json'
        self.assertNotIn('ael', json.loads(mp.read_text()) if mp.exists() else {})

    def test_unreadable_manifest_starts_empty(self):
        d = self.root / '2026-10-19'
        d.mkdir()
        for bad in [b'{not json', b'[1, 2]']:
            self.lines.clear()
            (d / 'manifest.json').write_bytes(bad)
            self.assertEqual(self.run_once(Fetcher({AEL_URL: b'y'})), 1)
            self.assertTrue(any('unreadable' in line and 'manifest.json' in line for line in self.lines), self.lines)
            self.assertIn('ael', json.loads((d / 'manifest.json').read_text()))
            (d / 'manifest.json').unlink()
            (d / 'ael_19102026.csv').unlink()


# The UDiFF bhavcopy header, copied from the real files (BhavCopy_NSE_CM/FO_0_0_0_20261022_F_0000.csv): both carry it.
UDIFF = ('TradDt,BizDt,Sgmt,Src,FinInstrmTp,FinInstrmId,ISIN,TckrSymb,SctySrs,XpryDt,FininstrmActlXpryDt,StrkPric,'
         'OptnTp,FinInstrmNm,OpnPric,HghPric,LwPric,ClsPric,LastPric,PrvsClsgPric,UndrlygPric,SttlmPric,OpnIntrst,'
         'ChngInOpnIntrst,TtlTradgVol,TtlTrfVal,TtlNbOfTxsExctd,SsnId,NewBrdLotQty,Rmks,Rsvd1,Rsvd2,Rsvd3,Rsvd4')
COLS = UDIFF.split(',')
TRADE = '2026-10-22'


def bhav(rows: list[dict]) -> bytes:
    lines = [UDIFF]
    for r in rows:
        full = {'TradDt': TRADE, 'BizDt': TRADE, 'Src': 'NSE', 'SsnId': 'F1', **r}
        lines.append(','.join(str(full.get(c, '')) for c in COLS))
    return ('\n'.join(lines) + '\n').encode()


def cm_row(sym, o, h, l, c, v, series='EQ'):
    return {'Sgmt': 'CM', 'FinInstrmTp': 'STK', 'TckrSymb': sym, 'SctySrs': series, 'OpnPric': o, 'HghPric': h,
            'LwPric': l, 'ClsPric': c, 'TtlTradgVol': v, 'NewBrdLotQty': 1}


def fut_row(sym, expiry, o, h, l, c, oi, vol, lot, tp='STF', under=''):
    return {'Sgmt': 'FO', 'FinInstrmTp': tp, 'TckrSymb': sym, 'XpryDt': expiry, 'FininstrmActlXpryDt': expiry,
            'OpnPric': o, 'HghPric': h, 'LwPric': l, 'ClsPric': c, 'UndrlygPric': under, 'OpnIntrst': oi,
            'TtlTradgVol': vol, 'NewBrdLotQty': lot}


def opt_row(sym, expiry, strike, side, close, oi, vol=10, tp='STO', lot=225):
    return {'Sgmt': 'FO', 'FinInstrmTp': tp, 'TckrSymb': sym, 'XpryDt': expiry, 'FininstrmActlXpryDt': expiry,
            'StrkPric': f'{strike:.2f}', 'OptnTp': side, 'ClsPric': close, 'OpnIntrst': oi, 'TtlTradgVol': vol,
            'NewBrdLotQty': lot}


def tcs_fo() -> list[dict]:
    """TCS on 22 Oct: a future expiring that day (rolled past), the 27 Oct near month and 23 Nov; a 27 Oct chain."""
    rows = [
        fut_row('TCS', '2026-10-22', 2500, 2510, 2490, 2506.5, 999, 5, 225),
        fut_row('TCS', '2026-10-27', 2517, 2536.6, 2482, 2505.2, 15329250, 30503, 225),
        fut_row('TCS', '2026-11-23', 2528, 2541.4, 2489.1, 2512, 8628975, 24560, 225),
        # an option expiring today: rolled past, its huge OI must not count
        opt_row('TCS', '2026-10-22', 2500, 'CE', 6, 10**9),
    ]
    # CE OI 100/200/300, PE OI 300/200/100 at 2400/2500/2600: max pain 2500 (hand-worked in the test)
    for k, ce, pe, ce_oi, pe_oi in [(2400, 110, 5, 100, 300), (2500, 30.1, 25.9, 200, 200), (2600, 3, 95, 300, 100)]:
        rows.append(opt_row('TCS', '2026-10-27', k, 'CE', ce, ce_oi))
        rows.append(opt_row('TCS', '2026-10-27', k, 'PE', pe, pe_oi))
    rows.append(opt_row('TCS', '2026-10-27', 2700, 'CE', 1, 50))   # a CE with no PE: never the ATM, still a wall
    rows.append(opt_row('TCS', '2026-11-23', 2500, 'CE', 60, 10**8))   # a far month: not the near expiry
    return rows


class HistoryTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.lines: list[str] = []
        self.addCleanup(self._tmp.cleanup)

    def summary(self, cm_rows, fo_rows, day=date(2026, 10, 22)):
        return span_job.summarize_day(day, bhav(cm_rows), bhav(fo_rows))

    def test_a_stock_day(self):
        s = self.summary([cm_row('TCS', 2520, 2533, 2479, 2506.9, 4174671), cm_row('TCS', 1, 1, 1, 1, 1, series='BE'),
                          cm_row('NOTFO', 10, 11, 9, 10.5, 100)], tcs_fo())
        self.assertEqual(s['date'], '2026-10-22')
        self.assertEqual(sorted(s['symbols']), ['TCS'], 'F&O underlyings only')
        t = s['symbols']['TCS']
        self.assertEqual([t['o'], t['h'], t['l'], t['c'], t['v']], [2520, 2533, 2479, 2506.9, 4174671])
        self.assertNotIn('src', t)
        self.assertEqual(t['fut'], {'expiry': '2026-10-27', 'c': 2505.2, 'oi': 15329250})
        o = t['opt']
        self.assertEqual(o['expiry'], '2026-10-27')
        self.assertEqual([o['ceOi'], o['peOi']], [650, 600])
        self.assertEqual(o['atm'], {'strike': 2500, 'ce': 30.1, 'pe': 25.9})
        self.assertEqual(o['walls'], {'ce': [[2600, 300], [2500, 200], [2400, 100]], 'pe': [[2400, 300], [2500, 200], [2600, 100]]})
        # payout at 2400: puts 200*100 + 100*200 = 40000; at 2500: calls 100*100 + puts 100*100 = 20000 (+50 OI at
        # 2700 out of the money); at 2600: calls 100*200 + 200*100 = 40000; at 2700: calls 100*300+200*200+300*100
        self.assertEqual(o['maxPain'], 2500)

    def test_an_index_has_no_cash_row_so_its_ohlc_is_the_near_future(self):
        fo = [fut_row('NIFTY', '2026-10-27', 22659.9, 22818.6, 22550, 22711.3, 13810940, 80397, 65, tp='IDF', under=22687.65),
              opt_row('NIFTY', '2026-10-23', 22700, 'CE', 80, 1000, tp='IDO', lot=65),
              opt_row('NIFTY', '2026-10-23', 22700, 'PE', 70, 900, tp='IDO', lot=65)]
        t = self.summary([], fo)['symbols']['NIFTY']
        self.assertEqual(t['src'], 'fut')
        self.assertEqual([t['o'], t['h'], t['l'], t['c']], [22659.9, 22818.6, 22550, 22711.3])
        self.assertEqual(t['v'], 80397 * 65, 'contracts times the lot: shares, like the cash volume')
        self.assertEqual(t['fut']['expiry'], '2026-10-27')
        self.assertEqual(t['opt']['expiry'], '2026-10-23', 'the nearest option expiry, a weekly with no future')
        self.assertEqual(t['opt']['atm'], {'strike': 22700, 'ce': 80, 'pe': 70})

    def test_the_ranked_iv_is_the_atm_of_the_first_expiry_a_week_or_more_out(self):
        # a fixed tenor: on Thu 22 Oct, 27 Oct is 5 days out, so the ranked IV is November's; the OI view stays put
        fo = tcs_fo() + [opt_row('TCS', '2026-11-23', 2500, 'PE', 55, 10)]
        cm = [cm_row('TCS', 2520, 2533, 2479, 2506.9, 1)]
        t = self.summary(cm, fo)['symbols']['TCS']
        self.assertEqual(t['ivAtm'], {'expiry': '2026-11-23', 'strike': 2500, 'ce': 60, 'pe': 55, 'fut': 2512})
        self.assertEqual(t['opt']['expiry'], '2026-10-27', 'the OI view stays on the nearest expiry')
        wed = self.summary(cm, fo, day=date(2026, 10, 21))['symbols']['TCS']
        self.assertEqual(wed['ivAtm']['expiry'], '2026-11-23', '6 days is short of a week')
        mon = self.summary(cm, fo, day=date(2026, 10, 19))['symbols']['TCS']
        self.assertEqual(mon['ivAtm'], {'expiry': '2026-10-27', 'strike': 2500, 'ce': 30.1, 'pe': 25.9, 'fut': 2505.2})

    def test_an_index_ranks_a_weekly_a_week_or_more_out_never_a_one_day_weekly(self):
        rows = [fut_row('NIFTY', '2026-10-27', 22659.9, 22818.6, 22550, 22711.3, 1, 1, 65, tp='IDF', under=22687.65)]
        for exp, ce, pe in [('2026-10-20', 20, 18), ('2026-10-27', 180, 170), ('2026-11-03', 260, 250), ('2026-11-24', 400, 380)]:
            rows += [opt_row('NIFTY', exp, 22700, 'CE', ce, 10, tp='IDO', lot=65), opt_row('NIFTY', exp, 22700, 'PE', pe, 10, tp='IDO', lot=65)]
        mon = self.summary([], rows, day=date(2026, 10, 19))['symbols']['NIFTY']
        self.assertEqual(mon['opt']['expiry'], '2026-10-20', 'the OI view is the nearest weekly')
        self.assertEqual(mon['ivAtm'], {'expiry': '2026-10-27', 'strike': 22700, 'ce': 180, 'pe': 170, 'fut': 22711.3})
        wed = self.summary([], rows, day=date(2026, 10, 21))['symbols']['NIFTY']
        self.assertEqual(wed['ivAtm'], {'expiry': '2026-11-03', 'strike': 22700, 'ce': 260, 'pe': 250, 'fut': None})

    def test_the_tenor_helpers(self):
        listed = [date(2026, 10, 27), date(2026, 11, 3), date(2026, 11, 24), date(2026, 12, 29)]
        self.assertEqual(span_job.iv_expiry(listed, date(2026, 10, 20)), date(2026, 10, 27))
        self.assertEqual(span_job.iv_expiry(listed, date(2026, 10, 21)), date(2026, 11, 3))
        self.assertIsNone(span_job.iv_expiry(listed, date(2026, 12, 23)))
        self.assertEqual(span_job.next_month_expiry(listed, date(2026, 10, 27)), date(2026, 11, 24))
        self.assertEqual(span_job.next_month_expiry(listed, date(2026, 11, 3)), date(2026, 12, 29))
        self.assertIsNone(span_job.next_month_expiry(listed, date(2026, 12, 29)))

    def test_nse_previous_close_is_written_as_pc(self):
        cash = {**cm_row('TCS', 1270, 1280, 1250, 1260, 1), 'PrvsClsgPric': 1255.5}   # e.g. a 1:1 bonus ex-date
        t = self.summary([cash], tcs_fo())['symbols']['TCS']
        self.assertEqual(t['pc'], 1255.5)
        self.assertNotIn('pc', self.summary([cm_row('TCS', 1, 1, 1, 1, 1)], tcs_fo())['symbols']['TCS'], 'none in the file: none')
        fut = {**fut_row('NIFTY', '2026-10-27', 22659.9, 22818.6, 22550, 22711.3, 1, 1, 65, tp='IDF'), 'PrvsClsgPric': 22743.3}
        self.assertEqual(self.summary([], [fut])['symbols']['NIFTY']['pc'], 22743.3, "an index's is its near future's own")

    def test_an_untraded_atm_side_has_no_close(self):
        fo = tcs_fo()
        for r in fo:
            if r.get('StrkPric') == '2500.00' and r['OptnTp'] == 'PE' and r['XpryDt'] == '2026-10-27':
                r['TtlTradgVol'] = 0
        t = self.summary([cm_row('TCS', 2520, 2533, 2479, 2506.9, 1)], fo)['symbols']['TCS']
        self.assertEqual(t['opt']['atm'], {'strike': 2500, 'ce': 30.1, 'pe': None})

    def test_no_future_no_options_no_cash(self):
        # options only, no OI anywhere: no walls and no max pain; a symbol with no price at all is left out
        fo = [opt_row('ABC', '2026-10-27', 100, 'CE', 2, 0), opt_row('ABC', '2026-10-27', 100, 'PE', 3, 0),
              opt_row('XYZ', '2026-10-27', 50, 'CE', 1, 10)]
        s = self.summary([cm_row('ABC', 99, 101, 98, 100, 5)], fo)
        self.assertEqual(sorted(s['symbols']), ['ABC'])
        a = s['symbols']['ABC']
        self.assertIsNone(a['fut'])
        self.assertEqual(a['opt']['walls'], {'ce': [], 'pe': []})
        self.assertIsNone(a['opt']['maxPain'])
        self.assertEqual(a['opt']['atm'], {'strike': 100, 'ce': 2, 'pe': 3}, 'no future: the ATM is nearest the cash close')

    def test_a_file_without_the_columns_is_refused(self):
        with self.assertRaises(ValueError):
            span_job.summarize_day(date(2026, 10, 22), b'TckrSymb\nA\n', bhav(tcs_fo()))

    def save_day(self, day: date, cm: bytes, fo: bytes):
        d = self.root / day.isoformat()
        d.mkdir(parents=True, exist_ok=True)
        ymd = day.strftime('%Y%m%d')
        (d / f'BhavCopy_NSE_CM_0_0_0_{ymd}_F_0000.csv').write_bytes(cm)
        (d / f'BhavCopy_NSE_FO_0_0_0_{ymd}_F_0000.csv').write_bytes(fo)

    def test_run_once_writes_the_history_of_each_day_with_both_files(self):
        day = date(2026, 10, 22)
        self.save_day(day, bhav([cm_row('TCS', 2520, 2533, 2479, 2506.9, 1)]), bhav(tcs_fo()))
        # the previous day has only its cash file: no history yet, and nothing said about it
        prev = self.root / '2026-10-21'
        prev.mkdir()
        (prev / 'BhavCopy_NSE_CM_0_0_0_20261021_F_0000.csv').write_bytes(bhav([]))
        span_job.run_once(day, Fetcher({}), self.root, lambda: 1.0, self.lines.append)
        out = self.root / 'history' / '2026-10-22.json'
        self.assertEqual(json.loads(out.read_text())['symbols']['TCS']['c'], 2506.9)
        self.assertFalse((self.root / 'history' / '2026-10-21.json').exists())
        self.assertTrue(any(l == 'history 2026-10-22: written, 1 symbols' for l in self.lines), self.lines)
        self.assertFalse(any('2026-10-21' in l and 'history' in l for l in self.lines), self.lines)
        self.assertEqual(list(self.root.rglob('*.tmp')), [])
        # once written it is not written again
        before = out.stat().st_mtime_ns
        self.lines.clear()
        span_job.run_once(day, Fetcher({}), self.root, lambda: 1.0, self.lines.append)
        self.assertEqual(out.stat().st_mtime_ns, before)
        self.assertFalse(any(l.startswith('history') for l in self.lines), self.lines)

    def test_a_bad_bhavcopy_fails_the_history_only(self):
        day = date(2026, 10, 22)
        self.save_day(day, b'not,a,bhavcopy\n', bhav(tcs_fo()))
        span_job.run_once(day, Fetcher({}), self.root, lambda: 1.0, self.lines.append)
        self.assertFalse((self.root / 'history' / '2026-10-22.json').exists())
        self.assertTrue(any(l.startswith('history 2026-10-22: failed:') for l in self.lines), self.lines)

    def test_prune_leaves_the_history_folder_alone(self):
        (self.root / 'history').mkdir()
        (self.root / 'history' / '2025-01-02.json').write_text('{}')
        (self.root / '2026-10-01').mkdir()
        self.assertEqual(span_job.prune(self.root, date(2026, 10, 22)), ['2026-10-01'])
        self.assertTrue((self.root / 'history' / '2025-01-02.json').exists())

    def zips(self, day: date, cm: bytes, fo: bytes) -> dict[str, bytes]:
        ymd = day.strftime('%Y%m%d')
        cm_name = f'BhavCopy_NSE_CM_0_0_0_{ymd}_F_0000.csv'
        fo_name = f'BhavCopy_NSE_FO_0_0_0_{ymd}_F_0000.csv'
        return {f'https://nsearchives.nseindia.com/content/cm/{cm_name}.zip': make_zip({cm_name: cm}),
                f'https://nsearchives.nseindia.com/content/fo/{fo_name}.zip': make_zip({fo_name: fo})}

    def test_backfill(self):
        # Fri 23 Oct back: Thu 22 already summarised, Wed 21 saved on disk, Tue 20 a holiday (404), Mon 19 and
        # Fri 16 served; Sat/Sun are never asked for
        cm = bhav([cm_row('TCS', 2520, 2533, 2479, 2506.9, 1)])
        fo = bhav(tcs_fo())
        served = {**self.zips(date(2026, 10, 23), cm, fo), **self.zips(date(2026, 10, 19), cm, fo),
                  **self.zips(date(2026, 10, 16), cm, fo), **self.zips(date(2026, 10, 15), cm, fo)}
        (self.root / 'history').mkdir()
        (self.root / 'history' / '2026-10-22.json').write_text('{"date": "2026-10-22", "symbols": {}}')
        self.save_day(date(2026, 10, 21), cm, fo)
        f = Fetcher(served)
        sleeps: list[float] = []
        n = span_job.backfill_history(5, f, self.root, date(2026, 10, 23), self.lines.append, sleeps.append, delay=0.5)
        self.assertEqual(n, (4, None), self.lines)   # 23, 21, 19, 16 written; 22 was there
        hist = sorted(p.name for p in (self.root / 'history').iterdir())
        self.assertEqual(hist, ['2026-10-16.json', '2026-10-19.json', '2026-10-21.json', '2026-10-22.json', '2026-10-23.json', 'unpublished.json'])
        self.assertEqual(span_job.read_unpublished(self.root), {'2026-10-20'}, 'the holiday is recorded')
        self.assertEqual(json.loads((self.root / 'history' / '2026-10-19.json').read_text())['date'], '2026-10-19')
        asked = [u.rsplit('_', 3)[1] + ('CM' if '/cm/' in u else 'FO') for u in f.urls]
        # 23: CM, FO; 20: CM 404, so its FO is never asked; 19 and 16: CM, FO; nothing for 22, 21, 15 or the weekend
        self.assertEqual(asked, ['20261023CM', '20261023FO', '20261020CM', '20261019CM', '20261019FO', '20261016CM', '20261016FO'])
        self.assertEqual(sleeps, [0.5] * (len(f.urls) - 1), 'a pause before every request but the first')
        self.assertTrue(any('2026-10-20' in l and 'not published' in l for l in self.lines), self.lines)
        self.assertTrue(any(l.startswith('backfill: 5 of 5 days') for l in self.lines), self.lines)
        # nothing but the summaries was written: the downloads stayed in memory
        self.assertFalse((self.root / '2026-10-19').exists())
        self.assertEqual(list(self.root.rglob('*.tmp')), [])

    def test_backfill_stops_after_failures_in_a_row(self):
        def refuse(url):
            raise RuntimeError('HTTP 403')
        n = span_job.backfill_history(50, refuse, self.root, date(2026, 10, 23), self.lines.append, lambda s: None)
        self.assertEqual(n.written, 0)
        self.assertIn('failed days in a row', n.stopped)
        self.assertEqual(sum('failed: HTTP 403' in l for l in self.lines), span_job.BACKFILL_MAX_FAILURES)
        self.assertTrue(any('stopping' in l for l in self.lines), self.lines)

    def test_backfill_stops_after_ten_unpublished_weekdays_in_a_row(self):
        # nothing is ever published (all 404: before UDiFF, or a client NSE 404s): ten weekdays' CM files, then it stops
        f = Fetcher({})
        n = span_job.backfill_history(260, f, self.root, date(2026, 10, 23), self.lines.append, lambda s: None)
        self.assertEqual(n.written, 0)
        self.assertEqual(len(f.urls), span_job.BACKFILL_MAX_UNPUBLISHED)
        self.assertIn('not published', n.stopped)
        self.assertTrue(any(l.startswith('backfill: 0 of 260 days') for l in self.lines), self.lines)

    def test_a_rerun_over_a_full_history_with_scattered_holidays_runs_its_course(self):
        # 23 Oct back over 60 weekdays: 48 summarised, 12 scattered holidays (never two in a row). The days it has
        # break the 404 row, so the twelve never add up to the 10 that stop a run.
        days, d = [], date(2026, 10, 23)
        while len(days) < 60:
            if d.weekday() < 5:
                days.append(d)
            d -= timedelta(days=1)
        holidays = set(days[2::5])
        (self.root / 'history').mkdir()
        for x in days:
            if x not in holidays:
                (self.root / 'history' / f'{x.isoformat()}.json').write_text(json.dumps({'date': x.isoformat(), 'symbols': {}}))
        f = Fetcher({})
        n = span_job.backfill_history(48, f, self.root, date(2026, 10, 23), self.lines.append, lambda s: None)
        self.assertEqual(n, (0, None), self.lines)
        self.assertEqual(len(f.urls), 12, 'each holiday asked once (its CM file 404s)')
        # the holidays are recorded, and a second run asks only for those within a week of its end
        recorded = json.loads((self.root / 'history' / 'unpublished.json').read_text())['days']
        self.assertEqual(recorded, sorted(x.isoformat() for x in holidays))
        again = Fetcher({})
        self.assertEqual(span_job.backfill_history(48, again, self.root, date(2026, 10, 23), self.lines.append, lambda s: None), (0, None))
        self.assertEqual(len(again.urls), sum(1 for x in holidays if (date(2026, 10, 23) - x).days <= 7))

    def test_a_published_day_resets_the_unpublished_count(self):
        cm = bhav([cm_row('TCS', 2520, 2533, 2479, 2506.9, 1)])
        fo = bhav(tcs_fo())
        # 23 Oct back: 9 weekdays not published, 12 Oct published, then 9 more not published, 28 Sep published
        f = Fetcher({**self.zips(date(2026, 10, 12), cm, fo), **self.zips(date(2026, 9, 28), cm, fo)})
        n = span_job.backfill_history(2, f, self.root, date(2026, 10, 23), self.lines.append, lambda s: None)
        self.assertEqual(n, (2, None), self.lines)

    def test_main_backfill_mode_runs_only_the_backfill(self):
        calls = []
        with mock.patch.object(span_job, 'nse_fetcher', return_value=Fetcher({})), \
             mock.patch.object(span_job, 'backfill_history', side_effect=lambda *a, **k: calls.append((a, k)) or span_job.Backfill(0, None)), \
             mock.patch.object(span_job, 'run_once', side_effect=AssertionError('run_once ran')):
            rc = span_job.main(['--dir', str(self.root), '--date', '2026-10-23', '--backfill-history', '7', '--delay', '0.25'])
        self.assertEqual(rc, 0)
        (args, kw), = calls
        self.assertEqual((args[0], args[2], args[3]), (7, self.root, date(2026, 10, 23)))
        self.assertEqual(kw['delay'], 0.25)

    def test_main_backfill_that_stops_short_exits_1(self):
        with mock.patch.object(span_job, 'nse_fetcher', return_value=Fetcher({})), \
             mock.patch.object(span_job, 'backfill_history', return_value=span_job.Backfill(3, '5 failed days in a row')):
            self.assertEqual(span_job.main(['--dir', str(self.root), '--backfill-history', '7']), 1)

    # ---- the index close ("ic"): the index's own closing value, from the FO bhavcopy's UndrlygPric --------------------

    def real_day(self) -> tuple[bytes, bytes]:
        """22 Oct 2026's CM and FO bhavcopies cut down to NIFTY, BANKNIFTY and TCS rows, copied verbatim."""
        return ((FIX / 'BhavCopy_NSE_CM_0_0_0_20261022_F_0000.csv').read_bytes(),
                (FIX / 'BhavCopy_NSE_FO_0_0_0_20261022_F_0000.csv').read_bytes())

    def test_an_index_gets_ic_from_its_underlying_price_and_nothing_else_changes(self):
        cm, fo = self.real_day()
        s = span_job.summarize_day(date(2026, 10, 22), cm, fo)['symbols']
        self.assertEqual(sorted(s), ['BANKNIFTY', 'NIFTY', 'TCS'])
        n = s['NIFTY']
        self.assertEqual((n['ic'], s['BANKNIFTY']['ic']), (22687.65, 54925.7))
        self.assertEqual(n['c'], 22711.3, "c stays the near future's close; ic is the index's")
        self.assertEqual(n['src'], 'fut')
        self.assertEqual(list(n), ['o', 'h', 'l', 'c', 'v', 'src', 'pc', 'fut', 'opt', 'ivAtm', 'ic'], 'ic is added, no field goes')
        self.assertEqual(n['fut']['c'], 22711.3)

    def test_a_stock_has_no_ic_even_though_its_rows_carry_an_underlying_price(self):
        cm, fo = self.real_day()
        t = span_job.summarize_day(date(2026, 10, 22), cm, fo)['symbols']['TCS']
        self.assertNotIn('ic', t)
        self.assertEqual(t['c'], 2506.9, 'the cash close; the rows say 2506.46')
        self.assertNotIn('src', t)

    def test_index_rows_that_disagree_give_no_ic_and_a_warning(self):
        rows = [fut_row('NIFTY', '2026-10-27', 1, 2, 1, 22711.3, 1, 1, 65, tp='IDF', under=22687.65),
                {**opt_row('NIFTY', '2026-10-27', 22700, 'CE', 80, 10, tp='IDO', lot=65), 'UndrlygPric': 22650},   # a stale row
                fut_row('BANKNIFTY', '2026-10-27', 1, 2, 1, 54961.4, 1, 1, 30, tp='IDF', under=54925.7),
                fut_row('TCS', '2026-10-27', 2517, 2536.6, 2482, 2505.2, 1, 1, 225, under=2506.46)]
        logged: list[str] = []
        s = span_job.summarize_day(date(2026, 10, 22), bhav([cm_row('TCS', 2520, 2533, 2479, 2506.9, 1)]), bhav(rows), logged.append)['symbols']
        self.assertNotIn('ic', s['NIFTY'])
        self.assertEqual(s['NIFTY']['c'], 22711.3, 'the rest of the entry is as ever')
        self.assertEqual(s['BANKNIFTY']['ic'], 54925.7, 'another index is judged on its own rows')
        self.assertEqual(logged, ['history 2026-10-22: NIFTY: UndrlygPric differs between rows (22650.0 to 22687.65) - no ic'])

    def test_a_last_digit_of_rounding_is_not_a_disagreement(self):
        def day(a, b):
            rows = [fut_row('NIFTY', '2026-10-27', 1, 2, 1, 22711.3, 1, 1, 65, tp='IDF', under=a),
                    {**opt_row('NIFTY', '2026-10-27', 22700, 'CE', 80, 10, tp='IDO', lot=65), 'UndrlygPric': b}]
            return span_job.summarize_day(date(2026, 10, 22), bhav([]), bhav(rows))['symbols']['NIFTY']
        self.assertEqual(day(22687.65, 22687.66)['ic'], 22687.65, 'the first row wins')
        self.assertNotIn('ic', day(22687.65, 22687.67))

    def test_an_index_with_no_underlying_price_gets_no_ic(self):
        logged: list[str] = []
        rows = [fut_row('NIFTY', '2026-10-27', 1, 2, 1, 22711.3, 1, 1, 65, tp='IDF')]
        s = span_job.summarize_day(date(2026, 10, 22), bhav([]), bhav(rows), logged.append)['symbols']['NIFTY']
        self.assertNotIn('ic', s)
        self.assertEqual(logged, ['history 2026-10-22: NIFTY: no UndrlygPric in its rows - no ic'])

    def test_the_expiring_series_carries_the_close_too(self):
        # 19 Oct 2026, a Monday weekly expiry: the file keeps the expiring options, and they must agree with the rest
        rows = [fut_row('NIFTY', '2026-10-27', 1, 2, 1, 22895.2, 1, 1, 65, tp='IDF', under=22888.95),
                {**opt_row('NIFTY', '2026-10-19', 22900, 'CE', 5, 10, tp='IDO', lot=65), 'UndrlygPric': 22888.95}]
        self.assertEqual(span_job.summarize_day(date(2026, 10, 19), bhav([]), bhav(rows))['symbols']['NIFTY']['ic'], 22888.95)
        rows[1]['UndrlygPric'] = 22900
        self.assertNotIn('ic', span_job.summarize_day(date(2026, 10, 19), bhav([]), bhav(rows))['symbols']['NIFTY'])

    def test_the_daily_job_writes_ic(self):
        cm, fo = self.real_day()
        day = date(2026, 10, 22)
        self.save_day(day, cm, fo)
        self.assertTrue(span_job.history_step(self.root, day, self.lines.append))
        doc = json.loads((self.root / 'history' / '2026-10-22.json').read_text())
        self.assertEqual({k: v['ic'] for k, v in doc['symbols'].items() if 'ic' in v}, {'NIFTY': 22687.65, 'BANKNIFTY': 54925.7})

    def old_history(self, day: date) -> dict:
        """What an earlier version of the job wrote for `day`: the fresh summary without ic, and marks to see untouched."""
        cm, fo = self.real_day()
        doc = span_job.summarize_day(day, cm, fo)
        for e in doc['symbols'].values():
            e.pop('ic', None)
        doc['symbols']['NIFTY']['c'] = 22000.5    # a value the bhavcopy no longer gives: the rewrite must not touch it
        doc['symbols']['TCS']['ivAtm'] = {'expiry': '2026-10-27', 'strike': 2500, 'ce': 1, 'pe': 2, 'fut': None}
        return doc

    def put_history(self, doc: dict) -> Path:
        (self.root / 'history').mkdir(exist_ok=True)
        p = self.root / 'history' / f"{doc['date']}.json"
        p.write_text(json.dumps(doc, separators=(',', ':')))
        return p

    def test_a_plain_backfill_skips_a_day_on_disk_and_rewrite_adds_ic_to_it(self):
        day = date(2026, 10, 22)
        old = self.old_history(day)
        path = self.put_history(old)
        before = path.read_bytes()
        cm, fo = self.real_day()
        self.save_day(day, cm, fo)     # the raw files are still in the dated folder
        f = Fetcher({})
        plain = span_job.backfill_history(1, f, self.root, day, self.lines.append, lambda s: None)
        self.assertEqual(plain, (0, None))
        self.assertEqual(path.read_bytes(), before, 'a plain backfill leaves the day alone')

        rewritten = span_job.backfill_history(1, f, self.root, day, self.lines.append, lambda s: None, rewrite=True)
        self.assertEqual(rewritten, (1, None), self.lines)
        self.assertEqual(f.urls, [], 'the dated folder is read first: nothing was downloaded')
        new = json.loads(path.read_text())
        self.assertEqual(new['symbols']['NIFTY']['ic'], 22687.65)
        self.assertEqual(new['symbols']['BANKNIFTY']['ic'], 54925.7)
        for e in new['symbols'].values():
            e.pop('ic', None)
        self.assertEqual(new, old, 'every other field, the marks included, is as it was')
        self.assertTrue(any(l == '2026-10-22: rewritten with ic (1 of 1)' for l in self.lines), self.lines)
        self.assertEqual(list(self.root.rglob('*.tmp')), [])

        # a file that has its ic is done: neither read nor rewritten, so a stopped run resumes where it left off
        done = path.read_bytes()
        again = span_job.backfill_history(1, f, self.root, day, self.lines.append, lambda s: None, rewrite=True)
        self.assertEqual(again, (0, None))
        self.assertEqual((path.read_bytes(), f.urls), (done, []))

    def test_rewrite_downloads_a_day_that_is_not_on_disk_with_the_usual_pauses(self):
        cm, fo = self.real_day()
        d22, d21 = date(2026, 10, 22), date(2026, 10, 21)
        old22, old21 = self.old_history(d22), self.old_history(d21)
        p22, p21 = self.put_history(old22), self.put_history(old21)
        f = Fetcher({**self.zips(d22, cm, fo), **self.zips(d21, cm, fo)})
        sleeps: list[float] = []
        n = span_job.backfill_history(2, f, self.root, d22, self.lines.append, sleeps.append, delay=0.5, rewrite=True)
        self.assertEqual(n, (2, None), self.lines)
        self.assertEqual([u.rsplit('_', 3)[1] + ('CM' if '/cm/' in u else 'FO') for u in f.urls],
                         ['20261022CM', '20261022FO', '20261021CM', '20261021FO'])
        self.assertEqual(sleeps, [0.5] * 3, 'a pause before every request but the first')
        for p in (p22, p21):
            self.assertEqual(json.loads(p.read_text())['symbols']['NIFTY']['ic'], 22687.65)
        self.assertFalse((self.root / '2026-10-22').exists(), 'the downloads stay in memory')
        self.assertEqual(list(self.root.rglob('*.tmp')), [])

    def test_rewrite_keeps_a_day_nse_no_longer_serves_and_does_not_call_it_unpublished(self):
        d22, d21 = date(2026, 10, 22), date(2026, 10, 21)
        cm, fo = self.real_day()
        p22, p21 = self.put_history(self.old_history(d22)), self.put_history(self.old_history(d21))
        before = p22.read_bytes()
        f = Fetcher(self.zips(d21, cm, fo))    # 22 Oct answers 404
        n = span_job.backfill_history(2, f, self.root, d22, self.lines.append, lambda s: None, rewrite=True)
        self.assertEqual(n, (1, None), self.lines)
        self.assertEqual(p22.read_bytes(), before)
        self.assertIn('ic', json.loads(p21.read_text())['symbols']['NIFTY'])
        self.assertEqual(span_job.read_unpublished(self.root), set(), 'it has a file: it was published')
        self.assertTrue(any(l.startswith('2026-10-22: bhavcopies not available') for l in self.lines), self.lines)
        self.assertTrue(any(l.startswith('backfill: 2 of 2 days present (1 written') and l.endswith('1 kept without ic') for l in self.lines), self.lines)

    def test_rewrite_stops_after_failures_in_a_row_and_leaves_the_files_alone(self):
        days = [date(2026, 10, 22) - timedelta(days=i) for i in range(10) if (date(2026, 10, 22) - timedelta(days=i)).weekday() < 5]
        files = {d: self.put_history(self.old_history(d)) for d in days}
        before = {d: p.read_bytes() for d, p in files.items()}

        def refuse(url):
            raise RuntimeError('HTTP 403')
        n = span_job.backfill_history(len(days), refuse, self.root, date(2026, 10, 22), self.lines.append, lambda s: None, rewrite=True)
        self.assertEqual(n.written, 0)
        self.assertIn('failed days in a row', n.stopped)
        self.assertEqual(sum('failed: HTTP 403' in l for l in self.lines), span_job.BACKFILL_MAX_FAILURES)
        self.assertEqual({d: p.read_bytes() for d, p in files.items()}, before)

    def test_rewrite_replaces_a_history_file_that_is_not_json(self):
        day = date(2026, 10, 22)
        cm, fo = self.real_day()
        self.save_day(day, cm, fo)
        (self.root / 'history').mkdir()
        (self.root / 'history' / '2026-10-22.json').write_text('{"date": "2026-10-22", "symb')
        n = span_job.backfill_history(1, Fetcher({}), self.root, day, self.lines.append, lambda s: None, rewrite=True)
        self.assertEqual(n, (1, None), self.lines)
        doc = json.loads((self.root / 'history' / '2026-10-22.json').read_text())
        self.assertEqual(doc['symbols']['NIFTY']['ic'], 22687.65)
        self.assertEqual(doc['symbols']['TCS']['c'], 2506.9)

    def test_main_passes_rewrite_on_and_refuses_it_alone(self):
        calls = []
        with mock.patch.object(span_job, 'nse_fetcher', return_value=Fetcher({})), \
             mock.patch.object(span_job, 'backfill_history', side_effect=lambda *a, **k: calls.append((a, k)) or span_job.Backfill(0, None)):
            self.assertEqual(span_job.main(['--dir', str(self.root), '--date', '2026-10-22', '--backfill-history', '260', '--rewrite']), 0)
            self.assertEqual(span_job.main(['--dir', str(self.root), '--backfill-history', '260']), 0)
            self.assertEqual(span_job.main(['--dir', str(self.root), '--rewrite']), 2)
        self.assertEqual([k['rewrite'] for _, k in calls], [True, False], '--rewrite alone never reached the backfill')


class NseFetcherTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        stub = types.ModuleType('nsepythonserver')
        stub.headers = {'User-Agent': 'stub'}
        patcher = mock.patch.dict(sys.modules, {'nsepythonserver': stub})
        patcher.start()
        self.addCleanup(patcher.stop)

    @staticmethod
    def http_error(code):
        return urllib.error.HTTPError(AEL_URL, code, 'x', {}, None)

    def test_200_returns_bytes(self):
        resp = mock.MagicMock()
        resp.__enter__.return_value.read.return_value = b'data'
        with mock.patch('urllib.request.urlopen', return_value=resp):
            self.assertEqual(span_job.nse_fetcher()(AEL_URL), b'data')

    def test_404_is_not_yet(self):
        with mock.patch('urllib.request.urlopen', side_effect=self.http_error(404)):
            self.assertIsNone(span_job.nse_fetcher()(AEL_URL))

    def test_403_is_a_failure_not_not_yet(self):
        lines = []
        with mock.patch('urllib.request.urlopen', side_effect=self.http_error(403)):
            n = span_job.run_once(DAY, span_job.nse_fetcher(), Path(self._tmp.name), lambda: 1.0, lines.append)
        self.assertEqual(n, 0)
        self.assertTrue(any(line.endswith('failed: HTTP 403') for line in lines), lines)
        self.assertFalse(any('not yet' in line for line in lines), lines)
        self.assertEqual([p for p in Path(self._tmp.name).rglob('*') if p.is_file()], [])


if __name__ == '__main__':
    unittest.main()
