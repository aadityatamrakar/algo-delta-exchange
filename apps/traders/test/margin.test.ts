import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, symlinkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { spanMargin } from '@algomaker/span'
import { priceBook } from '../src/analytics/snapshot.ts'
import { MARGIN_CHECKED, SpanStore, UNCHECKED_NOTE, marginFor, parseSpanFileName, spanPositions } from '../src/analytics/margin.ts'
import { L1, L4, L5, R2_NOW, r2Legs, r2Market } from './fixtures/r2-book.ts'

const FIX = fileURLToPath(new URL('../../../packages/span/test/fixtures/', import.meta.url))
const MINI = readFileSync(join(FIX, 'mini.spn'), 'utf8')
const AEL = readFileSync(join(FIX, 'ael_19102026.csv'), 'utf8')
/** mini.spn with every risk-array value doubled: the same book margins higher. */
const DOUBLED = MINI.replace(/<a>(-?[\d.]+)<\/a>/g, (_m, v: string) => `<a>${Number(v) * 2}</a>`)

const S = priceBook('asha', 'TCS', r2Legs(), r2Market())
const MON_14_IST = Date.UTC(2026, 9, 19, 8, 30)
const MON_10_IST = Date.UTC(2026, 9, 19, 4, 30)
const savedAt = (h: number, m: number): number => Date.UTC(2026, 9, 19, h, m) - 5.5 * 3_600_000

const dirs: string[] = []
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

/** A fresh NSE folder: `files` maps `<day>/<name>` to its text; `saved` maps a file name to its manifest savedAt. */
function nse(files: Record<string, string>, saved: Record<string, number> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'traders-margin-'))
  dirs.push(root)
  const manifests = new Map<string, Record<string, unknown>>()
  for (const [rel, text] of Object.entries(files)) {
    const [day, name] = rel.split('/') as [string, string]
    mkdirSync(join(root, day), { recursive: true })
    writeFileSync(join(root, rel), text)
    const m = manifests.get(day) ?? {}
    m[name] = { name, url: `https://example.invalid/${name}`, savedAt: saved[name] ?? 0, bytes: text.length, sha256: '0' }
    manifests.set(day, m)
  }
  for (const [day, m] of manifests) writeFileSync(join(root, day, 'manifest.json'), JSON.stringify(m))
  return root
}

const EOD16 = 'nsccl.20261016.s.spn'
const I1 = 'nsccl.20261019.i1.spn'
const I2 = 'nsccl.20261019.i2.spn'
/** Friday's end of day, then today's two intraday files (the first twice as risky), and the exposure file. */
function fullDir(): string {
  return nse({
    [`2026-10-16/${EOD16}`]: MINI,
    [`2026-10-19/${I1}`]: DOUBLED,
    [`2026-10-19/${I2}`]: MINI,
    '2026-10-19/ael_19102026.csv': AEL,
  }, { [I1]: savedAt(11, 1), [I2]: savedAt(13, 31) })
}
/** A store that has read every file of the newest date: a pass parses at most one (final fix I4), and no folder here holds more than three. */
async function loaded(dir: string, symbols: readonly string[] = ['TCS'], now: number = R2_NOW): Promise<SpanStore> {
  const store = new SpanStore({ dir, now: () => now })
  for (let i = 0; i < 3; i++) await store.refresh(new Set(symbols))
  return store
}

test('file names', () => {
  assert.deepEqual(parseSpanFileName('nsccl.20261019.i2.spn'), { kind: 'intraday', businessDate: '2026-10-19', seq: 2 })
  assert.deepEqual(parseSpanFileName('nsccl.20261016.s.spn'), { kind: 'eod', businessDate: '2026-10-16', seq: 99 })
  assert.equal(parseSpanFileName('notes.txt'), null)
  assert.equal(parseSpanFileName('nsccl.20261319.i2.spn'), null)
})

test('an exposure file saved gzipped, as NSE serves it, reads the same as the plain one', async () => {
  const plain = await loaded(nse({ [`2026-10-16/${EOD16}`]: MINI, '2026-10-16/ael_16102026.csv': AEL }), ['TCS'], MON_14_IST)
  const dir = nse({ [`2026-10-16/${EOD16}`]: MINI })
  writeFileSync(join(dir, '2026-10-16', 'ael_16102026.csv'), gzipSync(AEL))
  const zipped = await loaded(dir, ['TCS'], MON_14_IST)
  assert.equal(zipped.exposure()?.source.file, 'ael_16102026.csv')
  assert.ok(zipped.exposure()!.rates.size > 0)
  assert.deepEqual([...zipped.exposure()!.rates], [...plain.exposure()!.rates])
})

test('the newest file wins and is named', async () => {
  const store = await loaded(fullDir())
  const span = store.span()!
  assert.deepEqual([span.source.file, span.source.label, span.source.businessDate, span.source.savedAt], [I2, 'NSE SPAN 13:31', '2026-10-19', savedAt(13, 31)])
  assert.deepEqual(store.today().map((x) => x.source.label), ['NSE SPAN 11:01', 'NSE SPAN 13:31'])
  assert.deepEqual(store.exposure()!.source, { file: 'ael_19102026.csv', label: 'NSE exposure 19 Oct', businessDate: '2026-10-19', savedAt: null })
  assert.equal(store.lastError(), null)
})

test('an end-of-day file is labelled by its business date', async () => {
  const store = await loaded(nse({ [`2026-10-16/${EOD16}`]: MINI }))
  assert.equal(store.span()!.source.label, 'NSE SPAN end of day 16 Oct')
  assert.equal(store.exposure(), null)
})

test('the book’s margin equals spanMargin on its positions', async () => {
  const store = await loaded(fullDir())
  const m = marginFor(S, new Set(), store, R2_NOW)
  const direct = spanMargin(spanPositions(S, new Set()), store.span()!.file, store.exposure()!.rates)
  assert.deepEqual([m.initial, m.exposure, m.total], [direct.initial, direct.exposure, direct.total])
  assert.ok(direct.total > 0)
  assert.deepEqual(m.parts, {
    scanningRisk: direct.scanningRisk, worstScenario: direct.worstScenario, interMonthSpread: direct.interMonthSpread,
    shortOptionMinimum: direct.shortOptionMinimum, netOptionValue: direct.netOptionValue,
  })
  assert.equal(m.available, true)
  assert.ok(m.notes.includes('Shares are cash segment: not in SPAN'))
  assert.equal(m.exposureFile!.label, 'NSE exposure 19 Oct')
})

test('shares never reach spanMargin; excluded legs are left out and counted', async () => {
  const keys = (ex: ReadonlySet<string>) => spanPositions(S, ex).map((p) => `${p.kind}|${p.expiry}|${p.strike ?? ''}|${p.optType ?? ''}`)
  assert.equal(keys(new Set()).length, 4)                       // six legs, minus the share and L6 (3050 CE: not in the master)
  assert.ok(spanPositions(S, new Set()).every((p) => p.symbol === 'TCS' && Number.isFinite(p.qty)))
  assert.equal(keys(new Set([L1, L4])).length, 2)
  const store = await loaded(fullDir())
  const m = marginFor(S, new Set([L1, L4, L5]), store, R2_NOW)
  assert.ok(m.notes.includes('2 unticked leg(s) left out'), m.notes.join(' | '))     // the share is not a SPAN leg: not counted
  assert.equal(marginFor(S, new Set(), store, R2_NOW).notes.some((n) => n.includes('unticked')), false)
})

test('a contract not in the file is named and the figure marked partial (Review Focus 5)', async () => {
  const store = await loaded(fullDir())
  const m = marginFor(S, new Set(), store, R2_NOW)
  assert.ok(m.notes.includes('not in the SPAN file: option|2026-10-27|3100|CE — the figure is partial'), m.notes.join(' | '))
  assert.ok(m.missing.includes('option|2026-10-27|3100|CE'))
  assert.ok(m.missing.includes('option|2026-11-23|3000|CE'))
  // leaving the missing legs out removes their notes and nothing else is silently dropped
  const whole = marginFor(S, new Set(), store, R2_NOW)
  assert.ok(whole.missing.length >= 3)
})

test('a leg the master could not place is named too, never silently left out', async () => {
  const store = await loaded(fullDir())
  const unplaced = priceBook('asha', 'TCS', [...r2Legs(), { ...r2Legs()[0]!, strike: 3333, key: 'asha|option|TCS|2026-10-27|3333|CE', token: null }], r2Market())
  assert.equal(unplaced.unmatched.length, 2)         // L6 and the added 3333
  const m = marginFor(unplaced, new Set(), store, R2_NOW)
  assert.ok(m.notes.some((n) => n.startsWith('not in the SPAN file: ') && n.includes('3333') && n.endsWith('— the figure is partial')), m.notes.join(' | '))
  assert.ok(m.missing.some((k) => k.includes('3333')))
})

test('peak is the highest of today’s files', async () => {
  const store = await loaded(fullDir())
  const m = marginFor(S, new Set(), store, R2_NOW)
  assert.equal(m.span!.file, I2)
  assert.equal(m.peak!.label, 'NSE SPAN 11:01')
  assert.ok(m.peak!.total > m.total!)
  assert.ok(m.notes.includes("Peak = highest of 19 Oct's NSE SPAN files (our reading of VolHedge's peak-margin line)"), m.notes.join(' | '))
})

test('the peak note names the files\' own date: on Monday morning that is Friday\'s (final fix M3)', async () => {
  const m = marginFor(S, new Set(), await loaded(nse({ [`2026-10-16/${EOD16}`]: MINI, '2026-10-16/ael_16102026.csv': AEL })), MON_10_IST)
  assert.ok(m.notes.includes("Peak = highest of 16 Oct's NSE SPAN files (our reading of VolHedge's peak-margin line)"), m.notes.join(' | '))
  assert.equal(m.notes.some((n) => n.includes("today's")), false)
})

test('a single file today is its own peak', async () => {
  const m = marginFor(S, new Set(), await loaded(nse({ [`2026-10-19/${I2}`]: MINI, '2026-10-19/ael_19102026.csv': AEL }, { [I2]: savedAt(13, 31) })), R2_NOW)
  assert.deepEqual(m.peak, { total: m.total, label: 'NSE SPAN 13:31' })
})

test('only the books’ symbols are kept in memory', async () => {
  const dir = fullDir()
  const store = await loaded(dir, ['INFY'])
  assert.equal(store.span()!.file.commodities.size, 0)
  await store.refresh(new Set(['TCS']))           // the set grew: the files are read again, the newest first
  assert.deepEqual([...store.span()!.file.commodities.keys()], ['TCS'])
  assert.equal(store.today()[0]!.file.commodities.size, 0)
  await store.refresh(new Set(['TCS']))           // then one older file a pass
  assert.deepEqual([...store.today()[0]!.file.commodities.keys()], ['TCS'])
})

test('a pass parses at most one file: the newest first, then one older file of the date a pass (final fix I4)', async () => {
  const store = new SpanStore({ dir: fullDir(), now: () => R2_NOW })
  await store.refresh(new Set(['TCS']))
  assert.deepEqual([store.span()!.source.file, store.today().map((x) => x.source.file), store.dayFiles()], [I2, [I2], 2])
  // the peak covers what is read so far, and says how much of the day that is
  const first = marginFor(S, new Set(), store, R2_NOW)
  assert.deepEqual(first.peak, { total: first.total, label: 'NSE SPAN 13:31' })
  assert.ok(first.notes.includes("Peak = highest of 19 Oct's NSE SPAN files — 1 of 2 read so far (our reading of VolHedge's peak-margin line)"), first.notes.join(' | '))
  await store.refresh(new Set(['TCS']))
  assert.deepEqual(store.today().map((x) => x.source.file), [I1, I2])
  const all = marginFor(S, new Set(), store, R2_NOW)
  assert.equal(all.peak!.label, 'NSE SPAN 11:01')
  assert.ok(all.notes.includes("Peak = highest of 19 Oct's NSE SPAN files (our reading of VolHedge's peak-margin line)"), all.notes.join(' | '))
  // a third pass has nothing left to parse: the same objects stay
  const before = store.today()
  await store.refresh(new Set(['TCS']))
  assert.deepEqual(store.today().map((x) => x.file), before.map((x) => x.file))
  assert.ok(store.today().every((x, i) => x.file === before[i]!.file))
})

test('when the stocks grow, a book of a new stock counts only the files read for it (final fix I4)', async () => {
  const store = await loaded(fullDir(), ['INFY'])
  await store.refresh(new Set(['INFY', 'TCS']))
  assert.deepEqual(store.today().map((x) => [...x.symbols].sort()), [['INFY'], ['INFY', 'TCS']])
  const m = marginFor(S, new Set(), store, R2_NOW)
  assert.equal(m.peak!.label, 'NSE SPAN 13:31')
  assert.ok(m.notes.includes("Peak = highest of 19 Oct's NSE SPAN files — 1 of 2 read so far (our reading of VolHedge's peak-margin line)"), m.notes.join(' | '))
})

test('a file that does not parse is not counted as one still to read (final fix I4)', async () => {
  const dir = fullDir()
  writeFileSync(join(dir, '2026-10-19', 'nsccl.20261019.i3.spn'), MINI.slice(0, 400))
  const store = await loaded(dir)
  assert.deepEqual([store.today().map((x) => x.source.file), store.dayFiles()], [[I1, I2], 2])
  assert.ok(marginFor(S, new Set(), store, R2_NOW).notes.includes("Peak = highest of 19 Oct's NSE SPAN files (our reading of VolHedge's peak-margin line)"))
})

test('only the newest business date is kept', async () => {
  const store = await loaded(fullDir())
  assert.deepEqual(store.today().map((x) => x.source.file), [I1, I2])
})

test('every figure is finite or null', async () => {
  const store = await loaded(fullDir())
  for (const m of [marginFor(S, new Set(), store, R2_NOW), marginFor(S, new Set(r2Legs().map((l) => l.key)), store, R2_NOW)]) {
    for (const v of [m.initial, m.exposure, m.total, m.peak?.total, ...Object.values(m.parts ?? {})]) {
      assert.ok(v === undefined || v === null || Number.isFinite(v), String(v))
    }
  }
})

test('stale: past 13:00 IST with no intraday file today', async () => {
  const store = await loaded(nse({ [`2026-10-16/${EOD16}`]: MINI, '2026-10-16/ael_16102026.csv': AEL }), ['TCS'], MON_14_IST)
  assert.equal(marginFor(S, new Set(), store, MON_14_IST).stale, true)
  assert.equal(marginFor(S, new Set(), store, MON_10_IST).stale, false)      // Friday’s EOD is current at 10:00 on Monday
  assert.equal(marginFor(S, new Set(), store, Date.UTC(2026, 9, 19, 11, 0)).stale, false)      // 16:30 IST, market closed
})

test('stale: a weekday NSE holiday is no session, so its afternoon is not stale for want of an intraday file (R3 final fix I1)', async () => {
  const fresh = await loaded(fullDir(), ['TCS'], MON_14_IST)
  assert.equal(marginFor(S, new Set(), fresh, Date.parse('2026-10-20T14:00:00+05:30')).stale, false)      // Tuesday, Dussehra: Monday's files are the last session's
})

test('stale: an intraday file today makes the afternoon current; a file older than the last session is stale at once', async () => {
  const fresh = await loaded(fullDir(), ['TCS'], MON_14_IST)
  assert.equal(marginFor(S, new Set(), fresh, MON_14_IST).stale, false)
  const old = await loaded(nse({ '2026-10-14/nsccl.20261014.s.spn': MINI }), ['TCS'], MON_10_IST)
  assert.equal(marginFor(S, new Set(), old, MON_10_IST).stale, true)
})

test('a file that does not parse keeps the last good one', async () => {
  const dir = fullDir()
  const store = await loaded(dir)
  writeFileSync(join(dir, '2026-10-19', 'nsccl.20261019.i3.spn'), MINI.slice(0, 400))
  await store.refresh(new Set(['TCS']))
  assert.equal(store.span()!.source.file, I2)
  assert.match(store.lastError()!, /^nsccl\.20261019\.i3\.spn did not parse: /)
  const m = marginFor(S, new Set(), store, R2_NOW)
  assert.ok(m.notes.some((n) => n.startsWith('nsccl.20261019.i3.spn did not parse: ') && n.endsWith('; showing nsccl.20261019.i2.spn')), m.notes.join(' | '))
  assert.equal(m.available, true)
  rmSync(join(dir, '2026-10-19', 'nsccl.20261019.i3.spn'))
  await store.refresh(new Set(['TCS']))
  assert.equal(store.lastError(), null)
})

test('a new day whose only file is bad keeps yesterday’s', async () => {
  const dir = nse({ [`2026-10-16/${EOD16}`]: MINI })
  const store = await loaded(dir)
  mkdirSync(join(dir, '2026-10-19'))
  writeFileSync(join(dir, '2026-10-19', I1), '<spanFile>')
  await store.refresh(new Set(['TCS']))
  assert.equal(store.span()!.source.file, EOD16)
  assert.match(store.lastError()!, /^nsccl\.20261019\.i1\.spn did not parse/)
})

test('an exposure file that does not parse is named, and the exposure is not guessed', async () => {
  const dir = nse({ [`2026-10-19/${I2}`]: MINI, '2026-10-19/ael_19102026.csv': 'nonsense\n' }, { [I2]: savedAt(13, 31) })
  const store = await loaded(dir)
  assert.equal(store.exposure(), null)
  const m = marginFor(S, new Set(), store, R2_NOW)
  assert.ok(m.notes.some((n) => n.startsWith('ael_19102026.csv did not parse: ')), m.notes.join(' | '))
  assert.ok(m.notes.includes('exposure rate for TCS missing: no NSE exposure file read — the figure is partial'), m.notes.join(' | '))
  assert.equal(m.notes.some((n) => n.startsWith('not in the SPAN file: exposure rate')), false)
})

test('an exposure file without the symbol is named as the file the rate is missing from, not the SPAN file (final fix M3)', async () => {
  const noTcs = AEL.split('\n').filter((l) => !l.includes(',TCS,')).join('\n')
  const m = marginFor(S, new Set(), await loaded(nse({ [`2026-10-19/${I2}`]: MINI, '2026-10-19/ael_19102026.csv': noTcs }, { [I2]: savedAt(13, 31) })), R2_NOW)
  assert.ok(m.missing.includes('exposure rate for TCS'))
  assert.ok(m.notes.includes('exposure rate for TCS missing from ael_19102026.csv — the figure is partial'), m.notes.join(' | '))
  assert.equal(m.notes.some((n) => n.startsWith('not in the SPAN file: exposure rate')), false)
  // a contract the SPAN file lacks keeps its own sentence
  assert.ok(m.notes.includes('not in the SPAN file: option|2026-10-27|3100|CE — the figure is partial'))
})

test('until the Q6 golden books pass, every margin figure says it is unchecked (final fix I2)', async () => {
  assert.equal(MARGIN_CHECKED, false)
  assert.equal(UNCHECKED_NOTE, "Not yet checked against a broker's margin figure (Phase 0 Q6)")
  const m = marginFor(S, new Set(), await loaded(fullDir()), R2_NOW)
  assert.equal(m.available, true)
  assert.equal(m.notes[0], UNCHECKED_NOTE)
  // no figure, nothing to qualify
  assert.equal(marginFor(S, new Set(), await loaded(nse({})), R2_NOW).notes.includes(UNCHECKED_NOTE), false)
})

test('no file yet shows nothing, with the sentence', async () => {
  const empty = await loaded(nse({}))
  const gone = await loaded(join(tmpdir(), 'traders-margin-no-such-dir'))
  for (const store of [empty, gone]) {
    assert.equal(store.span(), null)
    assert.deepEqual(store.today(), [])
    const m = marginFor(S, new Set(), store, R2_NOW)
    assert.deepEqual(
      [m.available, m.initial, m.exposure, m.total, m.peak, m.parts, m.span, m.exposureFile, m.stale, m.missing, m.notes],
      [false, null, null, null, null, null, null, null, false, [], ['No NSE SPAN file yet — margin appears once the span job has saved one']],
    )
  }
})

test('a refresh while a file is half written does not throw', async () => {
  const store = new SpanStore({ dir: nse({ [`2026-10-19/${I1}`]: '' }), now: () => R2_NOW })
  await store.refresh(new Set(['TCS']))
  assert.equal(store.span(), null)
  assert.ok(store.lastError() !== null)
})

test('a stray file and a symlink named like a date folder do not break the scan', async () => {
  const dir = fullDir()
  writeFileSync(join(dir, '2026-10-25'), 'a file, not a folder')
  symlinkSync(join(dir, 'no-such-target'), join(dir, '2026-10-26'))
  symlinkSync(join(dir, '2026-10-19'), join(dir, '2026-10-24'))
  const store = await loaded(dir)
  assert.equal(store.span()!.source.file, I2)
  assert.equal(store.exposure()!.source.file, 'ael_19102026.csv')
})

test('a refresh with a larger symbol set, while one runs, is not dropped', async () => {
  const store = new SpanStore({ dir: fullDir(), now: () => R2_NOW })
  const first = store.refresh(new Set(['INFY']))
  const second = store.refresh(new Set(['INFY', 'TCS']))      // joins nothing: the running pass did not parse for TCS
  await Promise.all([first, second])
  assert.deepEqual([...store.span()!.file.commodities.keys()], ['TCS'])
  const same = store.refresh(new Set(['TCS']))
  assert.equal(await same, undefined)
})

test('intraday versus end of day is decided by the file’s kind', async () => {
  // an end-of-day file whose name contains ".i" elsewhere cannot be taken for an intraday one: only the parsed kind counts
  const dir = nse({ [`2026-10-19/${'nsccl.20261019.s.spn'}`]: MINI, '2026-10-19/ael_19102026.csv': AEL })
  const store = await loaded(dir, ['TCS'], MON_14_IST)
  assert.deepEqual(store.today().map((x) => x.kind), ['eod'])
  assert.equal(marginFor(S, new Set(), store, MON_14_IST).stale, true)
})

test('only the newest ten date folders are looked into', async () => {
  const files: Record<string, string> = { [`2026-09-01/nsccl.20260901.s.spn`]: MINI }
  for (let d = 5; d <= 16; d++) files[`2026-10-${String(d).padStart(2, '0')}/readme.txt`] = 'x'
  const store = await loaded(nse(files))
  assert.equal(store.span(), null)
})

test('when every file fails and none was ever good, the no-file view carries the error after the sentence', async () => {
  const store = await loaded(nse({ [`2026-10-19/${I1}`]: '<spanFile>' }))
  const m = marginFor(S, new Set(), store, R2_NOW)
  assert.equal(m.available, false)
  assert.equal(m.notes[0], 'No NSE SPAN file yet — margin appears once the span job has saved one')
  assert.match(m.notes[1]!, /^nsccl\.20261019\.i1\.spn did not parse: /)
  assert.equal(m.notes.length, 2)
})
