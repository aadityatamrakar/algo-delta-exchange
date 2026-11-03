/**
 * THE BOOK'S DIALS, AS SECTIONS AND SWITCHES, EDITABLE WHILE IT RUNS.
 *
 * The supervisor pushes the registry row's dials into the live worker before
 * every tick, so a save here reaches a RUNNING book at its next mark. That is
 * what lets this exist at all: dials used to be read once on the
 * stopped->running transition, so an edit was saved and then silently ignored,
 * and a control that lies about having worked is worse than no control.
 *
 * ON THE BOOKS PAGE, NOT THE POSITION PAGE. This edits what the book IS — the
 * same thing Start, Stop and Delete edit — where the position page answers
 * what it currently HOLDS.
 *
 * ── WHY THIS IS NO LONGER A JSON BOX ────────────────────────────────────────
 * It was a `<textarea>` of merged JSON, and the comment above it said the
 * honest reason: "a typed form needs each dial's units and kind, and the
 * catalogue publishes values rather than a schema". That is no longer true.
 * `packages/desk-engine` IS the schema — every field, its type, its section,
 * and the five master toggles — so the box can finally be a form that knows
 * what it is showing. Three things the JSON could not say, and this can:
 *
 *   WHICH DIALS ARE THE OPERATOR'S. A merged blob showed forty numbers with
 *   nothing marking the three somebody changed. Each field now states whether
 *   it is the preset's own value or an override, and what the preset says.
 *
 *   WHICH DIALS THE ENGINE IS ACTUALLY READING. `trend_skew: 0.5` under
 *   `trend_enabled: false` is not a lean of 0.5, it is nothing — the section's
 *   fields are marked INERT while its switch is off, rather than reading as
 *   live settings.
 *
 *   WHICH STORED ENTRIES THE ENGINE REFUSES. A retired dial, a typo or a value
 *   of the wrong type sitting in the row is surfaced as its own row (F-29,
 *   spec §11) instead of being folded invisibly into a blob. The old box could
 *   not tell `target_pnl` from `targetPnl`.
 *
 * ── AND WHAT THE DELTA-LEAN BOOKS ADDED ─────────────────────────────────────
 * The form was built for ~45 recenter dials in five sections. The second
 * decide path brought forty-eight more behind one switch, and the playbooks
 * fifty-one more behind none (`pb_playbook` 0 is that section's off-state), and
 * at that size three more things stop being legible on their own
 * (`dials-plan.ts` holds the tables; this file draws them):
 *
 *   GROUPS. `DIAL_SECTIONS` lists each of the two sections as one `fields`
 *   array; the engine file's own comments are what break them into budget and
 *   the exits, adjustment gating, the regime detector, strike selection,
 *   liquidity and the clock for delta lean, and selection, sizing, the common
 *   exits, debit spreads, short premium, staging, reversal and gamma for the
 *   playbooks. Those headings are restated here so neither section is one
 *   wall.
 *
 *   UNITS. `dl_flat_by_min: 900` is 15:00, `margin_cap: 2500000` is ₹25 lakh
 *   and `dl_dead_band_lots: 0.5` is half a future's worth of delta. The box
 *   still shows the raw number — it has to be typeable — and the reading
 *   sits under it.
 *
 *   RISK. Two of delta lean's forty-eight decide how much money the book can
 *   lose, and so do three of the playbook's fifty-one (`pb_lots`,
 *   `pb_trade_max_loss`, `pb_premium_budget`); in a row of identical number
 *   boxes they looked like all the others.
 *
 * THE ARITHMETIC IS NOT HERE. `dials-plan.ts` decides sections, overrides,
 * inertness and what a Save sends; it is pure and node-tested. This file draws
 * the result and owns exactly one behaviour of its own — the password gate
 * below, which is carried over verbatim.
 *
 * WHAT THIS PANEL STILL CANNOT CHECK is stated on screen: the API stores dials
 * verbatim and a dial read once at boot saves cleanly here and changes nothing
 * until a restart.
 */

import { useState } from 'react'
import { VStack, HStack } from '@astryxdesign/core/Layout'
import { Card } from '@astryxdesign/core/Card'
import { Text, Heading } from '@astryxdesign/core/Text'
import { Badge } from '@astryxdesign/core/Badge'
import { Button } from '@astryxdesign/core/Button'
import { Banner } from '@astryxdesign/core/Banner'
import { Switch } from '@astryxdesign/core/Switch'
import { NumberInput } from '@astryxdesign/core/NumberInput'
import { Selector } from '@astryxdesign/core/Selector'
import { Collapsible } from '@astryxdesign/core/Collapsible'
import { PRESETS } from '@algomaker/desk-engine/presets'
import { api, type BookRow, type DialValue } from './api.ts'
import { withReauth, type Reauth } from './auth.tsx'
import {
  dialMeta,
  dialsPatch,
  groupFields,
  planDialsView,
  presetDials,
  readDial,
  type DialFieldView,
  type DialSectionView,
} from './dials-plan.ts'

/**
 * A dial value as the operator reads it. NEVER formatted — no thousands
 * separator, no rounding: these are settings, and `1,00,00,000` is not a
 * number anyone can type back into the box beside it.
 *
 * The READABLE form of the same number — 09:30, ₹25,00,000, 50% — is a
 * separate line under the input (`readDial`), where it can say what the number
 * means without being something anyone has to retype.
 */
const show = (v: DialValue): string => String(v)

/**
 * ONE DIAL. A switch for a boolean, a number box for everything else — the
 * kind comes from the engine schema, so a boolean can never be typed into as a
 * number here the way it could in the JSON box.
 *
 * INERT FIELDS STAY EDITABLE, deliberately. Turning the section on and finding
 * the numbers already where you want them is the sane order to work in; a
 * disabled input would force switch-on, type, switch-off. The description says
 * what the state is, which is the part the old box could not say at all.
 *
 * THE DESCRIPTION IS FOUR CLAUSES, in the order an operator checks them: is
 * anything reading this at all, what does the number say in its own units,
 * what does the dial decide, and did somebody change it. All four are strings
 * built from static tables, so a hundred of these cost a hundred string joins
 * and nothing else.
 */
function DialInput(props: {
  field: DialFieldView
  toggleName: string | null
  onChange: (key: string, value: DialValue) => void
}): React.ReactElement {
  const { field } = props
  const meta = dialMeta(field.key)
  const reading = readDial(field.key, field.value)
  const presetReading = field.overridden ? readDial(field.key, field.presetValue) : null
  const description = [
    field.inert && props.toggleName !== null ? `inert — ${props.toggleName} is off.` : null,
    reading === null ? null : `= ${reading}`,
    meta.help,
    field.overridden
      ? `changed from the preset's ${show(field.presetValue)}` +
        (presetReading === null ? '' : ` (${presetReading})`)
      : 'preset default',
  ]
    .filter((part) => part !== null)
    .join(' · ')

  const input =
    field.kind === 'boolean' ? (
      <Switch
        label={field.key}
        description={description}
        value={field.value === true}
        onChange={(v) => props.onChange(field.key, v)}
      />
    ) : (
      <NumberInput
        label={field.key}
        description={description}
        // The unit sits in the input's own trailing slot rather than in the
        // label, so `dl_flat_by_min` still answers to its dial name — which is
        // the name the spec, the registry row and the PATCH all use.
        units={meta.units}
        value={typeof field.value === 'number' ? field.value : 0}
        width={220}
        onChange={(v) => props.onChange(field.key, v)}
      />
    )

  /**
   * THE DIALS THAT DECIDE WHAT THE BOOK CAN LOSE wear a badge.
   *
   * `dl_day_max_loss` and `dl_stuck_loss`, and in the playbooks `pb_lots`,
   * `pb_trade_max_loss` and `pb_premium_budget`, sit in sections of forty or
   * fifty numbers that otherwise all look alike, and a hand that lands on the
   * wrong one has changed how much money is at stake rather than how the book
   * trades. Not a `status` — a warning border would claim the VALUE is
   * wrong, and it is not; the dial is simply the dangerous kind.
   */
  if (!meta.risk) return input
  return (
    // `align="start"` so the badge hugs its own text instead of stretching to
    // the input's 220px, which would read as a banner over the field.
    <VStack gap={1} align="start">
      <Badge variant="error" label="risk limit" />
      {input}
    </VStack>
  )
}

/**
 * What a section's master switch being off actually costs, in words.
 *
 * The per-field `inert` marker says it forty times in small print; this
 * says it once, where the eye lands first, and names the number of dials it
 * covers so "off" is not mistaken for "these are defaults".
 */
function offNote(sectionKey: string, toggleName: string, count: number): string {
  const head = `The engine reads none of the ${count} dial${count === 1 ? '' : 's'} below while ${toggleName} is off`
  const why =
    sectionKey === 'delta-lean'
      ? ' — delta lean is a second engine rather than a tier of this one, and this book is on the recenter decide path entirely.'
      : '.'
  return `${head}${why} They keep their stored values, so switching it on puts exactly what you see here to work.`
}

/**
 * ONE SECTION, collapsible, with its master switch INSIDE it rather than in
 * the trigger — a switch inside a button is not a control anyone can operate
 * with a keyboard, and the badges beside the title say the same thing to a
 * reader who has the section shut: which switch is off, how many dials are
 * behind the chevron, and how many of them this book has changed.
 */
function DialsSection(props: {
  view: DialSectionView
  onChange: (key: string, value: DialValue) => void
}): React.ReactElement {
  const { section, toggle, fields } = props.view
  const changed = (toggle !== null && toggle.overridden ? 1 : 0) +
    fields.filter((f) => f.overridden).length
  const off = toggle !== null && toggle.value === false
  /**
   * A shut section's inputs are not mounted until it is first opened.
   *
   * `Collapsible` hides a closed section with `display:none`, which still pays
   * the full mount cost of every field inside it. With the delta-lean and
   * playbook sets the panel carries ~140 dials across sixteen sections, and
   * mounting the hundred-odd nobody asked to see is most of the panel's render
   * budget.
   *
   * Once opened it STAYS mounted: re-collapsing a section must not throw away
   * an edit the operator has typed but not yet saved.
   */
  const [everOpen, setEverOpen] = useState(section.collapsed !== true)
  return (
    <Collapsible
      // The "rarely touched" sections open shut (spec §5), so the panel is
      // not a wall of forty inputs on the way to the corridor width.
      defaultIsOpen={section.collapsed !== true}
      onOpenChange={(isOpen) => {
        if (isOpen) setEverOpen(true)
      }}
      trigger={
        <HStack gap={2} align="center" wrap="wrap">
          <Text weight="medium">{section.label}</Text>
          {/*
            WHICH switch is off, not merely that one is. A section shut and
            badged "off" leaves the operator to open it to find out what turned
            it off; the name is the thing they would go looking for.
          */}
          {toggle !== null && off ? <Badge variant="neutral" label={`${toggle.key} off`} /> : null}
          {/*
            How much is inside a section that opens SHUT. Delta lean is 47
            dials behind one chevron and Playbook 51, and a count is the
            difference between a header an operator opens and one they scroll
            past.
          */}
          {section.collapsed === true && fields.length > 0 ? (
            <Badge variant="neutral" label={`${fields.length} dials`} />
          ) : null}
          {changed > 0 ? <Badge variant="info" label={`${changed} changed`} /> : null}
        </HStack>
      }
    >
      {!everOpen ? null : (
        <VStack gap={2} padding={2}>
          {toggle === null ? null : (
            <DialInput field={toggle} toggleName={null} onChange={props.onChange} />
          )}
          {toggle !== null && off && fields.length > 0 ? (
            <Banner
              status="info"
              title={`${toggle.key} is off — nothing below is live`}
              description={offNote(section.key, toggle.key, fields.length)}
            />
          ) : null}
          {/*
            GROUPS, for the two sections that need them (Delta lean and
            Playbook). `groupFields` returns a single unlabelled group for
            every other section, so the recenter sections render exactly the
            flat row they always did — four dials under a heading do not need
            subheadings, and inventing them would push the corridor an
            operator came for down the page.
          */}
          {groupFields(section.key, fields).map((group) => (
            <VStack key={group.key} gap={1}>
              {group.label === null ? null : (
                <>
                  <Text weight="medium" size="sm">
                    {group.label}
                  </Text>
                  {group.note === null ? null : (
                    <Text size="sm" color="secondary">
                      {group.note}
                    </Text>
                  )}
                </>
              )}
              <HStack gap={3} wrap="wrap" align="start">
                {group.fields.map((f) => (
                  <DialInput
                    key={f.key}
                    field={f}
                    toggleName={toggle === null ? null : toggle.key}
                    onChange={props.onChange}
                  />
                ))}
              </HStack>
            </VStack>
          ))}
        </VStack>
      )}
    </Collapsible>
  )
}

export function DialsPanel(props: {
  row: BookRow
  /** The page's prompt. See `save` — a LIVE retune is password-gated. */
  reauth: Reauth
  onClose: () => void
  onSaved: () => void
}): React.ReactElement {
  const { row } = props
  /**
   * THE DRAFT IS THE ROW'S OWN DIALS, not the resolved set.
   *
   * What the operator SEES is the preset folded with these (`planDialsView`),
   * but what is edited and saved is the book's own document — so a Save sends
   * the keys that changed and nothing else, and a dial left alone keeps
   * following the preset instead of being pinned to today's value forever.
   */
  const [draft, setDraft] = useState<Record<string, DialValue>>({ ...row.dials })
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)

  const view = planDialsView(row.variant, draft)
  const patch = dialsPatch(row.dials, draft)
  const changed = Object.keys(patch)

  const set = (key: string, value: DialValue): void => {
    setNote(null)
    setDraft((cur) => ({ ...cur, [key]: value }))
  }

  /**
   * PREFILL FROM ANOTHER PRESET — the dials only.
   *
   * It cannot re-label the book: `variant` is immutable after creation
   * (`validateBookDialsPatch` refuses it), because re-pointing a book that may
   * hold a position at another playbook is a new book, not an edit. So this
   * copies the numbers in and the row goes on being compared against its own
   * preset — which is honest, and is why the button says "copy".
   */
  const prefill = (key: string): void => {
    const dials = presetDials(key)
    if (dials === null) return
    setNote(null)
    setDraft((cur) => ({ ...cur, ...dials }))
  }

  async function save(): Promise<void> {
    if (changed.length === 0) {
      setNote({ ok: false, text: 'nothing has changed — there is nothing to save' })
      return
    }
    setBusy(true)
    setNote(null)
    /**
     * A LIVE RETUNE ASKS FOR THE PASSWORD FIRST.
     *
     * These dials are pushed into the running live worker before its next tick,
     * so they decide how big the orders it places are and where the structure
     * sits — the same class of act as arming a live strategy, which has cost the
     * password since spec §5. `promptFirst` mirrors the SERVER's condition
     * exactly (`routes/books.ts` gates on `mode === 'live'`); prompting more
     * widely would teach an operator to click through the dialog that matters.
     * Paper is untouched: nothing there can move money.
     */
    await withReauth({
      statement:
        `Retune ${row.tag} on the LIVE rail. The running book picks these dials up at its next ` +
        `5-minute mark and sizes real orders by them.`,
      promptFirst: row.mode === 'live',
      run: (password) => api.bookRegistry.patchDials(row.tag, row.mode, patch, password),
      reauth: props.reauth,
      onDone: () => {
        setNote({
          ok: true,
          text: `saved ${changed.join(', ')} — a running book picks this up at its next mark`,
        })
        props.onSaved()
      },
      onError: (message) => setNote({ ok: false, text: message }),
    })
    setBusy(false)
  }

  return (
    <Card>
      <VStack gap={2} padding={3}>
        <HStack justify="between" align="center" wrap="wrap">
          <Heading level={3}>{`Dials · ${row.tag}`}</Heading>
          <HStack gap={2} align="center">
            <Text size="sm" color="secondary">{`preset ${row.variant}`}</Text>
            <Button variant="ghost" size="sm" label="Close" onClick={props.onClose} />
          </HStack>
        </HStack>

        {/*
          THE ONE THING THIS PANEL CANNOT CHECK. The API stores dials verbatim;
          which of them a RUNNING book re-reads is the engine's business, and
          the ones it snapshots at boot save cleanly here and then do nothing.
          Saying so is the only honest option while that list is not served.
        */}
        <Text size="sm" color="secondary">
          Saves as a MERGE of the fields you changed — everything else on the book is left
          exactly as it is, and a field left alone goes on following the preset. Most dials
          take effect at the book&apos;s next mark; the ones read once when the book starts
          save but change nothing until a restart.
        </Text>

        {view.presetKnown ? null : (
          <Banner
            status="warning"
            title={`No preset named '${row.variant}' ships with this engine`}
            description={
              'Every field below is compared against the ENGINE DEFAULTS instead, so ' +
              '"changed" on this book means "differs from the default", not "differs from ' +
              'the preset it was built from".'
            }
          />
        )}

        {/*
          F-29, ON SCREEN. These entries are in the row and the engine refuses
          them — a retired dial, a typo, a value of the wrong type. Warning
          rather than error: the book runs, it simply is not running THIS.
        */}
        {view.unknown.length === 0 ? null : (
          <Banner
            status="warning"
            title="Stored on this book, and not read by the engine"
            description={view.unknown
              .map((u) => `${u.key} = ${show(u.value)} — ${u.reason}`)
              .join(' · ')}
          />
        )}

        <HStack gap={2} align="end" wrap="wrap">
          <Selector
            label="Copy another preset's dials in"
            options={PRESETS.map((p) => ({ value: p.key, label: p.label }))}
            value=""
            placeholder="Choose a preset…"
            onChange={prefill}
            width={320}
          />
          <Text size="sm" color="secondary">
            Fills the fields; it does not re-label the book. Nothing is saved until you press
            Save.
          </Text>
        </HStack>

        <VStack gap={1}>
          {view.sections.map((s) => (
            <DialsSection key={s.section.key} view={s} onChange={set} />
          ))}
        </VStack>

        <HStack gap={1} align="center" wrap="wrap">
          <Button
            label={busy ? 'Saving…' : changed.length === 0 ? 'Save' : `Save ${changed.length} change(s)`}
            onClick={() => void save()}
            isDisabled={busy || changed.length === 0}
          />
          <Button
            variant="secondary"
            label="Reset"
            onClick={() => { setDraft({ ...row.dials }); setNote(null) }}
            isDisabled={busy}
          />
          {changed.length === 0 ? null : (
            <Text size="sm" color="secondary">{`will send: ${changed.join(', ')}`}</Text>
          )}
        </HStack>

        {note !== null ? (
          <Banner
            status={note.ok ? 'success' : 'error'}
            title={note.ok ? 'Dials saved' : 'Not saved'}
            description={note.text}
          />
        ) : null}
      </VStack>
    </Card>
  )
}
