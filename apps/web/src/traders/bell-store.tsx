/**
 * What the bell collects: each mounted report, by where it came from. A leaf (React only), so caveats.tsx can report
 * to it and bell.tsx can draw it without the two importing each other.
 */

import { createContext, useContext, useEffect, useId, useMemo, useState, type ReactNode } from 'react'

export interface BellReport {
  /** Dismissible warning lines: the server's warning lists, a page's standing caveats. */
  readonly items?: readonly string[]
  /** Live-state lines that are not dismissible: a failed refresh, a page that could not load. */
  readonly alerts?: readonly string[]
  /** What this view shows is a closed market's (the last session's prices). */
  readonly closed?: boolean
}

export interface BellEntry {
  readonly source: string; readonly items: readonly string[]; readonly alerts: readonly string[]; readonly closed: boolean
}

interface BellApi { report(id: string, entry: BellEntry | null): void }

const BellContext = createContext<BellApi | null>(null)
const EntriesContext = createContext<ReadonlyMap<string, BellEntry>>(new Map())
const SourceContext = createContext<string>('')

export function BellProvider(props: { children: ReactNode }): React.ReactElement {
  const [entries, setEntries] = useState<ReadonlyMap<string, BellEntry>>(() => new Map())
  const api = useMemo<BellApi>(() => ({
    report: (id, entry) => setEntries((prev) => {
      const had = prev.get(id)
      if (entry === null ? had === undefined : had !== undefined && JSON.stringify(had) === JSON.stringify(entry)) return prev
      const next = new Map(prev)
      if (entry === null) next.delete(id)
      else next.set(id, entry)
      return next
    }),
  }), [])
  return (
    <BellContext.Provider value={api}>
      <EntriesContext.Provider value={entries}>{props.children}</EntriesContext.Provider>
    </BellContext.Provider>
  )
}

export function useBellEntries(): ReadonlyMap<string, BellEntry> { return useContext(EntriesContext) }

/** Names the reports below it, inside the enclosing name: "Books", then "Books · TCS", then "Books · TCS · Scenario". */
export function BellSource(props: { label: string; children: ReactNode }): React.ReactElement {
  const parent = useContext(SourceContext)
  const label = parent === '' ? props.label : `${parent} · ${props.label}`
  return <SourceContext.Provider value={label}>{props.children}</SourceContext.Provider>
}

/** Reports to the nearest bell while mounted; `null` reports nothing. True when a bell collects it (draw nothing inline). */
export function useBellReport(report: BellReport | null): boolean {
  const bell = useContext(BellContext)
  const source = useContext(SourceContext)
  const id = useId()
  const key = report === null ? null : JSON.stringify([source, report.items ?? [], report.alerts ?? [], report.closed === true])
  useEffect(() => {
    if (bell === null) return
    if (key === null) { bell.report(id, null); return }
    const [s, items, alerts, closed] = JSON.parse(key) as [string, string[], string[], boolean]
    bell.report(id, { source: s, items, alerts, closed })
  }, [bell, id, key])
  useEffect(() => (bell === null ? undefined : () => bell.report(id, null)), [bell, id])
  return bell !== null
}
