/**
 * The Admin page: the traders, their watcher and token state, and the actions
 * on them. Admin-only; the server refuses anyone else. Nothing here touches an
 * order — it manages who can sign in and what files reached the analysis.
 */

import { useRef, useState } from 'react'
import { VStack, HStack, Layout, LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout'
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog'
import { Heading, Text } from '@astryxdesign/core/Text'
import { Banner } from '@astryxdesign/core/Banner'
import { BellAlert } from './bell.tsx'
import { Button } from '@astryxdesign/core/Button'
import { TextInput } from '@astryxdesign/core/TextInput'
import { FileInput } from '@astryxdesign/core/FileInput'
import type { TableColumn } from '@astryxdesign/core/Table'
import type { AdminTraderRow } from '../../../traders/src/types.ts'
import { tapi } from './api.ts'
import { AdminCharges } from './admin-charges.tsx'
import { AdminDataStatus } from './admin-data-status.tsx'
import { usePoll } from './hooks.ts'
import { istDay, istHm, watcherState, watcherText } from './wire.ts'
import { TradersTable } from './table.tsx'

const ADMIN_POLL_MS = 30_000

/** Sections below the trader table. */
export const ADMIN_SECTIONS: readonly { id: string; label: string; render(): React.ReactElement }[] = [
  { id: 'charges', label: 'Charges', render: () => <AdminCharges /> },
  { id: 'data-status', label: 'Data status', render: () => <AdminDataStatus /> },
]

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function tokenText(t: AdminTraderRow['token']): string {
  return t === null
    ? 'none'
    : `issued ${istDay(t.createdAt)}, last used ${t.lastUsedAt === null ? 'never' : istHm(t.lastUsedAt)}`
}

type Row = AdminTraderRow & Record<string, unknown>

type Modal =
  | { kind: 'add' }
  | { kind: 'password'; name: string }
  | { kind: 'upload'; name: string }
  | { kind: 'token'; name: string; token: string }
  | { kind: 'confirm'; action: 'disable' | 'revoke' | 'issue'; name: string }

export function AdminPage(): React.ReactElement {
  const traders = usePoll(() => tapi.adminTraders(), ADMIN_POLL_MS, [])
  const [modal, setModal] = useState<Modal | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  // One action at a time: a second click while one is in flight is dropped, not sent.
  const act = async (fn: () => Promise<void>): Promise<void> => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    try { await fn(); traders.reload() } catch (err) { setError(message(err)) } finally { inFlight.current = false; setBusy(false) }
  }
  const issue = (name: string): Promise<void> =>
    act(async () => { const r = await tapi.issueToken(name); setModal({ kind: 'token', name, token: r.token }) })
  const confirmed = (c: { action: 'disable' | 'revoke' | 'issue'; name: string }): void => {
    setModal(null)
    if (c.action === 'issue') void issue(c.name)
    else if (c.action === 'revoke') void act(() => tapi.revokeToken(c.name))
    else void act(() => tapi.patchTrader(c.name, { disabled: true }))
  }
  const now = Date.now()

  const text = (s: string): React.ReactElement => <Text size="sm">{s}</Text>
  const columns: TableColumn<Row>[] = [
    { key: 'username', header: 'Trader', renderCell: (r) => <Text size="sm" weight="bold">{r.username}</Text> },
    { key: 'disabled', header: 'Disabled', renderCell: (r) => text(r.disabled ? 'disabled' : 'no') },
    { key: 'login', header: 'Last login', renderCell: (r) => text(r.lastLoginAt === null ? 'never' : `${istDay(r.lastLoginAt)} ${istHm(r.lastLoginAt)}`) },
    { key: 'watcher', header: 'Watcher', renderCell: (r) => (
      <VStack gap={0}>
        <Text size="sm" weight="bold">{watcherState(r.watcher, now)}</Text>
        {r.watcher === null ? null : text(watcherText(r.watcher))}
      </VStack>
    ) },
    { key: 'token', header: 'Token', renderCell: (r) => text(tokenText(r.token)) },
    {
      key: 'actions', header: '',
      renderCell: (r) => (
        <HStack gap={1} wrap="wrap">
          <Button size="sm" variant="secondary" label={r.disabled ? 'Enable' : 'Disable'} isDisabled={busy}
            onClick={() => r.disabled
              ? void act(() => tapi.patchTrader(r.username, { disabled: false }))
              : setModal({ kind: 'confirm', action: 'disable', name: r.username })} />
          <Button size="sm" variant="secondary" label="Reset password" isDisabled={busy} onClick={() => setModal({ kind: 'password', name: r.username })} />
          <Button size="sm" variant="secondary" label="Issue token" isDisabled={busy}
            onClick={() => r.token === null ? void issue(r.username) : setModal({ kind: 'confirm', action: 'issue', name: r.username })} />
          {r.token === null ? null : (
            <Button size="sm" variant="secondary" label="Revoke token" isDisabled={busy}
              onClick={() => setModal({ kind: 'confirm', action: 'revoke', name: r.username })} />
          )}
          <Button size="sm" variant="secondary" label="Upload file" isDisabled={busy} onClick={() => setModal({ kind: 'upload', name: r.username })} />
        </HStack>
      ),
    },
  ]

  const rows = traders.data
  return (
    <VStack gap={4}>
      <HStack gap={3} align="center" justify="between" wrap="wrap">
        <Heading level={3}>Traders</Heading>
        <Button variant="primary" label="Add trader" onClick={() => setModal({ kind: 'add' })} />
      </HStack>
      {error !== null ? <Banner status="error" title={error} /> : null}
      {traders.error === null ? null : rows === null
        ? <BellAlert status="error" inline text={`Could not load the traders: ${traders.error}`} />
        : <BellAlert text={`Could not load the traders: ${traders.error}`} />}
      {rows === null
        ? (traders.error === null ? <Text color="secondary">Loading traders…</Text> : null)
        : rows.length === 0
          ? <Text color="secondary">No traders yet</Text>
          : <TradersTable data={rows as Row[]} columns={columns} density="compact" hasHover />}
      {ADMIN_SECTIONS.map((s) => (
        <VStack key={s.id} gap={2}>
          <Heading level={3}>{s.label}</Heading>
          {s.render()}
        </VStack>
      ))}
      {modal?.kind === 'confirm' ? <ConfirmDialog {...modal} onCancel={() => setModal(null)} onConfirm={() => confirmed(modal)} /> : null}
      {modal?.kind === 'add' ? <AddTraderDialog onClose={() => setModal(null)} onDone={traders.reload} /> : null}
      {modal?.kind === 'password' ? <PasswordDialog name={modal.name} onClose={() => setModal(null)} /> : null}
      {modal?.kind === 'upload' ? <UploadDialog name={modal.name} onClose={() => { setModal(null); traders.reload() }} /> : null}
      {modal?.kind === 'token' ? <TokenDialog name={modal.name} token={modal.token} onClose={() => setModal(null)} /> : null}
    </VStack>
  )
}

function Shell(props: { title: string; onClose: () => void; children: React.ReactNode; footer: React.ReactNode }): React.ReactElement {
  return (
    <Dialog isOpen onOpenChange={props.onClose} purpose="form" width={520}>
      <Layout
        header={<DialogHeader title={props.title} onOpenChange={props.onClose} />}
        content={<LayoutContent><VStack gap={4}>{props.children}</VStack></LayoutContent>}
        footer={<LayoutFooter hasDivider><HStack gap={2} justify="end">{props.footer}</HStack></LayoutFooter>}
      />
    </Dialog>
  )
}

const CONFIRM_TEXT = {
  disable: { title: 'Disable', body: 'This locks the trader out: they cannot sign in until you enable them again.', go: 'Disable trader' },
  revoke: { title: 'Revoke token', body: "The trader's watcher stops syncing until a new token is issued and pasted on their PC.", go: 'Revoke token' },
  issue: { title: 'Issue a new token', body: "This replaces the live token. The trader's watcher stops syncing until the new token is pasted on their PC.", go: 'Issue new token' },
} as const

function ConfirmDialog(props: {
  action: 'disable' | 'revoke' | 'issue'; name: string; onCancel: () => void; onConfirm: () => void
}): React.ReactElement {
  const t = CONFIRM_TEXT[props.action]
  return (
    <Shell title={`${t.title} · ${props.name}`} onClose={props.onCancel} footer={
      <>
        <Button variant="secondary" label="Keep as is" onClick={props.onCancel} />
        <Button variant="primary" label={t.go} onClick={props.onConfirm} />
      </>
    }>
      <Text>{t.body}</Text>
    </Shell>
  )
}

function AddTraderDialog(props: { onClose: () => void; onDone: () => void }): React.ReactElement {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = async (): Promise<void> => {
    setBusy(true); setError(null)
    try { await tapi.addTrader(username.trim().toLowerCase(), password); props.onDone(); props.onClose() }
    catch (err) { setError(message(err)); setBusy(false) }
  }
  return (
    <Shell title="Add trader" onClose={props.onClose} footer={
      <>
        <Button variant="secondary" label="Cancel" onClick={props.onClose} />
        <Button variant="primary" label="Create trader" isDisabled={busy} onClick={() => void save()} />
      </>
    }>
      {error !== null ? <Banner status="error" title={error} /> : null}
      <TextInput label="Username" value={username} onChange={setUsername} description="2-32 characters: a-z, 0-9, . _ -" />
      <TextInput label="Password" type="password" value={password} onChange={setPassword} description="At least 8 characters" />
    </Shell>
  )
}

function PasswordDialog(props: { name: string; onClose: () => void }): React.ReactElement {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = async (): Promise<void> => {
    setBusy(true); setError(null)
    try { await tapi.patchTrader(props.name, { password }); props.onClose() }
    catch (err) { setError(message(err)); setBusy(false) }
  }
  return (
    <Shell title={`Reset password · ${props.name}`} onClose={props.onClose} footer={
      <>
        <Button variant="secondary" label="Cancel" onClick={props.onClose} />
        <Button variant="primary" label="Set password" isDisabled={busy} onClick={() => void save()} />
      </>
    }>
      {error !== null ? <Banner status="error" title={error} /> : null}
      <TextInput label="New password" type="password" value={password} onChange={setPassword} description="At least 8 characters" />
    </Shell>
  )
}

/** The token is held only by this dialog's props; closing unmounts it, so it is not in the page afterwards. */
function TokenDialog(props: { name: string; token: string; onClose: () => void }): React.ReactElement {
  const [copy, setCopy] = useState<'idle' | 'copied' | 'manual'>('idle')
  const field = useRef<HTMLSpanElement>(null)
  const select = (): void => {
    const el = field.current
    if (el === null) return
    const range = document.createRange()
    range.selectNodeContents(el)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
  }
  // Plain HTTP has no navigator.clipboard: select the text and say so, never fail silently.
  const manual = (): void => {
    select()
    let ok = false
    try { ok = typeof document.execCommand === 'function' && document.execCommand('copy') } catch { ok = false }
    setCopy(ok ? 'copied' : 'manual')
  }
  const doCopy = (): void => {
    if (navigator.clipboard?.writeText === undefined) { manual(); return }
    navigator.clipboard.writeText(props.token).then(() => setCopy('copied'), manual)
  }
  return (
    <Shell title={`Watcher token · ${props.name}`} onClose={props.onClose} footer={
      <>
        <Button variant="secondary" label={copy === 'copied' ? 'Copied' : 'Copy token'} onClick={doCopy} />
        <Button variant="primary" label="Done" onClick={props.onClose} />
      </>
    }>
      <Banner status="warning" title="Copy it now — it is not shown again" />
      <span ref={field}>
        <Text style={{ fontFamily: 'var(--font-mono, monospace)', wordBreak: 'break-all', userSelect: 'all' }}>{props.token}</Text>
      </span>
      {copy === 'manual' ? <Text color="secondary" size="sm">Copy didn&apos;t work here — the token is selected, press Ctrl+C</Text> : null}
    </Shell>
  )
}

function UploadDialog(props: { name: string; onClose: () => void }): React.ReactElement {
  const [file, setFile] = useState<File | null>(null)
  const [path, setPath] = useState('')
  const [edited, setEdited] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ parser: string | null; parseError: string | null } | null>(null)

  const choose = (f: File | File[] | null): void => {
    const one = Array.isArray(f) ? (f[0] ?? null) : f
    setFile(one)
    if (!edited) setPath(one?.name ?? '')
  }
  const send = async (): Promise<void> => {
    if (file === null || path.trim() === '') { setError('Choose a file and give its path.'); return }
    setBusy(true); setError(null); setResult(null)
    try { setResult(await tapi.uploadFile(props.name, path.trim(), file)) }
    catch (err) { setError(message(err)) }
    finally { setBusy(false) }
  }
  return (
    <Shell title={`Upload file · ${props.name}`} onClose={props.onClose} footer={
      <>
        <Button variant="secondary" label="Close" onClick={props.onClose} />
        <Button variant="primary" label="Upload" isDisabled={busy} onClick={() => void send()} />
      </>
    }>
      {error !== null ? <Banner status="error" title={error} /> : null}
      <FileInput label="File" value={file} onChange={choose} />
      <TextInput
        label="Path"
        value={path}
        onChange={(v) => { setPath(v); setEdited(true) }}
        description="Relative path as the watcher would send it, e.g. Nse Derivatives/Trades/1019TRD.TXT"
      />
      {result === null ? null : result.parseError !== null
        ? <Banner status="error" title={`Stored, but it did not parse: ${result.parseError}`} />
        : <Banner status="success" title={result.parser === null ? 'Stored (no parser for this path)' : `Stored and parsed by ${result.parser}`} />}
    </Shell>
  )
}
