/**
 * Broker credentials — one card per broker, edit and test.
 *
 * THE FORM WRITES CREDENTIALS AND NEVER DISPLAYS THEM. No endpoint on this
 * service returns a secret at any status, so there is nothing to prefill: the
 * fields open blank every time, and an empty submit leaves the stored value
 * untouched so a label can be corrected without retyping a password.
 *
 * ALL-OR-NOTHING ON THE SECRET. The credential is sealed as ONE blob, so
 * writing half of it would silently destroy the other half. The form therefore
 * accepts every secret field or none, and says so.
 *
 * `unreadable` IS NOT `absent`. "No XTS configured" is a setup step you have not
 * done; "XTS configured but the ciphertext will not open" means the master key
 * changed under the stored blob, and the only fix is re-entering the credential.
 * They are rendered as different states because they need different responses.
 */

import { useState } from 'react'
import { VStack, HStack, Layout, LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout'
import { Card } from '@astryxdesign/core/Card'
import { Grid } from '@astryxdesign/core/Grid'
import { Text, Heading } from '@astryxdesign/core/Text'
import { Badge } from '@astryxdesign/core/Badge'
import { Button } from '@astryxdesign/core/Button'
import { Banner } from '@astryxdesign/core/Banner'
import { TextInput } from '@astryxdesign/core/TextInput'
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog'
import {
  api, explain, localStamp,
  type BrokerKind, type BrokerRow, type BrokerState, type BrokerTestResult,
} from './api.ts'
import { usePoll } from './shell.tsx'

/**
 * Both brokers always get a card, even when the API returns neither, because
 * "XTS is not configured" is information the operator came here for. An empty
 * page would read as "nothing to do".
 */
const KINDS: readonly BrokerKind[] = ['xts', 'zerodha']

interface FieldSpec { key: string; label: string; hint?: string }

/**
 * The contract fixes the SHAPE (`secret` is an object of credential fields) but
 * not the field NAMES. These mirror the environment variables the consumers
 * already read — `XTS_APP_KEY` / `XTS_SECRET_KEY`, `ZERODHA_PASSWORD` /
 * `ZERODHA_TOTP_SECRET` — so a credential typed here matches the one the
 * gateway was booting with.
 */
const FIELDS: Record<BrokerKind, { label: string; secret: FieldSpec[]; meta: FieldSpec[] }> = {
  xts: {
    label: 'XTS',
    secret: [
      { key: 'appKey', label: 'App key' },
      { key: 'secretKey', label: 'Secret key' },
    ],
    meta: [
      { key: 'baseUrl', label: 'Base URL' },
      { key: 'uniqueKey', label: 'Unique key' },
      /**
       * THE DEALER CLIENT CODE, and it is `meta` rather than `secret` on
       * purpose: it is an account identifier, not a credential, so it can be
       * shown on the card without breaking the rule that no secret is ever
       * rendered — and being in `meta` is also what lets it be saved without
       * re-typing the app key.
       *
       * A DEALER ACCOUNT NEEDS IT. The gateway otherwise derives `clientID`
       * from the login response, which for a dealer is the dealer's own id and
       * not the account orders must be stamped with; the legacy system carried
       * it as an account field and the port dropped it. Blank keeps the
       * derived value, which is correct for an investor account.
       */
      {
        key: 'clientId',
        label: 'Client code (dealer accounts)',
        hint: 'Leave blank to use whatever the login returns — correct for an investor account. A DEALER account must state it here, or orders are stamped with the wrong client.',
      },
    ],
  },
  zerodha: {
    label: 'Zerodha',
    secret: [
      { key: 'password', label: 'Password' },
      { key: 'totpSecret', label: 'TOTP secret' },
    ],
    meta: [{ key: 'userId', label: 'User id' }],
  },
}

function stateBadge(state: BrokerState): React.ReactElement {
  switch (state) {
    case 'ok': return <Badge variant="success" label="verified" />
    case 'error': return <Badge variant="error" label="login failed" />
    case 'unreadable': return <Badge variant="error" label="unreadable" />
    default: return <Badge variant="neutral" label="not configured" />
  }
}

/** What the operator should DO about this state, in words, not a colour. */
function stateNote(kind: BrokerKind, row: BrokerRow): React.ReactElement | null {
  const name = FIELDS[kind].label
  if (row.state === 'absent') {
    return (
      <Banner
        status="info"
        title={`No ${name} credentials stored`}
        description="The market-data and gateway processes fall back to their environment variables until a credential is entered here."
      />
    )
  }
  if (row.state === 'unreadable') {
    return (
      <Banner
        status="error"
        title={`${name} is configured but the stored credential will not open`}
        description="This is not the same as missing. The master key no longer matches the sealed blob — re-enter the credential to replace it. Nothing will authenticate until you do."
      />
    )
  }
  if (row.state === 'error' && row.lastError !== null) {
    return <Banner status="error" title={`${name} login failed`} description={row.lastError} />
  }
  return null
}

function MetaRow(props: { label: string; value: string }): React.ReactElement {
  // `wrap`, because a value here is a base URL or a client code: a label and a
  // 60-character URL do not share a 320px line, and without it the pair sets
  // the width of the card rather than the card setting the width of the pair.
  return (
    <HStack justify="between" wrap="wrap" gap={2}>
      <Text color="secondary" size="sm">{props.label}</Text>
      <Text size="sm">{props.value}</Text>
    </HStack>
  )
}

// -------------------------------------------------------------- edit dialog

function EditDialog(props: {
  kind: BrokerKind
  row: BrokerRow
  onClose: () => void
  onSaved: () => void
}): React.ReactElement {
  const spec = FIELDS[props.kind]
  const [label, setLabel] = useState(props.row.label)
  /**
   * SEEDED FROM THE WHOLE STORED `meta`, not just the fields shown.
   *
   * A save REPLACES `meta` server-side, so seeding only the keys this form
   * knows about would silently delete the ones it does not — `prefix`,
   * `hostLookupUrl` and `investorClient` are all read by the gateway and none
   * of them has an input here. Correcting a label would have quietly changed
   * how the process logs in.
   */
  const [meta, setMeta] = useState<Record<string, unknown>>(() => ({ ...props.row.meta }))
  const metaText = (key: string): string => {
    const v = meta[key]
    return v === undefined || v === null ? '' : String(v)
  }
  // Always blank. There is nothing to prefill it from — by design.
  const [secret, setSecret] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const filled = spec.secret.filter((f) => (secret[f.key] ?? '') !== '')
  const partial = filled.length > 0 && filled.length < spec.secret.length

  const save = async (): Promise<void> => {
    if (partial) return
    setBusy(true)
    setError(null)
    try {
      await api.saveBroker(props.kind, {
        label,
        meta,
        // Omitted entirely when blank: the server treats a missing `secret` as
        // "leave the stored credential alone", which is what lets a label be
        // fixed without the password.
        ...(filled.length === 0 ? {} : { secret }),
      })
      props.onSaved()
      props.onClose()
    } catch (err) {
      setError(explain(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog isOpen onOpenChange={props.onClose} purpose="form" width={480}>
      <Layout
        header={<DialogHeader title={`${spec.label} credentials`} onOpenChange={props.onClose} />}
        content={
          <LayoutContent>
            <VStack gap={4}>
              {error !== null ? <Banner status="error" title="Could not save" description={error} /> : null}

              <TextInput label="Label" value={label} onChange={setLabel} />

              {spec.meta.map((f) => (
                <TextInput
                  key={f.key}
                  label={f.label}
                  value={metaText(f.key)}
                  onChange={(v) => setMeta((m) => ({ ...m, [f.key]: v }))}
                  {...(f.hint === undefined ? {} : { description: f.hint })}
                />
              ))}

              <Text color="secondary" size="sm">
                Credential fields are blank because the API cannot return a stored
                secret. Leave them blank to keep the current credential; fill in
                every one of them to replace it.
              </Text>

              {spec.secret.map((f) => (
                <TextInput
                  key={f.key}
                  label={f.label}
                  type="password"
                  value={secret[f.key] ?? ''}
                  onChange={(v) => setSecret((s) => ({ ...s, [f.key]: v }))}
                  placeholder="unchanged"
                />
              ))}

              {partial ? (
                <Banner
                  status="warning"
                  title="Fill in every credential field, or none"
                  description="The credential is sealed as a single value, so saving one field would discard the others. Complete the set or clear what you have typed."
                />
              ) : null}
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <HStack gap={2} justify="end">
              <Button variant="secondary" label="Cancel" onClick={props.onClose} />
              <Button
                variant="primary"
                label={filled.length === 0 ? 'Save (credential unchanged)' : 'Save credential'}
                isLoading={busy}
                isDisabled={busy || partial}
                onClick={() => void save()}
              />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  )
}

// ---------------------------------------------------------------- the page

/**
 * The credential cards, AS A SECTION rather than a page.
 *
 * They had their own nav tab beside Feed's. Both answer halves of "is the desk
 * working?", and neither said anything about whether the four Node processes
 * and the two Python supervisors are alive — so all three now sit on one Status
 * page, and this is the last third. Nothing about what it writes has changed:
 * Edit credentials and Test connection behave exactly as they did.
 *
 * `level={3}`, because it is no longer the title of the screen it is on.
 */
export function BrokersSection(): React.ReactElement {
  const { data, error, refresh } = usePoll(() => api.brokers(), 20_000)
  const [editing, setEditing] = useState<BrokerKind | null>(null)
  const [testing, setTesting] = useState<BrokerKind | null>(null)
  const [results, setResults] = useState<Partial<Record<BrokerKind, BrokerTestResult>>>({})

  const byKind = new Map((data?.brokers ?? []).map((b) => [b.kind, b]))

  const test = async (kind: BrokerKind): Promise<void> => {
    setTesting(kind)
    try {
      const r = await api.testBroker(kind)
      setResults((prev) => ({ ...prev, [kind]: r }))
      refresh()
    } catch (err) {
      // A transport failure is NOT a credential verdict, and is labelled as its
      // own thing so "the bridge is down" is never read as "the password is wrong".
      setResults((prev) => ({
        ...prev,
        [kind]: { ok: false, error: `could not reach the bridge: ${explain(err)}` },
      }))
    } finally {
      setTesting(null)
    }
  }

  return (
    <VStack gap={4}>
      <Heading level={3}>Brokers</Heading>

      {error !== null ? (
        <Banner
          status="error"
          title="Broker settings could not be loaded"
          description={`${error}. Nothing below reflects what is actually stored.`}
        />
      ) : null}

      <Text color="secondary" size="sm">
        Credentials are stored encrypted and are never returned by any endpoint —
        not here, not anywhere. Testing performs a real login, which is what makes
        "are my credentials right?" answerable without restarting a process and
        reading its logs.
      </Text>

      {/*
        Two cards side by side on a desk, one above the other below ~700px.
        320px is the width at which a credential card's "Client code (dealer
        accounts)" row still fits its label and its value on one line.
      */}
      <Grid columns={{ minWidth: 320, max: 2 }} gap={4}>
        {KINDS.map((kind) => {
          const row: BrokerRow = byKind.get(kind) ?? {
            kind, label: FIELDS[kind].label, meta: {}, configured: false,
            state: 'absent', lastVerifiedAt: null, lastError: null,
          }
          const result = results[kind]
          return (
            <Card key={kind}>
              <VStack gap={3} padding={4}>
                <HStack justify="between" align="center" wrap="wrap">
                  <Heading level={3}>{row.label === '' ? FIELDS[kind].label : row.label}</Heading>
                  {stateBadge(row.state)}
                </HStack>

                {stateNote(kind, row)}

                <VStack gap={1}>
                  {FIELDS[kind].meta.map((f) => {
                    const v = row.meta[f.key]
                    return (
                      <MetaRow
                        key={f.key}
                        label={f.label}
                        value={v === undefined || v === null || v === '' ? '—' : String(v)}
                      />
                    )
                  })}
                  {/* Pinned, like every other timestamp on the desk — the
                      browser's default put "8/1/2026, 1:09:36 PM" beside a
                      column of 24-hour times everywhere else. */}
                  <MetaRow
                    label="Last verified"
                    value={row.lastVerifiedAt === null ? 'never' : localStamp(row.lastVerifiedAt)}
                  />
                </VStack>

                {result !== undefined ? (
                  result.ok ? (
                    <Banner
                      status="success"
                      title="Login succeeded"
                      description={[
                        result.verifiedAt === undefined
                          ? null
                          : localStamp(result.verifiedAt),
                        // The server's caveat about WHAT was proved. Never dropped:
                        // a bare "succeeded" over a reused session is an overclaim.
                        result.note ?? null,
                      ].filter((x): x is string => x !== null).join(' — ')}
                    />
                  ) : (
                    <Banner
                      status="error"
                      title="Login failed"
                      description={result.error ?? 'the broker refused without saying why'}
                    />
                  )
                ) : null}

                <HStack gap={2} wrap="wrap">
                  <Button variant="secondary" label="Edit credentials" onClick={() => setEditing(kind)} />
                  <Button
                    variant="ghost"
                    label="Test connection"
                    isLoading={testing === kind}
                    isDisabled={testing !== null || !row.configured}
                    {...(row.configured ? {} : { tooltip: 'Nothing is stored to test yet' })}
                    onClick={() => void test(kind)}
                  />
                </HStack>
              </VStack>
            </Card>
          )
        })}
      </Grid>

      {editing !== null ? (
        <EditDialog
          kind={editing}
          row={byKind.get(editing) ?? {
            kind: editing, label: FIELDS[editing].label, meta: {}, configured: false,
            state: 'absent', lastVerifiedAt: null, lastError: null,
          }}
          onClose={() => setEditing(null)}
          onSaved={refresh}
        />
      ) : null}
    </VStack>
  )
}
