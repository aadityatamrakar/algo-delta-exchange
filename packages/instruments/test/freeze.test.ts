import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FreezeLimits,
  parseFreezeCsv,
  splitIntoTranches,
  exceedsFreeze,
  parseBseContractCsv,
} from '../src/freeze.ts'

/** The real header and row shape of NSE's qtyfreeze.csv, padding included. */
const CSV = [
  'S.No.,SYMBOL    ,VOL_FRZ_QTY    ',
  '1    ,BANKNIFTY ,600            ',
  '2    ,FINNIFTY  ,1800           ',
  '3    ,NIFTY     ,1800           ',
  '4    ,MIDCPNIFTY,2800           ',
  '5    ,BHEL      ,52500          ',
  '6    ,KALYANKJIL,67500          ',
].join('\n')

test('parses NSE qtyfreeze.csv, trimming its padding', () => {
  const rows = parseFreezeCsv(CSV)
  assert.equal(rows.length, 6)
  assert.deepEqual(rows[0], { symbol: 'BANKNIFTY', freezeQty: 600 })
  assert.equal(rows.find((r) => r.symbol === 'BHEL')?.freezeQty, 52500)
})

test('malformed rows are skipped rather than poisoning the table', () => {
  const rows = parseFreezeCsv(['S.No.,SYMBOL,VOL_FRZ_QTY', '1,,600', '2,X,notanumber', '3,Y,0', '4,Z,900'].join('\n'))
  assert.deepEqual(rows, [{ symbol: 'Z', freezeQty: 900 }])
})

test('maxLotsPerOrder = floor(freezeQty / lotSize) — verified against NSE', () => {
  const f = new FreezeLimits(parseFreezeCsv(CSV))
  assert.equal(f.maxLotsPerOrder('NIFTY', 65), 27)
  assert.equal(f.maxLotsPerOrder('BANKNIFTY', 30), 20)
})

test('the formula reproduces the legacy table where the lot has NOT changed', () => {
  // xtsOrder.js:15-21 hardcodes NIFTY 27 and BANKNIFTY 20. Agreement on the
  // unchanged symbols is what establishes the formula is the right one.
  const f = new FreezeLimits(parseFreezeCsv(CSV))
  assert.equal(f.maxLotsPerOrder('NIFTY', 65), 27, 'legacy NIFTY 27')
  assert.equal(f.maxLotsPerOrder('BANKNIFTY', 30), 20, 'legacy BANKNIFTY 20')
})

test('and DISAGREES where the exchange revised the lot — legacy is stale', () => {
  // FINNIFTY's legacy 45 was correct at lot 40 (1800/40); the lot is now 60, so
  // the true limit is 30. MIDCPNIFTY's 56 was correct at lot 50; now 120 -> 23.
  // Both legacy values EXCEED the freeze limit, so orders sized against them
  // are rejected by the exchange.
  const f = new FreezeLimits(parseFreezeCsv(CSV))
  assert.equal(f.maxLotsPerOrder('FINNIFTY', 60), 30)
  assert.notEqual(f.maxLotsPerOrder('FINNIFTY', 60), 45)
  assert.equal(f.maxLotsPerOrder('MIDCPNIFTY', 120), 23)
  assert.notEqual(f.maxLotsPerOrder('MIDCPNIFTY', 120), 56)
})

test('BHEL — the desk symbol — allows 20 lots per order', () => {
  const f = new FreezeLimits(parseFreezeCsv(CSV))
  assert.equal(f.maxLotsPerOrder('BHEL', 2625), 20)
  // The book's 15-lot wing fits in one order; a 20+ lot order would not.
  assert.equal(exceedsFreeze(15, 20), false)
  assert.equal(exceedsFreeze(21, 20), true)
})

test('an UNKNOWN symbol returns null — never an implicit infinity', () => {
  // This is the live defect: xtsOrder.js:104 does `qty <= undefined`, which is
  // false, and falls into tranches(qty, undefined). Null must be visible.
  const f = new FreezeLimits(parseFreezeCsv(CSV))
  assert.equal(f.maxLotsPerOrder('NOTLISTED', 100), null)
  assert.equal(f.freezeQty('NOTLISTED'), null)
})

test('a zero or missing lot size yields null, not a divide-by-zero', () => {
  const f = new FreezeLimits(parseFreezeCsv(CSV))
  assert.equal(f.maxLotsPerOrder('NIFTY', 0), null)
  assert.equal(f.maxLotsPerOrder('NIFTY', -5), null)
})

test('a freeze smaller than one lot still permits one lot', () => {
  // Otherwise the symbol becomes untradeable entirely, which is never right.
  const f = new FreezeLimits([{ symbol: 'ODD', freezeQty: 10 }])
  assert.equal(f.maxLotsPerOrder('ODD', 100), 1)
})

// ------------------------------------------------------------------ splitting

test('an order under the limit is a single tranche', () => {
  assert.deepEqual(splitIntoTranches(15, 20), [15])
  assert.deepEqual(splitIntoTranches(20, 20), [20], 'exactly at the limit is allowed')
})

test('an oversized order splits into tranches that SUM EXACTLY', () => {
  // A split that loses or invents a lot leaves a position silently different
  // from the intent — worse than not splitting.
  const t = splitIntoTranches(53, 20)
  assert.deepEqual(t, [20, 20, 13])
  assert.equal(t.reduce((a, b) => a + b, 0), 53)
})

test('an exact multiple splits evenly with no zero tranche', () => {
  const t = splitIntoTranches(60, 20)
  assert.deepEqual(t, [20, 20, 20])
  assert.ok(t.every((x) => x > 0))
})

test('a large BHEL order splits correctly', () => {
  // 100 lots at BHEL's 20-lot limit.
  const t = splitIntoTranches(100, 20)
  assert.equal(t.length, 5)
  assert.equal(t.reduce((a, b) => a + b, 0), 100)
})

test('an unknown limit sends one order rather than inventing a split', () => {
  assert.deepEqual(splitIntoTranches(999, null), [999])
})

test('nonsense inputs throw instead of producing a silent bad split', () => {
  assert.throws(() => splitIntoTranches(0, 20), /positive integer/)
  assert.throws(() => splitIntoTranches(-5, 20), /positive integer/)
  assert.throws(() => splitIntoTranches(1.5, 20), /positive integer/)
  assert.throws(() => splitIntoTranches(10, 0), /positive integer/)
})

// ------------------------------------------------------ BSE contract master

/**
 * The real header of BSE's `BSE_EQD_CONTRACT_abr_DDMMYYYY.csv` cut to its
 * first 41 columns (the last of which is `MaxTradQty`), plus six real rows
 * from the 2026-09-21 file. Columns are resolved by header NAME, so the 109
 * columns the real file carries after this one make no difference.
 */
const BSE_HEADER = 'FinInstrmId,UndrlygFinInstrmId,FinInstrmNm,TckrSymb,XpryDt,StrkPric,OptnTp,PrtdToTrad,MinLot,NewBrdLotQty,BidIntrvl,StartDt,EndDt,MtrtyDt,PdctStartDt,SrsId,AsstCd,UndrlygInstrmAsstClss,StockNm,SttlmMtd,BasePric,DelFlg,ExrcStartDt,ExrcEndDt,IssdCptl,MinPric,MaxPric,MktTpAndId,OffclCorpActnEvtId,AdmssnTp,IssePric,TradgStsNrmlMkt,ElgbltyNrmlMkt,TradgStsOddLotMkt,ElgbltyOddLotMkt,TradgStsSpotMkt,ElgbltySpotMkt,TradgStsAuctnMkt,ElgbltyAuctnMkt,MrgnPctg,MaxTradQty'
const BSE_ROWS = [
  '844615,1,IF,SENSEX,24-SEP-2026,0,,0,20,20,5,29-JUN-2026,24-SEP-2026,,,,BSX,EDX,SENSEX26SEPFUT,C,7490680,A,24-SEP-2026,24-SEP-2026,,,,,,,,1,,,,,,,,,500',
  '1132375,1,IO,SENSEX,01-OCT-2026,6700000,CE,1,20,20,5,16-SEP-2026,01-OCT-2026,,,,BSX,EDX,SENSEX26O0167000CE,C,795985,A,01-OCT-2026,01-OCT-2026,,,,,,,,0,,,,,,,,,1000',
  '845529,12,IF,BANKEX,24-SEP-2026,0,,0,30,30,5,29-JUN-2026,24-SEP-2026,,,,BKX,EDX,BANKEX26SEPFUT,C,6394230,A,24-SEP-2026,24-SEP-2026,,,,,,,,1,,,,,,,,,600',
  '1132083,12,IO,BANKEX,26-NOV-2026,5620000,CE,1,30,30,5,16-SEP-2026,26-NOV-2026,,,,BKX,EDX,BANKEX26NOV56200CE,C,821125,A,26-NOV-2026,26-NOV-2026,,,,,,,,0,,,,,,,,,900',
  '1134585,75,IO,FOCIT,26-NOV-2026,2790000,CE,1,45,45,5,21-SEP-2026,26-NOV-2026,,,,BIT,EDX,FOCIT26NOV27900CE,C,733280,A,26-NOV-2026,26-NOV-2026,,,,,,,,0,,,,,,,,,1350',
  '1134530,500325,SO,RELIANCE,26-NOV-2026,116000,CE,0,500,500,5,21-SEP-2026,26-NOV-2026,,,,RELI,EDX,RELIANCE26NOV1160CE,D,10940,A,26-NOV-2026,26-NOV-2026,,,,,,,,0,,,,,,,,,10000',
]
const BSE_FIXTURE = [BSE_HEADER, ...BSE_ROWS].join('\n')

const BSE_EXPECTED = [
  { symbol: 'BANKEX', freezeQty: 600, lotSize: 30 },
  { symbol: 'FOCIT', freezeQty: 1350, lotSize: 45 },
  { symbol: 'SENSEX', freezeQty: 500, lotSize: 20 },
]

test("parses BSE's abridged contract master: index symbols only, MIN of futures and options per symbol", () => {
  // SENSEX carries IF 500 and IO 1000 in the same file. `FreezeLimits` is keyed
  // by symbol alone and the gateway resolves both futures and options to
  // 'SENSEX', so the one number stored has to be safe for both: the MIN.
  // Over-splitting an option order is harmless; under-splitting a futures
  // order is an exchange rejection.
  const rows = parseBseContractCsv(BSE_FIXTURE)
  assert.deepEqual(rows, BSE_EXPECTED)
  assert.equal(rows.find((r) => r.symbol === 'RELIANCE'), undefined, 'stock rows are not index rows')
})

test('columns are found by HEADER NAME, not position', () => {
  // Move MaxTradQty to the front and swap FinInstrmNm/TckrSymb. If the parser
  // counted commas it would read the wrong field on every row.
  const move = (line: string): string => {
    const f = line.split(',')
    const qty = f.pop() as string
    ;[f[2], f[3]] = [f[3] as string, f[2] as string]
    return [qty, ...f].join(',')
  }
  const shuffled = [BSE_HEADER, ...BSE_ROWS].map(move).join('\n')
  assert.deepEqual(parseBseContractCsv(shuffled), BSE_EXPECTED)
})

test('AsstCd/UndrlygInstrmAsstClss are NOT the discriminator (EDX is on every row, stocks included)', () => {
  // The real file marks RELIANCE `EDX` exactly as it marks SENSEX; only
  // `FinInstrmNm` (IO/IF vs SO/SF) tells an index from a stock.
  const stockWithEdx = '1,500325,SO,RELIANCE,26-NOV-2026,116000,CE,0,500,500,5,,,,,,RELI,EDX,X,D,0,A,,,,,,,,,,0,,,,,,,,,10000'
  const indexWithNewAsstCd = '2,99,IO,NEWIDX,26-NOV-2026,100,CE,1,10,10,5,,,,,,ZZZ,ZZZ,X,C,0,A,,,,,,,,,,0,,,,,,,,,700'
  const rows = parseBseContractCsv([BSE_HEADER, stockWithEdx, indexWithNewAsstCd].join('\n'))
  assert.deepEqual(rows, [{ symbol: 'NEWIDX', freezeQty: 700, lotSize: 10 }])
})

test('a file missing a required header column throws, naming it', () => {
  const header = BSE_HEADER.split(',').slice(0, -1).join(',')
  assert.throws(() => parseBseContractCsv([header, ...BSE_ROWS].join('\n')), /MaxTradQty/)
})

test('garbage or an empty body throws on the header rather than yielding a silent empty table', () => {
  // The sync's fail-soft branch keys on the throw: a file that is not the
  // contract master must NOT look like "BSE lists no index symbols today".
  assert.throws(() => parseBseContractCsv(''), /header lacks/)
  assert.throws(() => parseBseContractCsv('not,a,header\n1,2,3'), /header lacks/)
  // A well-formed header with no data rows is legitimately empty.
  assert.deepEqual(parseBseContractCsv(BSE_HEADER), [])
})

test("a SENSEX row from the master keys the gateway lookup: maxLotsPerOrder('SENSEX', 20) = 25", () => {
  const f = new FreezeLimits(parseBseContractCsv(BSE_FIXTURE))
  assert.equal(f.maxLotsPerOrder('SENSEX', 20), 25)
  assert.equal(f.maxLotsPerOrder('BANKEX', 30), 20)
  assert.equal(f.maxLotsPerOrder('FOCIT', 45), 30)
  // The 74-lot SENSEX unit of 2026-09-17 (spec E4) would have gone as three.
  assert.deepEqual(splitIntoTranches(74, 25), [25, 25, 24])
})

test('CRLF line endings parse the same', () => {
  assert.deepEqual(parseBseContractCsv([BSE_HEADER, ...BSE_ROWS].join('\r\n')), BSE_EXPECTED)
})
