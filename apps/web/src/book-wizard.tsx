/**
 * NEW BOOK — a four-step wizard for a strategy that places its own trades
 * (operator, 5 Nov: "rethink create book page, make it into wizard based …
 * simple with each dials and its description … focus on bull-s for now").
 *
 *   1 · Strategy and preset   the preset is the default for every dial
 *   2 · Expiry                only expiries that have not settled; the tag
 *   3 · Dials                 every dial, titled and described, changeable
 *   4 · Review and create     what changed, what stops it, then Create
 *
 * NOTHING IS TRADED HERE. A BULL-S book starts empty — the engine sells its
 * own straddles once it is started — so creating one is only its registry
 * row: `desired: stopped`, LIVE switched off. Switching it on (Strategies,
 * password-gated) and Start (Books) stay where they were.
 *
 * The structure builder (`#/build`), which OPENS legs with real orders and
 * then registers what filled, is still one link away for the books that need
 * a position on day one. The arithmetic is in `book-wizard-plan.ts`.
 */
import { useEffect, useMemo, useState } from 'react'
import { VStack, HStack } from '@astryxdesign/core/Layout'
import { Card } from '@astryxdesign/core/Card'
import { Text, Heading } from '@astryxdesign/core/Text'
import { Badge } from '@astryxdesign/core/Badge'
import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { TextInput } from '@astryxdesign/core/TextInput'
import { Switch } from '@astryxdesign/core/Switch'
import { NumberInput } from '@astryxdesign/core/NumberInput'
import { Collapsible } from '@astryxdesign/core/Collapsible'
import { api, explain, type DeskMode, type DialValue } from './api.ts'
import { goTo, usePoll } from './shell.tsx'
import { expiryClass, expiryPillLabel } from './chain-model.ts'
import { dialMeta, readDial, type DialFieldView } from './dials-plan.ts'
import { currencySymbol } from './format.ts'
import {
  BS_TITLES, liveExpiries, pickExpiry, wizardChanges, wizardDials, wizardGroups, wizardPresets,
  wizardProblems, wizardRefusals, wizardTag, type WizardGroup, type WizardPreset, type WizardStrategy,
} from './book-wizard-plan.ts'

/** BULL-S books are Delta BTC books; the preset table carries no other symbol. */
const SYMBOL = 'BTC'

const STEPS = ['Strategy', 'Expiry', 'Dials', 'Review'] as const

const CLASS_LABEL = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' } as const

/** What each strategy does, in a sentence — the step-1 heading over its presets. */
const STRATEGY_TEXT: Readonly<Record<WizardStrategy, { name: string; text: string }>> = {
  'bull-s': {
    name: 'BULL-S',
    text: 'Sells a BTC straddle each time the index crosses a grid level, each one bigger than the last. ' +
      'Each straddle is bought back whole when its combined price passes the stop.',
  },
  'lion-s': {
    name: 'LION-S',
    text: 'Sells a straddle at each crossing, the same size every time, and treats each leg as its own position: ' +
      'a leg is bought back on its own price, the other is kept, and the next crossing of that level sells only the missing leg.',
  },
}

// ------------------------------------------------------------------ pieces

/** Where the wizard is: done steps ticked, the current one bold. */
function Stepper(props: { at: number }): React.ReactElement {
  return (
    <HStack gap={3} wrap="wrap" align="center">
      {STEPS.map((name, i) => (
        <Text
          key={name}
          weight={i === props.at ? 'bold' : 'normal'}
          color={i > props.at ? 'secondary' : 'primary'}
        >
          {`${i < props.at ? '✓' : String(i + 1)} · ${name}`}
        </Text>
      ))}
    </HStack>
  )
}

/** One preset: its name as the button, its numbers under it. */
function PresetChoice(props: { p: WizardPreset; picked: boolean; onPick: () => void }): React.ReactElement {
  const { p } = props
  const $ = currencySymbol()
  return (
    <VStack gap={0}>
      <Button
        variant={props.picked ? 'primary' : 'secondary'}
        label={p.label}
        onClick={props.onPick}
      />
      <Text size="sm" color="secondary">
        {`levels every ${$}${p.grid.toLocaleString('en-US')} · sizes ${p.start} → +${p.step} each → cap ${p.cap} contracts · loss cap ${$}${p.lossCap}`}
      </Text>
    </VStack>
  )
}

/**
 * ONE DIAL: its plain name, the box, and under it what it does, its value in
 * words, and whether it is still the preset's. A changed dial can be put back
 * in one click. A value the engine would refuse is shown as typed, marked,
 * and named — never silently swapped back for the preset's.
 */
function DialField(props: {
  field: DialFieldView
  typed: DialValue | undefined
  refusal: string | undefined
  onChange: (key: string, value: DialValue) => void
  onReset: (key: string) => void
}): React.ReactElement {
  const { field, typed, refusal } = props
  const meta = dialMeta(field.key)
  const title = BS_TITLES[field.key] ?? field.key
  const shown = refusal !== undefined && typed !== undefined ? typed : field.value
  const changed = field.overridden || refusal !== undefined
  const reading = readDial(field.key, shown)
  const presetReading = readDial(field.key, field.presetValue)
  const description = [
    meta.help,
    reading === null ? null : `= ${reading}`,
    changed
      ? `changed from the preset’s ${String(field.presetValue)}${presetReading === null ? '' : ` (${presetReading})`}`
      : 'preset default',
    field.key,
  ]
    .filter((x): x is string => x !== null)
    .join(' · ')

  const input =
    field.kind === 'boolean' ? (
      <Switch
        label={title}
        description={description}
        value={shown === true}
        onChange={(v) => props.onChange(field.key, v)}
      />
    ) : (
      <NumberInput
        label={title}
        description={description}
        units={meta.units}
        value={typeof shown === 'number' ? shown : 0}
        width={260}
        onChange={(v) => props.onChange(field.key, v)}
        {...(refusal === undefined ? {} : { status: { type: 'error' as const, message: refusal } })}
      />
    )

  return (
    <VStack gap={1} align="start">
      <HStack gap={1} align="center" wrap="wrap">
        {meta.risk ? <Badge variant="error" label="risk limit" /> : null}
        {changed ? <Badge variant="info" label="changed" /> : null}
        {changed ? (
          <Button variant="ghost" size="sm" label={`Reset to ${String(field.presetValue)}`} onClick={() => props.onReset(field.key)} />
        ) : null}
      </HStack>
      {input}
    </VStack>
  )
}

function DialGroup(props: {
  group: WizardGroup
  overrides: Readonly<Record<string, DialValue>>
  refusals: ReadonlyMap<string, string>
  onChange: (key: string, value: DialValue) => void
  onReset: (key: string) => void
}): React.ReactElement {
  const { group } = props
  const changed = group.fields.filter((f) => f.overridden || props.refusals.has(f.key)).length
  const body = (
    <VStack gap={3}>
      {group.fields.map((f) => (
        <DialField
          key={f.key}
          field={f}
          typed={props.overrides[f.key]}
          refusal={props.refusals.get(f.key)}
          onChange={props.onChange}
          onReset={props.onReset}
        />
      ))}
    </VStack>
  )
  const head = (
    <HStack gap={2} align="center" wrap="wrap">
      <Text weight="bold">{group.label}</Text>
      {group.advanced ? <Badge variant="neutral" label={`${group.fields.length} dials`} /> : null}
      {changed > 0 ? <Badge variant="info" label={`${changed} changed`} /> : null}
    </HStack>
  )
  return (
    <Card>
      <VStack gap={2}>
        {group.advanced ? (
          <Collapsible defaultIsOpen={changed > 0} trigger={head}>
            <VStack gap={2}>
              <Text size="sm" color="secondary">{group.note}</Text>
              {body}
            </VStack>
          </Collapsible>
        ) : (
          <>
            {head}
            <Text size="sm" color="secondary">{group.note}</Text>
            {body}
          </>
        )}
      </VStack>
    </Card>
  )
}

// -------------------------------------------------------------------- page

export function BookWizardPage(props: { mode: DeskMode }): React.ReactElement {
  const presets = useMemo(() => wizardPresets(), [])
  const [step, setStep] = useState(0)
  const [preset, setPreset] = useState<string>(presets[0]?.key ?? '')
  const [expiry, setExpiry] = useState('')
  /** True once the operator picked an expiry by hand: a preset change then leaves it alone. */
  const [expiryChosen, setExpiryChosen] = useState(false)
  const [suffix, setSuffix] = useState('')
  const [overrides, setOverrides] = useState<Record<string, DialValue>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<string | null>(null)

  const listed = usePoll(() => api.chainExpiries(SYMBOL), 60_000)
  const registry = usePoll(() => api.bookRegistry.list(props.mode), 30_000, [props.mode])

  // Re-read with each expiry poll, not each render: the list it filters moves no faster.
  const now = useMemo(() => Date.now(), [listed.data])
  const live = useMemo(() => liveExpiries(listed.data ?? [], now), [listed.data, now])
  const chosen = presets.find((p) => p.key === preset)

  /*
    THE DEFAULT EXPIRY FOLLOWS THE PRESET until the operator picks one: the
    nearest expiry of the preset's class. One that settles while the page is
    open is dropped, and the default re-picked.
  */
  useEffect(() => {
    if (chosen === undefined) return
    if (expiryChosen && live.includes(expiry)) return
    const next = pickExpiry(live, chosen.expiryClass)
    if (next !== expiry) setExpiry(next)
    if (expiryChosen && !live.includes(expiry)) setExpiryChosen(false)
  }, [chosen, live, expiry, expiryChosen])

  const tag = wizardTag(SYMBOL, expiry, preset, suffix)
  const taken = (registry.data ?? []).map((b) => b.tag)
  const groups = wizardGroups(preset, overrides)
  const refusals = wizardRefusals(preset, overrides)
  const changes = wizardChanges(preset, overrides)
  const problems = wizardProblems({ preset, overrides, mode: props.mode, expiry, tag, taken })
  const tagTaken = taken.includes(tag)

  const onChange = (key: string, value: DialValue): void => setOverrides((o) => ({ ...o, [key]: value }))
  const onReset = (key: string): void =>
    setOverrides((o) => {
      const { [key]: _gone, ...rest } = o
      return rest
    })

  const create = async (): Promise<void> => {
    if (problems.length > 0) return
    setError(null)
    setBusy(true)
    try {
      await api.bookRegistry.create({
        tag,
        symbol: SYMBOL,
        expiry,
        mode: props.mode,
        // The preset's key as the row's label — the field every reader of a
        // registry row keys on (`variant`, its historical name).
        variant: preset,
        dials: wizardDials(preset, overrides),
      })
      setCreated(tag)
    } catch (e) {
      setError(explain(e))
    } finally {
      setBusy(false)
    }
  }

  const restart = (): void => {
    setCreated(null)
    setStep(0)
    setSuffix('')
    setOverrides({})
    setExpiryChosen(false)
  }

  // Step 2 needs an expiry and a free tag before it can be left.
  const canNext = step === 1 ? expiry !== '' && !tagTaken : step < STEPS.length - 1

  return (
    <VStack gap={3}>
      <HStack gap={3} align="center" justify="between" wrap="wrap">
        <VStack gap={0}>
          <Heading level={2}>New book</Heading>
          <Text color="secondary">
            For a strategy that places its own trades: the book starts with no positions. Nothing is traded on this page.
          </Text>
        </VStack>
        <Button
          variant="ghost"
          label="Open a structure with real orders instead"
          onClick={() => goTo('build')}
        />
      </HStack>

      {props.mode === 'live' ? (
        <Banner
          status="warning"
          title="Creating a LIVE book"
          description="It is created stopped, with LIVE switched off. It trades only after you switch it on (Strategies, with your password) and press Start (Books)."
        />
      ) : null}

      <Stepper at={created === null ? step : STEPS.length} />

      {created !== null ? (
        <Card>
          <VStack gap={2}>
            <Banner status="success" title={`Created ${created}`} description="Stopped, with no positions. Nothing has traded." />
            <Text weight="bold">Next</Text>
            <Text>
              {props.mode === 'live'
                ? '1. Strategies: switch the book on for LIVE (asks for your password).  2. Books: press Start.'
                : '1. Books: press Start.'}
            </Text>
            <Text size="sm" color="secondary">
              Dials can still be changed on the Books page (Dials) at any time, even while it runs.
            </Text>
            <HStack gap={1} wrap="wrap">
              <Button label="Go to Books" onClick={() => goTo('books')} />
              {props.mode === 'live' ? (
                <Button variant="secondary" label="Go to Strategies" onClick={() => goTo('strategies')} />
              ) : null}
              <Button variant="ghost" label="Create another" onClick={restart} />
            </HStack>
          </VStack>
        </Card>
      ) : (
        <>
          {step === 0 ? (
            <Card>
              <VStack gap={3}>
                <Heading level={3}>1 · Strategy and preset</Heading>
                <Text color="secondary">
                  The preset fills every dial with tested defaults; you can change any of them in step 3.
                </Text>
                {(['bull-s', 'lion-s'] as const).map((strategy) => (
                  <VStack key={strategy} gap={2}>
                    <Heading level={4}>{STRATEGY_TEXT[strategy].name}</Heading>
                    <Text>{STRATEGY_TEXT[strategy].text}</Text>
                    {(['daily', 'weekly', 'monthly'] as const).map((cls) => {
                      const these = presets.filter((p) => p.strategy === strategy && p.expiryClass === cls)
                      if (these.length === 0) return null
                      return (
                        <VStack key={cls} gap={2}>
                          <Text weight="bold">{CLASS_LABEL[cls]}</Text>
                          {these.map((p) => (
                            <PresetChoice key={p.key} p={p} picked={p.key === preset} onPick={() => setPreset(p.key)} />
                          ))}
                        </VStack>
                      )
                    })}
                  </VStack>
                ))}
              </VStack>
            </Card>
          ) : null}

          {step === 1 ? (
            <Card>
              <VStack gap={3}>
                <Heading level={3}>2 · Expiry</Heading>
                {listed.error !== null && listed.data === null ? (
                  <Banner status="error" title="The expiry list could not be loaded" description={listed.error} />
                ) : null}
                {listed.data !== null && live.length === 0 ? (
                  <Text color="secondary">No BTC expiries are listed that have not settled yet.</Text>
                ) : null}
                <Text size="sm" color="secondary">
                  {`Only expiries that have not settled (12:00 UTC on the day). Suggested for this preset: the nearest ${chosen?.expiryClass ?? 'daily'} one.`}
                </Text>
                <HStack gap={1} wrap="wrap">
                  {live.map((e) => (
                    <Button
                      key={e}
                      variant={e === expiry ? 'primary' : 'secondary'}
                      label={`${expiryPillLabel(e, now)} · ${expiryClass(e)}`}
                      onClick={() => {
                        setExpiry(e)
                        setExpiryChosen(true)
                      }}
                    />
                  ))}
                </HStack>
                <TextInput
                  label="Tag suffix (optional)"
                  description="Add one to run a second book on the same expiry and preset."
                  value={suffix}
                  onChange={setSuffix}
                />
                <VStack gap={0}>
                  <Text size="sm" color="secondary">The book will be called</Text>
                  <Text weight="bold">{tag}</Text>
                </VStack>
                {tagTaken ? (
                  <Banner
                    status="error"
                    title="That tag is taken"
                    description={`A book called ${tag} already exists in ${props.mode}. Add a tag suffix to make a new one.`}
                  />
                ) : null}
              </VStack>
            </Card>
          ) : null}

          {step === 2 ? (
            <VStack gap={2}>
              <Card>
                <VStack gap={1}>
                  <Heading level={3}>3 · Dials</Heading>
                  <Text>
                    {`Every dial starts at the ${chosen?.label ?? preset} preset. Change only what you need — a changed dial is marked and can be reset.`}
                  </Text>
                </VStack>
              </Card>
              {groups.map((g) => (
                <DialGroup
                  key={g.key}
                  group={g}
                  overrides={overrides}
                  refusals={refusals}
                  onChange={onChange}
                  onReset={onReset}
                />
              ))}
            </VStack>
          ) : null}

          {step === 3 ? (
            <Card>
              <VStack gap={3}>
                <Heading level={3}>4 · Review and create</Heading>
                <VStack gap={1}>
                  <Text>{`Book: ${tag}`}</Text>
                  <Text>{`Mode: ${props.mode === 'live' ? 'LIVE' : 'paper'} · ${SYMBOL} · expiry ${expiry}`}</Text>
                  <Text>{`Preset: ${chosen?.label ?? preset}`}</Text>
                </VStack>
                <VStack gap={1}>
                  <Text weight="bold">Changed from the preset</Text>
                  {changes.length === 0 ? (
                    <Text color="secondary">Nothing — the preset as it stands.</Text>
                  ) : (
                    changes.map((c) => (
                      <Text key={c.key}>{`${c.title ?? c.key}: ${String(c.from)} → ${String(c.to)}`}</Text>
                    ))
                  )}
                </VStack>
                {problems.length > 0 ? (
                  <Banner
                    status="error"
                    title="Fix these before creating"
                    description={problems.join(' ')}
                  />
                ) : null}
                <Text size="sm" color="secondary">
                  The book is created STOPPED with no positions, LIVE switched off. Nothing trades until you start it.
                </Text>
                {error !== null ? <Banner status="error" title="The book was not created" description={error} /> : null}
                <HStack gap={1}>
                  <Button
                    label={busy ? 'Creating…' : 'Create book'}
                    isDisabled={busy || problems.length > 0}
                    onClick={() => void create()}
                  />
                </HStack>
              </VStack>
            </Card>
          ) : null}

          <HStack gap={1}>
            <Button variant="secondary" label="Back" isDisabled={step === 0} onClick={() => setStep((s) => Math.max(0, s - 1))} />
            {step < STEPS.length - 1 ? (
              <Button label="Next" isDisabled={!canNext} onClick={() => setStep((s) => s + 1)} />
            ) : null}
          </HStack>
        </>
      )}
    </VStack>
  )
}
