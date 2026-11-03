/**
 * Login, the auth gate, and the re-authentication prompt.
 *
 * THE GATE WRAPS THE ROUTER, not each page. A per-page check is a rule every
 * future page has to remember; wrapping the router means a page added later
 * cannot forget to be protected, because it never gets rendered without a
 * session in the first place.
 *
 * THE CLIENT HOLDS NO TOKEN AT ALL. The session is an httpOnly cookie the
 * browser attaches by itself, so nothing on this page can read it — and a
 * reload does NOT sign you out, because the cookie outlives the tab's memory.
 * `api.me()` on mount is what re-establishes the session after one.
 *
 * NOTHING HERE TELLS THE USER WHICH HALF WAS WRONG. The server answers "invalid
 * credentials" for both an unknown user and a bad password, and this page shows
 * that sentence verbatim rather than helpfully narrowing it down.
 */

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { VStack, HStack, Layout, LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout'
import { Card } from '@astryxdesign/core/Card'
import { Text, Heading } from '@astryxdesign/core/Text'
import { Button } from '@astryxdesign/core/Button'
import { Banner } from '@astryxdesign/core/Banner'
import { Spinner } from '@astryxdesign/core/Spinner'
import { TextInput } from '@astryxdesign/core/TextInput'
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog'
import { api, ApiError, explain, setUnauthorizedHandler, type Session } from './api.ts'
import { useAsync } from './shell.tsx'
import { BRAND } from './venue.ts'

type AuthStatus = 'checking' | 'in' | 'out'

interface AuthValue {
  status: AuthStatus
  session: Session | null
  signIn: (username: string, password: string) => Promise<void>
  signOut: () => void
}

const AuthContext = createContext<AuthValue | null>(null)

export function useAuth(): AuthValue {
  const v = useContext(AuthContext)
  if (v === null) throw new Error('useAuth outside AuthProvider')
  return v
}

export function AuthProvider(props: { children: React.ReactNode }): React.ReactElement {
  const [status, setStatus] = useState<AuthStatus>('checking')
  const [session, setSession] = useState<Session | null>(null)

  const signOut = useCallback(() => {
    /**
     * REVOKE SERVER-SIDE FIRST, then forget locally.
     *
     * Dropping the token from this tab only makes the operator *feel* signed
     * out — the session stays valid in `desk-sessions` for its full TTL, so
     * anyone who captured the token still holds trading rights on a desk whose
     * owner believes they have left.
     *
     * Fired without awaiting, and the local state is cleared regardless: a
     * network failure must never leave someone stuck signed in. That trades a
     * rare orphaned session (which still expires on its own) for a sign-out
     * that always works, which is the right way round.
     */
    void api.logout().catch(() => {})
    setSession(null)
    setStatus('out')
  }, [])

  // A 401 from ANY call — a poll, a patch, anything — drops back to login. The
  // alternative is a dashboard that keeps rendering the last numbers it saw
  // while every request behind it fails, which reads as "the desk is quiet".
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setSession(null)
      setStatus('out')
    })
    return () => setUnauthorizedHandler(null)
  }, [])

  /**
   * The probe on mount. It is what makes a reload keep you signed in: the
   * cookie is still there, so `me()` answers with the session. With no cookie
   * it 401s and lands on login, which is the fail-closed behaviour we want.
   *
   * A `machine` PRINCIPAL IS NOT A SIGNED-IN OPERATOR, and this is where that is
   * decided. The build-time `VITE_DESK_TOKEN` bearer that used to produce one
   * from a browser is gone, so this should now be unreachable from the
   * dashboard — it stays as a backstop because the gate still accepts machine
   * bearers for the Python desk and our pm2 processes, and a browser that
   * somehow arrived as one would come up looking signed in while every live
   * switch failed with "this session cannot confirm it", three layers from the
   * cause. The rule is on `kind`, so no stray token can reintroduce it.
   */
  useAsync(
    () => api.me(),
    (s) => {
      if (s.kind === 'machine') {
        setSession(null)
        setStatus('out')
        return
      }
      setSession(s)
      setStatus('in')
    },
    () => {
      setSession(null)
      setStatus('out')
    },
    [],
  )

  const signIn = useCallback(async (username: string, password: string): Promise<void> => {
    const r = await api.login(username, password)
    // Nothing to store: the httpOnly cookie is already set by the response, and
    // this client could not read it even if it wanted to.
    setSession({ username: r.username, kind: 'user', expiresAt: r.expiresAt })
    setStatus('in')
  }, [])

  return (
    <AuthContext.Provider value={{ status, session, signIn, signOut }}>
      {props.children}
    </AuthContext.Provider>
  )
}

// -------------------------------------------------------------------- gate

/**
 * Renders `children` only with a session; otherwise the login page.
 *
 * The hash is rewritten to `#/login` and the previous one is restored after a
 * successful login, so the address bar never claims you are on a page you are
 * not being shown, and you land back where you were rather than on the default
 * page.
 */
export function AuthGate(props: { children: React.ReactNode }): React.ReactElement {
  const { status } = useAuth()
  const returnTo = useRef<string | null>(null)

  useEffect(() => {
    if (status === 'out') {
      const here = window.location.hash
      if (here !== '' && here !== '#/login') returnTo.current = here
      window.location.hash = '#/login'
    } else if (status === 'in' && window.location.hash === '#/login') {
      window.location.hash = returnTo.current ?? '#/positions'
      returnTo.current = null
    }
  }, [status])

  if (status === 'checking') {
    return (
      <VStack gap={4} padding={10} align="center">
        <Spinner size="lg" label="Checking your session" />
      </VStack>
    )
  }
  if (status === 'out') return <LoginPage />
  return <>{props.children}</>
}

// -------------------------------------------------------------- login page

export function LoginPage(): React.ReactElement {
  const { signIn } = useAuth()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await signIn(username, password)
    } catch (err) {
      // Verbatim from the server. The client does not add "user not found" or
      // "wrong password" — that difference is exactly what an attacker enumerating
      // usernames is looking for.
      setError(err instanceof Error ? err.message : 'invalid credentials')
      setPassword('')
    } finally {
      setBusy(false)
    }
  }

  return (
    /*
      `width="100%" maxWidth={400}` and not `width={400}`.
      A 400px card inside 40px of padding needs 480px, so on a 390px phone the
      sign-in form — the one screen nobody can get past — was itself what made
      the document scroll sideways. It is unchanged on anything wider.
    */
    <VStack gap={4} padding={10} align="center" className="desk-page">
      <Card width="100%" maxWidth={400}>
        <VStack gap={4} padding={5}>
          <VStack gap={1}>
            <Heading level={2}>{BRAND}</Heading>
            <Text color="secondary" size="sm">
              Sign in to reach the desk. The session is a cookie this page cannot
              read, so a reload keeps you signed in — use Sign out to end it.
            </Text>
          </VStack>

          {error !== null ? <Banner status="error" title={error} /> : null}

          <TextInput
            label="Username"
            value={username}
            onChange={setUsername}
            hasAutoFocus
            onEnter={() => void submit()}
          />
          <TextInput
            label="Password"
            type="password"
            value={password}
            onChange={setPassword}
            onEnter={() => void submit()}
          />
          <Button
            variant="primary"
            label="Sign in"
            isLoading={busy}
            isDisabled={busy || username === '' || password === ''}
            onClick={() => void submit()}
          />
        </VStack>
      </Card>
    </VStack>
  )
}

// ------------------------------------------------------------ reauth prompt

interface ReauthAsk {
  statement: string
  note: string | null
  /** No password can satisfy this session — explain, do not prompt. */
  blocked: boolean
}

export interface Reauth {
  /**
   * Ask for the password. Resolves to the password, or null if cancelled.
   *
   * `statement` must say plainly what becomes possible — "orders from this tag
   * will route to the live account" — not "confirm this action". The whole
   * point of the second prompt is that the operator reads what they are about
   * to allow, and a generic confirmation is something you click through.
   */
  ask: (statement: string, note?: string) => Promise<string | null>
  dialog: React.ReactElement
}

export function useReauth(): Reauth {
  const { session } = useAuth()
  const [open, setOpen] = useState<ReauthAsk | null>(null)
  const [password, setPassword] = useState('')
  const resolver = useRef<((v: string | null) => void) | null>(null)

  const finish = useCallback((value: string | null) => {
    resolver.current?.(value)
    resolver.current = null
    setPassword('')
    setOpen(null)
  }, [])

  /**
   * True when this session is a MACHINE bearer token, which can never satisfy
   * re-authentication by design.
   *
   * A BACKSTOP, NOT A NORMAL PATH: `AuthProvider` now refuses to sign in a
   * machine principal at all, so the dashboard should never reach this state.
   * It stays because it is correct and cheap, and because the alternative when
   * it IS reached is the caller looping — it prompts, the server refuses every
   * machine principal, the caller sees `reauthRequired` and prompts again,
   * forever, with nothing on screen explaining why a correct password keeps
   * failing. Nothing should be built that depends on being in this state.
   */
  const machineOnly = session?.kind === 'machine'

  const ask = useCallback((statement: string, note?: string): Promise<string | null> => {
    // A prompt already waiting is answered with a cancel first, so a resolver
    // can never be dropped and leave a caller awaiting forever.
    resolver.current?.(null)
    setPassword('')
    if (machineOnly) {
      // Explain and stop, rather than prompting for a password that CANNOT
      // work. The caller's retry loop treats null as a cancel, so this exits it
      // instead of re-prompting on every 403.
      setOpen({ statement, note: null, blocked: true })
      return new Promise<string | null>((resolve) => { resolver.current = resolve })
    }
    setOpen({ statement, note: note ?? null, blocked: false })
    return new Promise<string | null>((resolve) => { resolver.current = resolve })
  }, [machineOnly])

  const dialog = (
    <Dialog
      isOpen={open !== null}
      onOpenChange={() => finish(null)}
      purpose="form"
      width={460}
    >
      <Layout
        header={
          <DialogHeader
            title={open?.blocked === true ? 'This session cannot confirm it' : 'Confirm with your password'}
            onOpenChange={() => finish(null)}
          />
        }
        content={
          <LayoutContent>
            <VStack gap={4}>
              <Text>{open?.statement ?? ''}</Text>
              {open?.blocked === true ? (
                <Banner
                  status="warning"
                  title="You are signed in with a machine token"
                  description={
                    'An automated client must not be able to turn live trading on by itself, so ' +
                    'the server refuses re-authentication for it — no password will work here. ' +
                    'Sign in as an operator to make this change.'
                  }
                />
              ) : null}
              {open?.blocked !== true && open?.note !== null && open?.note !== undefined
                ? <Banner status="error" title={open.note} />
                : null}
              {open?.blocked !== true ? (
                <>
                  <Text color="secondary" size="sm">
                    Password-only sign-in means one leaked password is full control, so
                    the two actions that can move real money ask for it again.
                  </Text>
                  <TextInput
                    label="Password"
                    type="password"
                    value={password}
                    onChange={setPassword}
                    hasAutoFocus
                    onEnter={() => { if (password !== '') finish(password) }}
                  />
                </>
              ) : null}
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <HStack gap={2} justify="end">
              <Button
                variant="secondary"
                label={open?.blocked === true ? 'Close' : 'Cancel'}
                onClick={() => finish(null)}
              />
              {open?.blocked === true ? null : (
                <Button
                  variant="destructive"
                  label="Confirm"
                  isDisabled={password === ''}
                  onClick={() => finish(password)}
                />
              )}
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  )

  return { ask, dialog }
}

/**
 * Runs a mutation, raising the re-auth prompt when it can move real money.
 *
 * `promptFirst` mirrors the SERVER's condition rather than being generous with
 * it. Prompting more widely than the server checks meant a lot-size tweak on an
 * already-live strategy raised a "this will route to the LIVE broker" modal and
 * then sent a password the server never verified — a scary dialog that did
 * nothing, which teaches an operator to click through the one that matters.
 * Prompting LESS is handled by the retry, where the server is the authority.
 *
 * IT LIVES HERE, beside `useReauth`, because four screens now share it: the
 * Strategies page's live switch, the Books page's dials, and the two book
 * wizards' seed step. It was private to `strategies.tsx` while the live switch
 * was the only gated control; copying it per screen is how one copy quietly
 * stops retrying, or stops sending the password at all.
 */
export async function withReauth<T>(opts: {
  statement: string
  promptFirst: boolean
  run: (password?: string) => Promise<T>
  reauth: Reauth
  onDone: (value: T) => void
  onError: (message: string) => void
}): Promise<void> {
  let password: string | undefined
  if (opts.promptFirst) {
    const first = await opts.reauth.ask(opts.statement)
    if (first === null) return
    password = first
  }

  for (;;) {
    try {
      opts.onDone(await opts.run(password))
      return
    } catch (err) {
      // The server decides. If it says the password is needed — or that the one
      // we sent was wrong — the prompt re-opens carrying its message. A machine
      // session cannot satisfy it at all, and `ask` says so and returns null
      // rather than looping on a prompt no password can answer.
      if (err instanceof ApiError && err.reauthRequired) {
        const again = await opts.reauth.ask(opts.statement, err.message)
        if (again === null) return
        password = again
        continue
      }
      opts.onError(explain(err))
      return
    }
  }
}
