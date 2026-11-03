/** The R2 client: the query the server parses, the five new calls, the shared viewer state. */
import { expect, test, afterEach, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { analysisQuery, tapi, setAsTrader } from '../src/traders/api.ts'
import { useViewer } from '../src/traders/viewer.ts'
import { installFetch } from './http.tsx'
import type { ChargeRates } from '../../traders/src/analytics/wire.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals(); setAsTrader(null) })

const base = { expiry: null, exclude: [], illiquid: [], ivOverrides: {}, callVol: 0, putVol: 0, future: null } as const

test('analysisQuery builds exactly what the server parses', () => expect(analysisQuery({ ...base, exclude: ['A|option|TCS|2026-10-27|3000|CE'], ivOverrides: { 'manual:x1': 0.245 }, callVol: 2 }))
  .toBe('exclude=A%7Coption%7CTCS%7C2026-10-27%7C3000%7CCE&iv=manual%3Ax1%400.245&callVol=2'))

test('analysisQuery carries the Gap Up/Down panel', () => expect(analysisQuery({ ...base,
  gap: [{ movePct: 5, volPts: 0 }, { movePct: -5, volPts: 2 }], gapUseLtp: false, volBasis: 'synthetic' })).toBe('gap=5%2C0&gap=-5%2C2&gapLtp=0&basis=synthetic'))

test('analysisQuery omits the defaults and orders every parameter', () => {
  expect(analysisQuery(base)).toBe('')
  expect(analysisQuery({ ...base, gap: [{ movePct: 10, volPts: -10 }, { movePct: -10, volPts: -10 }], gapUseLtp: true, gapUseVol: true, volBasis: 'future' })).toBe('')
  expect(analysisQuery({ expiry: '2026-10-27', exclude: ['a'], illiquid: ['b', 'c'], ivOverrides: { k: 0.2 }, callVol: 1, putVol: -1, future: 101.5,
    gapUseVol: false, volBasis: 'cash' }))
    .toBe('expiry=2026-10-27&exclude=a&illiquid=b&illiquid=c&iv=k%400.2&callVol=1&putVol=-1&future=101.5&gapVol=0&basis=cash')
})

test('tapi.analysis hits the contract path, M&M encoded', async () => {
  const sent = installFetch(() => ({ body: { ok: 1 } }))
  await tapi.analysis('M&M', { ...base, callVol: 2 })
  expect(sent[0]?.method).toBe('GET')
  expect(sent[0]?.path).toBe('/v1/traders/books/M%26M/analysis')
  expect(new URL(sent[0]!.url).search).toBe('?callVol=2')
})

test('tapi.analysis appends the admin picker after the query', async () => {
  const sent = installFetch(() => ({ body: {} }))
  setAsTrader('ravi')
  await tapi.analysis('TCS', { ...base, callVol: 2 })
  expect(new URL(sent[0]!.url).search).toBe('?callVol=2&as=ravi')
})

test('scenario, margin and the charge settings use their contract paths', async () => {
  const sent = installFetch(() => ({ body: { charges: {} } }))
  await tapi.scenario('M&M', { spot: 100, targets: [1] })
  await tapi.margin('M&M', ['a|b', 'c'])
  await tapi.chargeSettings()
  await tapi.putChargeSettings({ gstPct: 18 } as ChargeRates)
  expect(sent.map((r) => `${r.method} ${r.path}`)).toEqual([
    'POST /v1/traders/books/M%26M/scenario', 'GET /v1/traders/books/M%26M/margin',
    'GET /v1/traders/admin/settings', 'PUT /v1/traders/admin/settings',
  ])
  expect(sent[0]?.body).toEqual({ spot: 100, targets: [1] })
  expect(new URL(sent[1]!.url).search).toBe('?exclude=a%7Cb&exclude=c')
  expect(sent[3]?.body).toEqual({ charges: { gstPct: 18 } })
})

test('viewer state is per stock and survives switching sub-tabs', () => {
  const tcs = renderHook(() => useViewer('TCS'))
  act(() => tcs.result.current.toggleExclude('k'))
  act(() => tcs.result.current.toggleIlliquid('i'))
  act(() => tcs.result.current.setIv('x', 0.3))
  const infy = renderHook(() => useViewer('INFY'))
  expect(infy.result.current.state).toEqual({ exclude: [], illiquid: [], ivOverrides: {} })
  tcs.unmount()
  const again = renderHook(() => useViewer('TCS'))
  expect(again.result.current.state).toEqual({ exclude: ['k'], illiquid: ['i'], ivOverrides: { x: 0.3 } })
  act(() => again.result.current.toggleExclude('k'))
  act(() => again.result.current.setIv('x', null))
  expect(again.result.current.state.exclude).toEqual([])
  expect(again.result.current.state.ivOverrides).toEqual({})
})

test('units are page-wide and default to the whole position', () => {
  const a = renderHook(() => useViewer('AAA'))
  const b = renderHook(() => useViewer('BBB'))
  expect(a.result.current.units).toBe('position')
  act(() => a.result.current.setUnits('lot'))
  expect(b.result.current.units).toBe('lot')
  act(() => a.result.current.setUnits('position'))
})

test('analysisQuery never sends a non-finite or non-positive number', () => {
  for (const bad of [NaN, Infinity, -Infinity]) {
    expect(analysisQuery({ ...base, callVol: bad, putVol: bad, future: bad })).toBe('')
    expect(analysisQuery({ ...base, ivOverrides: { k: bad } })).toBe('')
    expect(analysisQuery({ ...base, gap: [{ movePct: bad, volPts: 0 }, { movePct: -5, volPts: 2 }] })).toBe('')
    expect(analysisQuery({ ...base, gap: [{ movePct: 5, volPts: 0 }, { movePct: -5, volPts: bad }] })).toBe('')
  }
  expect(analysisQuery({ ...base, future: 0 })).toBe('')
  expect(analysisQuery({ ...base, future: -3 })).toBe('')
  expect(analysisQuery({ ...base, ivOverrides: { a: 0, b: -0.1, c: 0.2 } })).toBe('iv=c%400.2')
})

test('a key containing & round-trips through analysisQuery', () => {
  const key = 'A&B|option=x@y'
  const q = new URLSearchParams(analysisQuery({ ...base, exclude: [key], ivOverrides: { [key]: 0.3 } }))
  expect(q.getAll('exclude')).toEqual([key])
  expect(q.getAll('iv')).toEqual([`${key}@0.3`])
})

test('the charge settings calls carry no as= for an admin viewing a trader', async () => {
  const sent = installFetch(() => ({ body: { charges: {} } }))
  setAsTrader('ravi')
  await tapi.chargeSettings()
  await tapi.putChargeSettings({} as ChargeRates)
  for (const r of sent) expect(new URL(r.url).search).toBe('')
  expect(sent.map((r) => r.path)).toEqual(['/v1/traders/admin/settings', '/v1/traders/admin/settings'])
})
