/**
 * `syncBseFreezeLimits` — SENSEX's freeze row, from BSE's own contract master.
 *
 * NSE's qtyfreeze.csv carries no BSE underlying, so `desk-freeze-limits` had
 * no SENSEX row and every SENSEX order was planned `freezeUnknown` (spec D5;
 * 34/34 SENSEX paper orders on 2026-09-16/17). This sync fills the gap from
 * `Abridged_CO.ZIP` with the same fail-soft contract as the NSE sync: a bad
 * download leaves the stored rows EXACTLY as they were.
 *
 * The NSE rows and the BSE rows share one collection keyed by symbol. NSE rows
 * are written `{symbol, freezeQty}` with no provenance, so the rule that keeps
 * the two from overwriting each other is: this sync only ever writes a symbol
 * that is absent or already stamped `source: 'bse-contract-master'`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildZip } from './zip-fixture.ts'
import { syncBseFreezeLimits, syncFreezeLimits, BSE_FREEZE_SOURCE, type SyncCollection } from '../src/sync-runner.ts'

const HEADER = 'FinInstrmId,UndrlygFinInstrmId,FinInstrmNm,TckrSymb,XpryDt,StrkPric,OptnTp,PrtdToTrad,MinLot,NewBrdLotQty,BidIntrvl,StartDt,EndDt,MtrtyDt,PdctStartDt,SrsId,AsstCd,UndrlygInstrmAsstClss,StockNm,SttlmMtd,BasePric,DelFlg,ExrcStartDt,ExrcEndDt,IssdCptl,MinPric,MaxPric,MktTpAndId,OffclCorpActnEvtId,AdmssnTp,IssePric,TradgStsNrmlMkt,ElgbltyNrmlMkt,TradgStsOddLotMkt,ElgbltyOddLotMkt,TradgStsSpotMkt,ElgbltySpotMkt,TradgStsAuctnMkt,ElgbltyAuctnMkt,MrgnPctg,MaxTradQty'
const SENSEX_IF = '844615,1,IF,SENSEX,24-SEP-2026,0,,0,20,20,5,29-JUN-2026,24-SEP-2026,,,,BSX,EDX,SENSEX26SEPFUT,C,7490680,A,24-SEP-2026,24-SEP-2026,,,,,,,,1,,,,,,,,,500'
const SENSEX_IO = '1132375,1,IO,SENSEX,01-OCT-2026,6700000,CE,1,20,20,5,16-SEP-2026,01-OCT-2026,,,,BSX,EDX,SENSEX26O0167000CE,C,795985,A,01-OCT-2026,01-OCT-2026,,,,,,,,0,,,,,,,,,1000'
const ROWS = [
  SENSEX_IF,
  SENSEX_IO,
  '845529,12,IF,BANKEX,24-SEP-2026,0,,0,30,30,5,29-JUN-2026,24-SEP-2026,,,,BKX,EDX,BANKEX26SEPFUT,C,6394230,A,24-SEP-2026,24-SEP-2026,,,,,,,,1,,,,,,,,,600',
  '1132083,12,IO,BANKEX,26-NOV-2026,5620000,CE,1,30,30,5,16-SEP-2026,26-NOV-2026,,,,BKX,EDX,BANKEX26NOV56200CE,C,821125,A,26-NOV-2026,26-NOV-2026,,,,,,,,0,,,,,,,,,900',
  '1134585,75,IO,FOCIT,26-NOV-2026,2790000,CE,1,45,45,5,21-SEP-2026,26-NOV-2026,,,,BIT,EDX,FOCIT26NOV27900CE,C,733280,A,26-NOV-2026,26-NOV-2026,,,,,,,,0,,,,,,,,,1350',
  '1134530,500325,SO,RELIANCE,26-NOV-2026,116000,CE,0,500,500,5,21-SEP-2026,26-NOV-2026,,,,RELI,EDX,RELIANCE26NOV1160CE,D,10940,A,26-NOV-2026,26-NOV-2026,,,,,,,,0,,,,,,,,,10000',
]
const FIXTURE = [HEADER, ...ROWS].join('\n')

const ENTRY = 'BSE_EQD_CONTRACT_abr_21092026.csv'
const zipOf = (csv: string, extraFirst?: { name: string; body: string }): Buffer =>
  buildZip([
    ...(extraFirst === undefined ? [] : [{ name: extraFirst.name, data: Buffer.from(extraFirst.body), method: 8 as const }]),
    { name: ENTRY, data: Buffer.from(csv), method: 8 as const },
  ])

interface Upsert {
  readonly filter: Record<string, unknown>
  readonly update: Record<string, unknown>
  readonly options: { upsert?: boolean } | undefined
}

/** The four calls `SyncCollection` needs, recorded. `find` answers from `docs`. */
class FakeSyncCollection implements SyncCollection {
  readonly upserts: Upsert[] = []
  readonly indexes: Record<string, unknown>[] = []
  readonly docs: Record<string, unknown>[]
  constructor(docs: Record<string, unknown>[] = []) {
    this.docs = docs
  }
  find(filter: Record<string, unknown>): { toArray(): Promise<Record<string, unknown>[]> } {
    const sym = filter['symbol'] as { $in?: string[] } | undefined
    const wanted = sym?.$in
    return {
      toArray: async () => this.docs.filter((d) => wanted === undefined || wanted.includes(String(d['symbol']))),
    }
  }
  async updateOne(filter: Record<string, unknown>, update: Record<string, unknown>, options?: { upsert?: boolean }): Promise<unknown> {
    this.upserts.push({ filter, update, options })
    return {}
  }
  async deleteMany(): Promise<unknown> {
    return {}
  }
  async createIndex(spec: Record<string, 1 | -1>, options?: { unique?: boolean }): Promise<unknown> {
    this.indexes.push({ spec, options })
    return 'ok'
  }
}

const NOW = new Date(Date.UTC(2026, 8, 21, 3, 15))

function harness(zip: () => Promise<Buffer>, docs: Record<string, unknown>[] = []) {
  const col = new FakeSyncCollection(docs)
  const logs: { msg: string; ctx: Record<string, unknown> | undefined }[] = []
  const run = (): Promise<number | null> =>
    syncBseFreezeLimits({ collection: col, fetchBseZip: zip, now: () => NOW, log: (msg, ctx) => logs.push({ msg, ctx }) })
  return { col, logs, run }
}

test('writes one row per index symbol with source and syncedAt, and returns the count', async () => {
  const h = harness(async () => zipOf(FIXTURE))
  assert.equal(await h.run(), 3)

  const set = (symbol: string): Record<string, unknown> | undefined =>
    (h.col.upserts.find((u) => u.filter['symbol'] === symbol)?.update['$set'] as Record<string, unknown> | undefined)
  assert.deepEqual(set('SENSEX'), { symbol: 'SENSEX', freezeQty: 500, lotSize: 20, source: BSE_FREEZE_SOURCE, syncedAt: NOW.getTime() })
  assert.deepEqual(set('BANKEX'), { symbol: 'BANKEX', freezeQty: 600, lotSize: 30, source: BSE_FREEZE_SOURCE, syncedAt: NOW.getTime() })
  assert.deepEqual(set('FOCIT'), { symbol: 'FOCIT', freezeQty: 1350, lotSize: 45, source: BSE_FREEZE_SOURCE, syncedAt: NOW.getTime() })
  assert.equal(set('RELIANCE'), undefined, 'stock rows never reach the table')
  assert.ok(h.col.upserts.every((u) => u.options?.upsert === true))
  assert.deepEqual(h.col.indexes, [{ spec: { symbol: 1 }, options: { unique: true } }])
  assert.equal(BSE_FREEZE_SOURCE, 'bse-contract-master')
  assert.ok(h.logs.some((l) => l.msg === 'BSE freeze limits synced'))
})

test('a fetch failure returns null and touches nothing', async () => {
  const h = harness(async () => {
    throw new Error('ECONNRESET')
  })
  assert.equal(await h.run(), null)
  assert.equal(h.col.upserts.length, 0)
  assert.ok(h.logs.some((l) => /BSE freeze sync FAILED/.test(l.msg)))
})

test('fewer than 2 index symbols is a truncated file — refused', async () => {
  const h = harness(async () => zipOf([HEADER, SENSEX_IF, SENSEX_IO].join('\n')))
  assert.equal(await h.run(), null)
  assert.equal(h.col.upserts.length, 0)
  assert.ok(h.logs.some((l) => /BSE freeze sync FAILED/.test(l.msg) && /truncated/.test(String(l.ctx?.['error']))))
})

test('a freezeQty that is not a multiple of the lot is refused', async () => {
  // MaxTradQty is in contracts and BSE quotes it in whole lots; a value the
  // lot does not divide means the column, or the unit, is not what we think.
  const bad = SENSEX_IF.replace(/,500$/, ',510')
  const h = harness(async () => zipOf([HEADER, bad, SENSEX_IO, ...ROWS.slice(2)].join('\n')))
  assert.equal(await h.run(), null)
  assert.equal(h.col.upserts.length, 0)
  assert.ok(h.logs.some((l) => /BSE freeze sync FAILED/.test(l.msg) && /SENSEX/.test(String(l.ctx?.['error']))))
})

test('a symbol already present WITHOUT the BSE source is never overwritten', async () => {
  // An NSE row is `{symbol, freezeQty}` with no `source`. If NSE ever lists
  // SENSEX, or an operator hand-inserts a row, this sync must not clobber it.
  const h = harness(async () => zipOf(FIXTURE), [{ symbol: 'SENSEX', freezeQty: 999 }])
  assert.equal(await h.run(), 2)
  assert.deepEqual(h.col.upserts.map((u) => u.filter['symbol']).sort(), ['BANKEX', 'FOCIT'])
  assert.ok(h.logs.some((l) => /SENSEX.*not from this source/.test(l.msg + ' ' + JSON.stringify(l.ctx ?? {}))))
})

test('a symbol already stamped with the BSE source IS refreshed', async () => {
  const h = harness(async () => zipOf(FIXTURE), [{ symbol: 'SENSEX', freezeQty: 400, source: BSE_FREEZE_SOURCE }])
  assert.equal(await h.run(), 3)
  assert.ok(h.col.upserts.some((u) => u.filter['symbol'] === 'SENSEX'))
})

test('the zip entry is chosen by name, not position', async () => {
  const h = harness(async () => zipOf(FIXTURE, { name: 'EQD_CO_abr_210926.csv', body: 'not,the,file\n1,2,3\n' }))
  assert.equal(await h.run(), 3)
})

test('an NSE write clears the BSE provenance stamp, so the next BSE run cannot overwrite it', async () => {
  // The "never overwrite a row without the BSE stamp" rule above only holds
  // if a row NSE has written does not CARRY the stamp. NSE's qtyfreeze.csv
  // lists no BSE underlying today, but if it ever listed SENSEX the NSE sync
  // would `$set` freezeQty onto the existing BSE-stamped document — and with
  // `source` left in place the very next BSE run would put its own number
  // back, the opposite of the stated guarantee. So the NSE write must
  // `$unset` the three BSE-only fields; a document NSE has touched then looks
  // exactly like one NSE created, and the BSE sync skips it.
  const nseCsv = ['SR_NO,SYMBOL,VOL_FRZ_QTY', ...Array.from({ length: 60 }, (_, i) => `${i + 1},STOCK${i + 1},${(i + 1) * 100}`), '61,SENSEX,700'].join('\n')
  const col = new FakeSyncCollection([{ symbol: 'SENSEX', freezeQty: 500, lotSize: 20, source: BSE_FREEZE_SOURCE, syncedAt: NOW.getTime() }])
  assert.equal(await syncFreezeLimits({ collection: col, fetchFreeze: async () => nseCsv }), 61)

  const sensex = col.upserts.find((u) => u.filter['symbol'] === 'SENSEX')
  assert.deepEqual(sensex?.update, {
    $set: { symbol: 'SENSEX', freezeQty: 700 },
    $unset: { source: '', lotSize: '', syncedAt: '' },
  })

  // And the round trip: the document as NSE leaves it has no stamp, so the
  // BSE sync leaves SENSEX alone and writes only the other two.
  const h = harness(async () => zipOf(FIXTURE), [{ symbol: 'SENSEX', freezeQty: 700 }])
  assert.equal(await h.run(), 2)
  assert.deepEqual(h.col.upserts.map((u) => u.filter['symbol']).sort(), ['BANKEX', 'FOCIT'])
})
