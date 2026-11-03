/** The traders app: auth gate, then the shell (sidebar, stock tabs, bell) around the page chosen by the hash route. */

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { Text } from '@astryxdesign/core/Text'
import { Selector } from '@astryxdesign/core/Selector'
import type { Role } from '../../../traders/src/types.ts'
import type { ThemeMode } from '../theme-mode.ts'
import { onTradersChanged, setAsTrader, setUnauthorized, tapi } from './api.ts'
import { BellProvider, BellSource } from './bell-store.tsx'
import { SessionContext, usePoll, type Session } from './hooks.ts'
import { LoginPage } from './login.tsx'
import { PAGES } from './pages.tsx'
import { useTradersRoute } from './route.ts'
import { TradersShell, useSidebar } from './shell.tsx'

type Auth = { state: 'checking' } | { state: 'out' } | { state: 'in'; username: string; role: Role }

export function TradersApp(props: { themeMode: ThemeMode; onThemeMode: (m: ThemeMode) => void }): React.ReactElement {
  const [auth, setAuth] = useState<Auth>({ state: 'checking' })
  const [picked, setPicked] = useState<string | null>(null)

  useEffect(() => {
    setUnauthorized(() => { setAsTrader(null); setPicked(null); setAuth({ state: 'out' }) })
    let alive = true
    tapi.me().then(
      (u) => { if (alive) setAuth({ state: 'in', username: u.username, role: u.role }) },
      () => { if (alive) setAuth({ state: 'out' }) },
    )
    return () => { alive = false }
  }, [])

  const pick = useCallback((name: string | null) => { setAsTrader(name); setPicked(name) }, [])
  const logout = useCallback(() => {
    void tapi.logout().catch(() => undefined).finally(() => { pick(null); setAuth({ state: 'out' }) })
  }, [pick])

  const session = useMemo<Session | null>(
    () => (auth.state === 'in' ? { username: auth.username, role: auth.role, asTrader: picked } : null),
    [auth, picked],
  )

  if (auth.state === 'checking') return <Text color="secondary">Checking your session…</Text>
  if (auth.state === 'out' || session === null) {
    return <LoginPage onSignedIn={(u) => setAuth({ state: 'in', username: u.username, role: u.role })} />
  }
  return (
    <SessionContext.Provider value={session}>
      <BellProvider>
        <SignedIn session={session} onPick={pick} onLogout={logout} themeMode={props.themeMode} onThemeMode={props.onThemeMode} />
      </BellProvider>
    </SessionContext.Provider>
  )
}

function SignedIn(props: {
  session: Session; onPick: (name: string | null) => void; onLogout: () => void
  themeMode: ThemeMode; onThemeMode: (m: ThemeMode) => void
}): React.ReactElement {
  const { session } = props
  const [route, go] = useTradersRoute()
  const sidebar = useSidebar()
  const [bellOpen, setBellOpen] = useState(false)

  const visible = PAGES.filter((p) => p.adminOnly !== true || session.role === 'admin')
  const page = visible.find((p) => p.id === route.page) ?? visible[0]

  return (
    <TradersShell
      session={session}
      pages={visible}
      page={page}
      route={route}
      go={go}
      picker={session.role === 'admin' ? <TraderPicker value={session.asTrader} onChange={props.onPick} /> : null}
      themeMode={props.themeMode}
      onThemeMode={props.onThemeMode}
      onLogout={props.onLogout}
      sidebar={sidebar}
      bellOpen={bellOpen}
      onBellOpen={setBellOpen}
    >
      {/* Keyed on the pick: choosing another trader remounts the page so nothing of the last trader's stays painted. */}
      <Fragment key={session.asTrader ?? ''}>
        {page === undefined ? null : <BellSource label={page.label}>{page.render()}</BellSource>}
      </Fragment>
    </TradersShell>
  )
}

const PICKER_POLL_MS = 60_000

function TraderPicker(props: { value: string | null; onChange: (name: string | null) => void }): React.ReactElement {
  const traders = usePoll(() => tapi.adminTraders(), PICKER_POLL_MS, [])
  // A trader added in Admin, or by another admin elsewhere (seen on coming back to the tab), is listed at once.
  const { reload } = traders
  useEffect(() => {
    const off = onTradersChanged(reload)
    window.addEventListener('focus', reload)
    return () => { off(); window.removeEventListener('focus', reload) }
  }, [reload])
  const names = traders.data?.map((r) => r.username) ?? (traders.error === null ? null : [])
  return (
    <Selector
      label="Trader"
      isLoading={names === null}
      options={names ?? []}
      value={props.value ?? ''}
      placeholder="Pick a trader…"
      onChange={(v) => props.onChange(v === '' ? null : v)}
    />
  )
}
