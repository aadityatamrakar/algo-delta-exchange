/** The Admin page's data status panel: a trader × day grid of ✓ n trades / — / ⚠, the flags, and the watcher line. */
import { expect, test, afterEach, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import type { DataStatusDay, DataStatusTrader, DataStatusView } from '../../../traders/src/analytics/daily-wire.ts'
import { ADMIN_SECTIONS } from '../../src/traders/admin.tsx'
import { AdminDataStatus, DATA_STATUS_DAYS, cellOf, watcherLine } from '../../src/traders/admin-data-status.tsx'
import { installFetch } from '../http.tsx'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const HB = new Date('2026-10-22T10:27:00+05:30').getTime()
const d = (day: string, files: number, trades: number, over: Partial<DataStatusDay> = {}): DataStatusDay =>
  ({ day, files, trades, orders: trades, rejected: 0, noFilesWhileOthersTraded: false, ...over })

const DAYS = ['2026-10-22', '2026-10-21', '2026-10-14']
const trader = (name: string, days: DataStatusDay[], over: Partial<DataStatusTrader['watcher']> = {}): DataStatusTrader => ({
  trader: name, disabled: false, days,
  watcher: { lastHeartbeatAt: HB, lastUploadAt: HB - 1000, version: '1.3.0', offline: false, ...over },
})

const VIEW: DataStatusView = {
  asOf: HB, days: DAYS,
  traders: [
    trader('alpesh', [d('2026-10-22', 3, 143, { rejected: 2 }), d('2026-10-21', 3, 1), d('2026-10-14', 2, 71)]),
    trader('jignesh', [d('2026-10-22', 2, 79), d('2026-10-21', 2, 105), d('2026-10-14', 0, 0, { noFilesWhileOthersTraded: true })]),
    trader('test', [d('2026-10-22', 0, 0), d('2026-10-21', 0, 0), d('2026-10-14', 0, 0)], { offline: true, lastHeartbeatAt: HB - 86_400_000 }),
    trader('newbie', [d('2026-10-22', 0, 0), d('2026-10-21', 0, 0), d('2026-10-14', 0, 0)], { lastHeartbeatAt: null, lastUploadAt: null, version: null, offline: true }),
  ],
  flags: ['jignesh: no files on 14 Oct while others traded'],
  notes: ["Files are counted by the day the trader's PC wrote them (their modified time)."],
}

const mount = (view: unknown = VIEW) => {
  const sent = installFetch(({ path }) => (path === '/v1/traders/admin/data-status' ? { body: view } : { status: 404, body: { error: 'no' } }))
  render(<AdminDataStatus />)
  return sent
}

test('the Admin page carries the panel under the traders', () => {
  expect(ADMIN_SECTIONS.map((s) => [s.id, s.label])).toContainEqual(['data-status', 'Data status'])
})

test('a cell is ✓ n trades, — with no files and nobody trading, or ⚠ with no files while others traded', () => {
  expect(cellOf(d('2026-10-22', 3, 143))).toEqual({ mark: '✓', text: '143 trades' })
  expect(cellOf(d('2026-10-22', 1, 1))).toEqual({ mark: '✓', text: '1 trade' })
  expect(cellOf(d('2026-10-22', 2, 0))).toEqual({ mark: '✓', text: '0 trades' })
  expect(cellOf(d('2026-10-22', 0, 0))).toEqual({ mark: '—', text: '' })
  expect(cellOf(d('2026-10-22', 0, 0, { noFilesWhileOthersTraded: true }))).toEqual({ mark: '⚠', text: 'no files' })
})

test('the grid is a row per trader and a column per day, newest first', async () => {
  const sent = mount()
  const table = await screen.findByRole('table', { name: 'Data status' })
  expect(sent.map((r) => r.url.split('?')[1])).toEqual([`days=${DATA_STATUS_DAYS}`])
  expect(within(table).getAllByRole('columnheader').map((c) => c.textContent)).toEqual(['Trader', '22 Oct', '21 Oct', '14 Oct'])
  const rows = within(table).getAllByRole('row').slice(1)
  // a cell's tooltip (its counts) is in the DOM too, so each cell is read by its visible words
  const marks = (r: HTMLElement) => within(r).getAllByRole('cell').map((c) => (['✓ 143 trades', '✓ 1 trade', '✓ 71 trades', '✓ 79 trades', '✓ 105 trades', '⚠ no files', '—'] as const)
    .filter((t) => within(c).queryByText(t) !== null))
  expect(rows).toHaveLength(4)
  expect(marks(rows[0]!)).toEqual([[], ['✓ 143 trades'], ['✓ 1 trade'], ['✓ 71 trades']])
  expect(marks(rows[1]!)).toEqual([[], ['✓ 79 trades'], ['✓ 105 trades'], ['⚠ no files']])
  expect(marks(rows[2]!)).toEqual([[], ['—'], ['—'], ['—']])
  expect(marks(rows[3]!)).toEqual([[], ['—'], ['—'], ['—']])
  expect(within(within(rows[0]!).getAllByRole('cell')[1]!).getByText('2 rejected')).toBeTruthy()
  expect(within(table).getAllByText('2 rejected')).toHaveLength(1)   // only the one day with rejects says so
  expect(within(within(rows[0]!).getAllByRole('cell')[0]!).getByText('alpesh')).toBeTruthy()
  // the counts are in the cell's tooltip
  expect(within(rows[1]!).getByText('14 Oct: 0 files · 0 trade lines · 0 order rows · 0 rejected')).toBeTruthy()
})

test('a flagged day is also a sentence under the grid', async () => {
  mount()
  await screen.findByRole('table', { name: 'Data status' })
  expect(screen.getByText('⚠ jignesh: no files on 14 Oct while others traded')).toBeTruthy()
})

test('the watcher line: online or offline, its version and its last heartbeat; never connected says so', async () => {
  mount()
  await screen.findByRole('table', { name: 'Data status' })
  expect(screen.getByText('alpesh: online · v1.3.0 · last heartbeat 22 Oct 10:27')).toBeTruthy()
  expect(screen.getByText('test: offline · v1.3.0 · last heartbeat 21 Oct 10:27')).toBeTruthy()
  expect(screen.getByText('newbie: watcher never connected')).toBeTruthy()
  expect(watcherLine(trader('x', [], { version: null }))).toBe('x: online · version unknown · last heartbeat 22 Oct 10:27')
})

test('the server\'s notes sit behind the Notes toggle', async () => {
  mount()
  await screen.findByRole('table', { name: 'Data status' })
  expect(screen.getByRole('button', { name: /Notes \(1\)/ })).toBeTruthy()
})

test('a failed load says so; an answer that is not a data status is not drawn as a grid', async () => {
  installFetch(() => ({ status: 500, body: { error: 'boom' } }))
  render(<AdminDataStatus />)
  expect(await screen.findByText('Could not load the data status: boom')).toBeTruthy()
  cleanup()
  mount({})
  expect(await screen.findByText('The server did not answer a data status')).toBeTruthy()
  expect(screen.queryByRole('table', { name: 'Data status' })).toBeNull()
})

test('no traders is said', async () => {
  mount({ ...VIEW, traders: [], flags: [] })
  expect(await screen.findByText('No traders yet')).toBeTruthy()
})
