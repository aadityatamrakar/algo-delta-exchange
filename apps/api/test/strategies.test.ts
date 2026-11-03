/**
 * The strategy switch, tested where it is decided: in pure functions.
 *
 * The gate takes a row, a mode and returns a verdict, so every case that
 * matters — off blocks an exit, one mode off while the other is on, unknown is
 * refused, a half-written row does not read as a permission — is expressible
 * without a database. The integration file covers what only Mongo can answer
 * (that the refusal is journalled, and that the two switches are independent).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyStrategyPatch,
  blockedEvents,
  DAILY_LIMIT_MAX,
  validateDailyLimits,
  blockedSkips,
  DEFAULT_STRATEGY,
  gateStrategy,
  strategyFromDoc,
  validateBulkSwitch,
  validateStrategyCreate,
  validateStrategyPatch,
  isAdded,
  isOn,
  type StrategyModes,
  type StrategyRow,
} from '../src/strategies.ts'
import type { DeskAction } from '../src/contract.ts'
import { DX } from '../src/venue.ts'

const row = (over: Partial<StrategyRow> = {}): StrategyRow => ({
  ...DEFAULT_STRATEGY,
  tag: 'DESK_BHEL',
  label: 'BHEL short strangle',
  modes: { paper: { enabled: true } },
  ...over,
})

const OPEN: DeskAction = { op: 'open', ts: 'CE420#0', strike: 420, type: 'CE', side: 'Sell', qty: 13125 }
const CLOSE: DeskAction = { op: 'close', ts: 'CE420#0' }
const ROLL: DeskAction = { op: 'roll', ts: 'CE420#0', to_ts: 'CE430#0', to_strike: 430 }
const SHRINK: DeskAction = { op: 'resize', ts: 'CE420#0', qty: 2625 }

// -------------------------------------------------------------- the gate

test('a row switched ON for the mode passes and carries its row through', () => {
  const g = gateStrategy('DESK_BHEL', row(), 'paper')
  assert.equal(g.allowed, true)
  assert.equal(g.allowed === true ? g.row.tag : '', 'DESK_BHEL')
})

test('the two modes are gated INDEPENDENTLY', () => {
  // The whole point of the change: a strategy proving out on paper while live
  // is off, and — the case the operator asked for — one row running on both.
  const paperOnly = row({ modes: { paper: { enabled: true } } })
  assert.equal(gateStrategy('T', paperOnly, 'paper').allowed, true)
  assert.equal(gateStrategy('T', paperOnly, 'live').allowed, false)

  const liveOnly = row({ modes: { live: { enabled: true } } })
  assert.equal(gateStrategy('T', liveOnly, 'paper').allowed, false)
  assert.equal(gateStrategy('T', liveOnly, 'live').allowed, true)

  const both = row({ modes: { paper: { enabled: true }, live: { enabled: true } } })
  assert.equal(gateStrategy('T', both, 'paper').allowed, true)
  assert.equal(gateStrategy('T', both, 'live').allowed, true)

  // THREE STATES, not two. Added-and-off and not-added-at-all both refuse, and
  // they refuse with DIFFERENT reasons, because the fixes differ: one is a
  // toggle on the page in front of you, the other means it is not on that page.
  const addedButOff = row({ modes: { paper: { enabled: false } } })
  const offPaper = gateStrategy('T', addedButOff, 'paper')
  assert.equal(offPaper.allowed, false)
  assert.match(offPaper.allowed === false ? offPaper.reason : '', /is switched off for paper/)

  const notAdded = gateStrategy('T', addedButOff, 'live')
  assert.equal(notAdded.allowed, false)
  assert.match(notAdded.allowed === false ? notAdded.reason : '', /is not added to live/)

  const nowhere = row({ modes: {} })
  assert.equal(gateStrategy('T', nowhere, 'paper').allowed, false)
  assert.equal(gateStrategy('T', nowhere, 'live').allowed, false)
})

test('a switched-off mode blocks EVERY op — including the exits', () => {
  // The DECISION path's behavior, unchanged: it never passes the reduce-only
  // option, so a switched-off desk book skips everything, closes and rolls
  // included — the Python desk waits a switch out rather than trading through
  // it, and nothing there retries an exit into this gate.
  const g = gateStrategy('DESK_BHEL', row({ modes: { paper: { enabled: false } } }), 'paper')
  assert.equal(g.allowed, false)
  const skips = blockedSkips([OPEN, CLOSE, ROLL, SHRINK], g.allowed ? '' : g.reason)
  assert.equal(skips.length, 4, 'all four, not just the ones that add exposure')
  assert.ok(skips.every((s) => /is switched off/.test(s.reason)))
  assert.deepEqual(skips.map((s) => s.action.op), ['open', 'close', 'roll', 'resize'])
})

test('a REDUCE-ONLY submit passes a switched-off row — the 2026-08-04 stranded-flatten fix', () => {
  // The runner flattens ON switch-off (`runner.ts:#stopOne`), so the gate
  // refusing `reducesExposure` orders refused the very flatten the switch had
  // ordered: four paper strategies sat in `failed` for hours with their legs
  // stranded. Same asymmetry as the kill switch now — OFF stops new exposure,
  // it never traps what is already held.
  const off = row({ modes: { paper: { enabled: false } } })
  const g = gateStrategy('DESK_BHEL', off, 'paper', { reducesExposure: true })
  assert.equal(g.allowed, true)
  assert.equal(g.allowed === true ? g.row.tag : '', 'DESK_BHEL')

  // Explicit false and absent both keep the old verdict — only a caller that
  // CLAIMS the exemption gets it.
  assert.equal(gateStrategy('DESK_BHEL', off, 'paper', { reducesExposure: false }).allowed, false)
  assert.equal(gateStrategy('DESK_BHEL', off, 'paper', {}).allowed, false)
})

test('the reduce-only exemption opens ONLY the switched-off branch', () => {
  // "Never added" has no positions a legitimate exit could be closing, and an
  // unregistered tag has no switch an operator could ever have used — both
  // keep refusing everything, the exemption claimed or not.
  const notAdded = row({ modes: { paper: { enabled: false } } })
  const g = gateStrategy('T', notAdded, 'live', { reducesExposure: true })
  assert.equal(g.allowed, false)
  assert.match(g.allowed === false ? g.reason : '', /is not added to live/)

  const unknown = gateStrategy('T', null, 'paper', { reducesExposure: true })
  assert.equal(unknown.allowed, false)
  assert.equal(unknown.allowed === false ? unknown.registered : true, false)
})

test('a live exit is blocked while the same row keeps trading paper', () => {
  // The asymmetry, per mode. Turning live off does not become a licence to keep
  // closing live legs, and it does not touch the paper run either.
  const r = row({ modes: { paper: { enabled: true } } })
  const live = gateStrategy('T', r, 'live')
  assert.equal(live.allowed, false)
  assert.equal(blockedSkips([CLOSE], live.allowed ? '' : live.reason).length, 1)
  assert.equal(gateStrategy('T', r, 'paper').allowed, true)
})

test('the refusal names the MODE and the tag, and carries the operator note', () => {
  const bare = gateStrategy('DESK_BHEL', row({ modes: { live: { enabled: false } } }), 'live')
  assert.equal(
    bare.allowed === false ? bare.reason : '',
    'strategy DESK_BHEL is switched off for live',
    'a refusal that did not say which switch it read would send an operator hunting',
  )

  const noted = gateStrategy(
    'DESK_BHEL',
    row({ modes: { paper: { enabled: false } }, disabledReason: 'margin call' }),
    'paper',
  )
  assert.equal(
    noted.allowed === false ? noted.reason : '',
    'strategy DESK_BHEL is switched off for paper (margin call)',
  )
})

test('a whitespace-only disabledReason does not produce empty brackets', () => {
  const g = gateStrategy(
    'DESK_BHEL',
    row({ modes: { paper: { enabled: false } }, disabledReason: '   ' }),
    'paper',
  )
  assert.equal(g.allowed === false ? g.reason : '', 'strategy DESK_BHEL is switched off for paper')
})

test('an UNKNOWN tag is REJECTED, never implicitly allowed', () => {
  // A typo'd tag has no row and therefore no switch in the portal. Allowing it
  // would put real orders on the wire under a name nobody configured.
  for (const mode of ['paper', 'live'] as const) {
    const g = gateStrategy('DESK_BHELL', null, mode)
    assert.equal(g.allowed, false)
    assert.equal(g.allowed === false ? g.registered : true, false)
    assert.match(g.allowed === false ? g.reason : '', /DESK_BHELL is not registered/)
  }
})

test('a switched-off tag is distinguishable from an unregistered one', () => {
  // They demand different responses: one is a state to wait out, the other is a
  // misconfiguration only a human can fix.
  const off = gateStrategy('T', row({ modes: { paper: { enabled: false } } }), 'paper')
  const gone = gateStrategy('T', null, 'paper')
  assert.equal(off.allowed === false ? off.registered : null, true)
  assert.equal(gone.allowed === false ? gone.registered : null, false)
})

// ------------------------------------------------------- reading a row back

test('a row missing every switch reads as OFF, not as a permission', () => {
  // The dangerous default. A half-written row from a failed migration must fail
  // closed; every other field can be wrong without money moving. It lands on
  // the PAPER page (the old `mode` default) and switched off, which grants
  // nothing and is still findable by an operator.
  const r = strategyFromDoc({ tag: 'DESK_X' })
  assert.deepEqual(r?.modes, { paper: { enabled: false } })
  assert.equal(gateStrategy('DESK_X', r, 'paper').allowed, false)
  assert.equal(gateStrategy('DESK_X', r, 'live').allowed, false)
})

test('the OLD enabled+mode pair maps forward, in both directions', () => {
  // The old pair separates cleanly: `mode` was MEMBERSHIP (which page the row
  // was on) and `enabled` was PERMISSION. So exactly one key comes out, and it
  // is the one the row was already listed under.
  const cases: [Record<string, unknown>, StrategyModes][] = [
    [{ enabled: true, mode: 'paper' }, { paper: { enabled: true } }],
    [{ enabled: true, mode: 'live' }, { live: { enabled: true } }],
    [{ enabled: false, mode: 'paper' }, { paper: { enabled: false } }],
    // Still on the LIVE page, still off — it must not silently move to paper,
    // or an operator looking for it where they left it would not find it.
    [{ enabled: false, mode: 'live' }, { live: { enabled: false } }],
    // An absent mode is paper, the safe read; an absent `enabled` is off.
    [{ enabled: true }, { paper: { enabled: true } }],
    [{ mode: 'live' }, { live: { enabled: false } }],
  ]
  for (const [doc, expected] of cases) {
    const r = strategyFromDoc({ tag: 'DESK_X', ...doc })
    assert.deepEqual(r?.modes, expected, JSON.stringify(doc))
    // Whatever the shape, an old row never grants what it did not grant before.
    assert.equal(isOn(r?.modes ?? {}, 'live'), doc['enabled'] === true && doc['mode'] === 'live')
  }
})

test('a new-shape `modes` document is read as written, and never merged with the old pair', () => {
  const r = strategyFromDoc({ tag: 'DESK_X', modes: { paper: { enabled: true }, live: { enabled: true } } })
  assert.deepEqual(r?.modes, { paper: { enabled: true }, live: { enabled: true } })

  // The case that matters: a row an operator has since switched live OFF, with
  // a stale legacy pair still sitting beside it. Anything that ORed the two
  // would resolve it back to live — which is the whole reason the old fields
  // are not kept as aliases.
  const stale = strategyFromDoc({
    tag: 'DESK_X',
    modes: { paper: { enabled: true } },
    enabled: true,
    mode: 'live',
  })
  assert.deepEqual(stale?.modes, { paper: { enabled: true } }, 'the new field wins outright')
  assert.equal(gateStrategy('DESK_X', stale, 'live').allowed, false)
})

test('a truthy-but-not-true switch is still OFF', () => {
  for (const v of ['true', 1, 'yes', {}]) {
    const legacy = strategyFromDoc({ tag: 'DESK_X', enabled: v })
    assert.deepEqual(legacy?.modes, { paper: { enabled: false } }, `enabled: ${String(v)}`)
    const modern = strategyFromDoc({ tag: 'DESK_X', modes: { paper: { enabled: v }, live: { enabled: v } } })
    assert.equal(isOn(modern?.modes ?? {}, 'paper'), false, `enabled: ${String(v)}`)
    assert.equal(isOn(modern?.modes ?? {}, 'live'), false, `enabled: ${String(v)}`)
  }
})

test('an unreadable mode ENTRY drops to NOT ADDED, the least granting state', () => {
  // A present-but-wrong value could mean anything; the only safe reading of it
  // is the one that grants nothing and claims no membership either.
  for (const bad of ['on', 42, true, null, []]) {
    const r = strategyFromDoc({ tag: 'DESK_X', modes: { live: bad, paper: { enabled: true } } })
    assert.deepEqual(r?.modes, { paper: { enabled: true } }, `modes.live: ${String(bad)}`)
  }
})

test('a non-object `modes` falls back to the legacy read, not to a permission', () => {
  for (const bad of ['on', 42, [], null]) {
    const r = strategyFromDoc({ tag: 'DESK_X', modes: bad, enabled: true, mode: 'live' })
    assert.deepEqual(r?.modes, { live: { enabled: true } }, `modes: ${String(bad)}`)
  }
  assert.deepEqual(strategyFromDoc({ tag: 'DESK_X', modes: 'on' })?.modes, {
    paper: { enabled: false },
  })
})

test('unreadable fields fall back to their safe values', () => {
  const r = strategyFromDoc({
    tag: 'DESK_X',
    kind: 'nonsense',
    mode: 'LIVE',
    enabled: true,
    liveLots: 'two',
    autostartAt: 914,
  })
  assert.equal(r?.kind, 'external')
  assert.deepEqual(r?.modes, { paper: { enabled: true } }, "'LIVE' is not 'live' — paper is safe")
  assert.equal(r?.liveLots, 0)
  assert.equal(r?.autostartAt, '')
  assert.equal(r?.label, 'DESK_X', 'the tag stands in for a missing label')
})

test('a document with no tag is not a strategy', () => {
  // It cannot be matched against any decision, so treating it as one would be
  // granting an anonymous permission.
  assert.equal(strategyFromDoc({ enabled: true }), null)
  assert.equal(
    strategyFromDoc({ tag: '', modes: { paper: { enabled: true }, live: { enabled: true } } }),
    null,
  )
  assert.equal(strategyFromDoc(null), null)
})

// ------------------------------------------------------------- the journal

test('a blocked decision produces one journal row per action', () => {
  const events = blockedEvents({
    tag: 'DESK_BHEL',
    symbol: 'BHEL',
    decisionId: 'd-1',
    actions: [OPEN, CLOSE],
    reason: 'strategy DESK_BHEL is switched off for paper',
    nowMs: 1234,
    mode: 'paper',
  })
  assert.equal(events.length, 2)
  assert.equal(events[0]?.['clientOrderId'], 'd-1#0', 'same id a routed order would have carried')
  assert.equal(events[1]?.['clientOrderId'], 'd-1#1')
  assert.equal(events[0]?.['ok'], false, 'the portal filters the feed on ok:false')
  assert.equal(events[0]?.['tag'], 'DESK_BHEL')
  assert.equal(events[0]?.['error'], 'strategy DESK_BHEL is switched off for paper')
  assert.equal(events[0]?.['ts'], 1234)
})

test('the journal records the UNDERLYING, never the desk leg tag, as the symbol', () => {
  // `CE420#0` is a Python leg id, not an exchange symbol (contract.ts). Nothing
  // resolved a contract here, so claiming one in that column would be a lie.
  const [e] = blockedEvents({
    tag: 'T', symbol: 'BHEL', decisionId: 'd', actions: [OPEN], reason: 'r', nowMs: 0,
    mode: 'paper',
  })
  assert.equal(e?.['tradingsymbol'], 'BHEL')
  // `mode` rides along so the order log can scope this row to the rail that
  // refused it — an unstamped row reads as LIVE and would vanish from paper.
  assert.deepEqual(e?.['detail'], { mode: 'paper', op: 'open', deskTag: 'CE420#0', decisionId: 'd' })
})

test('a decision with no actions journals nothing', () => {
  assert.deepEqual(blockedEvents({
    tag: 'T', symbol: 'BHEL', decisionId: 'd', actions: [], reason: 'r', nowMs: 0, mode: 'live',
  }), [])
})

// --------------------------------------------------------------- patching

test('a patch changes only the fields it names', () => {
  const before = row({
    modes: { paper: { enabled: true }, live: { enabled: true } },
    liveLots: 3,
    autostartAt: '0914',
    updatedAt: 1,
  })
  const after = applyStrategyPatch(before, { liveLots: 5 }, 99)
  assert.equal(after.liveLots, 5)
  assert.deepEqual(after.modes, { paper: { enabled: true }, live: { enabled: true } })
  assert.equal(after.autostartAt, '0914')
  assert.equal(after.updatedAt, 99)
})

test('a patch of ONE mode leaves the other exactly as it was', () => {
  // An operator stopping live trading must not have to restate the paper
  // switch — the restatement is itself a way to flip it by accident.
  const both = row({ modes: { paper: { enabled: true }, live: { enabled: true } } })
  assert.deepEqual(applyStrategyPatch(both, { modes: { live: { enabled: false } } }, 1).modes, {
    paper: { enabled: true },
    live: { enabled: false },
  })
  assert.deepEqual(applyStrategyPatch(both, { modes: { paper: { enabled: false } } }, 1).modes, {
    paper: { enabled: false },
    live: { enabled: true },
  })
})

test('a patch NEVER adds a mode — a toggle cannot smuggle in membership', () => {
  // If it could, "add to live" would be reachable without the add form's own
  // checks (the runner-catalogue check especially). The route turns this no-op
  // into a 400 rather than a 200 that says nothing moved.
  const paperOnly = row({ modes: { paper: { enabled: true } } })
  const after = applyStrategyPatch(paperOnly, { modes: { live: { enabled: true } } }, 1)
  assert.deepEqual(after.modes, { paper: { enabled: true } })
  assert.equal(gateStrategy('T', after, 'live').allowed, false)
})

test('switching a mode off keeps its MEMBERSHIP — pausing is not removing', () => {
  // The whole reason membership and enablement are separate: with one boolean,
  // switching a strategy off would drop it out of the very table its switch
  // lives in, and the only way back would be to delete and re-add the row.
  const on = row({ modes: { paper: { enabled: true } } })
  const off = applyStrategyPatch(on, { modes: { paper: { enabled: false } } }, 1)
  assert.deepEqual(off.modes, { paper: { enabled: false } })
  assert.equal(isAdded(off.modes, 'paper'), true, 'still listed on the paper page')
  assert.equal(isOn(off.modes, 'paper'), false, 'and switched back on with one click')
})

test('switching ON in either mode CLEARS a stale disabled reason', () => {
  // A strategy trading somewhere while still labelled "disabled for margin" is
  // a worse lie than carrying no reason at all.
  const off = row({
    modes: { paper: { enabled: false }, live: { enabled: false } },
    disabledReason: 'margin call',
  })
  assert.equal(applyStrategyPatch(off, { modes: { paper: { enabled: true } } }, 1).disabledReason, '')
  assert.equal(applyStrategyPatch(off, { modes: { live: { enabled: true } } }, 1).disabledReason, '')
})

test('a reason STATED in the patch survives even while the other rail keeps running', () => {
  // One reason field, two switches. An operator taking paper off a row that is
  // still live has nowhere else to write why, and dropping it because live is
  // on would lose the only note anyone ever sees.
  const both = row({ modes: { paper: { enabled: true }, live: { enabled: true } } })
  const patched = applyStrategyPatch(
    both,
    { modes: { paper: { enabled: false } }, disabledReason: 'misfiring on gap days' },
    1,
  )
  assert.deepEqual(patched.modes, { paper: { enabled: false }, live: { enabled: true } })
  assert.equal(patched.disabledReason, 'misfiring on gap days')
  assert.match(
    (() => {
      const g = gateStrategy(patched.tag, patched, 'paper')
      return g.allowed ? '' : g.reason
    })(),
    /misfiring on gap days/,
  )
})

test('switching off keeps the reason it was given', () => {
  const on = row({ modes: { paper: { enabled: true } } })
  const off = applyStrategyPatch(
    on,
    { modes: { paper: { enabled: false } }, disabledReason: 'blew its stop' },
    1,
  )
  const g = gateStrategy(off.tag, off, 'paper')
  assert.equal(g.allowed, false)
  assert.match(g.allowed === false ? g.reason : '', /blew its stop/)
})

// -------------------------------------------------------------- validation

test('an EMPTY patch is rejected rather than treated as a no-op', () => {
  // An operator who meant to flip a switch and mistyped the field name must not
  // get a 200 back saying the strategy is still running.
  const r = validateStrategyPatch({})
  assert.equal(r.ok, false)
  assert.match(r.ok ? '' : r.error, /patch is empty/)
  assert.equal(validateStrategyPatch({ nope: true }).ok, false)
  assert.equal(validateStrategyPatch({ modes: {} }).ok, false, 'a modes with nothing in it is empty')
})

test('the OLD enabled/mode fields are REJECTED, not silently ignored', () => {
  // Quietly dropping them would 200 an edit that never moved the switch it
  // named — the worst possible answer to "did my change land?".
  for (const body of [{ enabled: true }, { mode: 'live' }, { enabled: false, liveLots: 2 }]) {
    const r = validateStrategyPatch(body)
    assert.equal(r.ok, false, JSON.stringify(body))
    assert.match(r.ok ? '' : r.error, /replaced by 'modes'/)
  }
})

test('modes values must be real booleans, not truthy strings', () => {
  assert.equal(validateStrategyPatch({ modes: { live: 'true' } }).ok, false)
  assert.equal(validateStrategyPatch({ modes: { paper: 1 } }).ok, false)
  assert.equal(validateStrategyPatch({ modes: 'live' }).ok, false)
  assert.equal(validateStrategyPatch({ modes: { live: { enabled: false } } }).ok, true)
})

test('liveLots must be a non-negative whole number of LOTS', () => {
  for (const lots of [-1, 1.5, Number.NaN, '2']) {
    assert.equal(validateStrategyPatch({ liveLots: lots }).ok, false, `liveLots ${String(lots)}`)
  }
  assert.equal(validateStrategyPatch({ liveLots: 0 }).ok, true, 'zero lots is a valid live config')
})

test("autostartAt must be IST 'HHmm' or empty", () => {
  for (const at of ['0914', '0000', '2359', '']) {
    assert.equal(validateStrategyPatch({ autostartAt: at }).ok, true, `autostartAt '${at}'`)
  }
  for (const at of ['9:14', '914', '2400', '0960', 914]) {
    assert.equal(validateStrategyPatch({ autostartAt: at }).ok, false, `autostartAt ${String(at)}`)
  }
})

test('a valid patch carries through exactly the fields given', () => {
  const r = validateStrategyPatch({ modes: { live: { enabled: true } }, liveLots: 2 })
  assert.equal(r.ok, true)
  assert.deepEqual(r.ok ? r.value : null, { modes: { live: { enabled: true } }, liveLots: 2 })
})

// ---------------------------------------------------------------- creation

test('a create body cannot ask for a row that is already switched on', () => {
  // Creating a row and granting it permission to trade are separate acts. A
  // form that did both would make a typo in a tag a live order.
  for (const body of [
    { tag: 'NEW_ONE', kind: 'hosted', mode: 'live', modes: { live: { enabled: true } } },
    { tag: 'NEW_ONE', kind: 'hosted', mode: 'live', enabled: true },
  ]) {
    const r = validateStrategyCreate(body)
    assert.equal(r.ok, false, JSON.stringify(body))
    assert.match(r.ok ? '' : r.error, /always added switched OFF/)
  }
  // And the page being added to is never guessed.
  assert.equal(validateStrategyCreate({ tag: 'NEW_ONE', kind: 'hosted' }).ok, false)
})

test('a create body needs a usable tag and a real kind', () => {
  assert.equal(validateStrategyCreate({ kind: 'hosted', mode: 'paper' }).ok, false)
  assert.equal(validateStrategyCreate({ tag: '  ', kind: 'hosted', mode: 'paper' }).ok, false)
  assert.equal(validateStrategyCreate({ tag: 'OK', kind: 'sideways', mode: 'paper' }).ok, false)
  // The tag is a key: it appears in order ids, journal rows and the
  // comma-separated DESK_LIVE_TAGS allowlist.
  for (const tag of ['has space', 'comma,tag', 'quote"tag']) {
    assert.equal(validateStrategyCreate({ tag, kind: 'external', mode: 'paper' }).ok, false, tag)
  }
})

test('a create body defaults the label to the tag and the switches to nothing', () => {
  const r = validateStrategyCreate({ tag: 'NEW_ONE', kind: 'external', mode: 'paper' })
  assert.equal(r.ok, true)
  assert.deepEqual(r.ok ? r.value : null, {
    tag: 'NEW_ONE',
    kind: 'external',
    mode: 'paper',
    label: 'NEW_ONE',
    autostartAt: '',
    liveLots: 0,
  })
})

// -------------------------------------------------------------- bulk switch

test('a bulk switch must state its mode and direction explicitly', () => {
  // No default in either field. Guessing paper silently fails to stop a live
  // book; guessing live is catastrophic; guessing `on` is unthinkable.
  assert.equal(validateBulkSwitch({ on: true }).ok, false)
  assert.equal(validateBulkSwitch({ mode: 'paper' }).ok, false)
  assert.equal(validateBulkSwitch({ mode: 'both', on: true }).ok, false)
  assert.equal(validateBulkSwitch({ mode: 'paper', on: 'yes' }).ok, false)
})

/**
 * THE PARSED VALUE, not a literal re-stated beside the call.
 *
 * This compared a hard-coded `{mode:'live', on:false}` against itself whenever
 * `.ok` was true, so the only thing it could ever fail on was the boolean. The
 * endpoint it guards arms or disarms EVERY strategy on a page at once — a
 * validator that returned the inversion (`on: true` for `on: false`, or the
 * other rail) would have passed this test while turning the whole live page on.
 */
test('a bulk switch is parsed to exactly what was asked for, never its inverse', () => {
  for (const body of [
    { mode: 'live', on: false },
    { mode: 'live', on: true },
    { mode: 'paper', on: false },
    { mode: 'paper', on: true },
  ] as const) {
    const r = validateBulkSwitch(body)
    assert.equal(r.ok, true, JSON.stringify(body))
    assert.deepEqual(r.ok ? r.value : null, { mode: body.mode, on: body.on }, JSON.stringify(body))
  }
})

// ---------------------------------------------------------------- day guard

test('daily limits are stated in the venue currency: USD on DX, rupees on NSE', () => {
  const dx = validateDailyLimits({ stop: -5 }, DX)
  assert.equal(dx.ok, false)
  if (!dx.ok) {
    assert.match(dx.error, /USD/)
    assert.doesNotMatch(dx.error, /rupee/)
  }
  const big = validateDailyLimits({ target: DAILY_LIMIT_MAX + 1 }, DX)
  if (!big.ok) assert.match(big.error, /\$10,000,000/)
  const nse = validateDailyLimits({ stop: -5 })
  if (!nse.ok) assert.match(nse.error, /rupees/)
  assert.equal(validateDailyLimits({ target: 250.5, stop: 100 }, DX).ok, true)
})

test('daily limits are POSITIVE rupees on both lines', () => {
  // A stop stated as -3000 is refused rather than negated: an operator who
  // typed the sign they see in the P&L is being reasonable, and a control that
  // silently reversed their meaning would arm a stop-loss to fire on a profit.
  assert.equal(validateDailyLimits({ stop: -3_000 }).ok, false)
  assert.equal(validateDailyLimits({ target: 0 }).ok, false)
  assert.equal(validateDailyLimits({ target: Number.NaN }).ok, false)
  assert.equal(validateDailyLimits({ stop: '3000' }).ok, false)
  assert.equal(validateDailyLimits({ target: DAILY_LIMIT_MAX + 1 }).ok, false)
  const ok = validateDailyLimits({ target: 10_000, stop: 3_000 })
  assert.deepEqual(ok.ok ? ok.value : null, { target: 10_000, stop: 3_000 })
})

test('daily limits are CLEARABLE, and every spelling of empty means unarmed', () => {
  for (const raw of [null, {}, { target: null }, { target: null, stop: null }]) {
    const r = validateDailyLimits(raw)
    assert.equal(r.ok, true, JSON.stringify(raw))
    assert.equal(r.ok ? r.value : 'x', null, JSON.stringify(raw))
  }
})

test('a PATCH may set and clear dailyLimits', () => {
  const set = validateStrategyPatch({ dailyLimits: { stop: 3_000 } })
  assert.deepEqual(set.ok ? set.value : null, { dailyLimits: { stop: 3_000 } })
  const cleared = validateStrategyPatch({ dailyLimits: null })
  assert.deepEqual(cleared.ok ? cleared.value : null, { dailyLimits: null })
})

test('a PATCH can NEVER write disabledByGuard', () => {
  // It is the only thing that distinguishes "the guard stopped this and it may
  // be re-armed at 08:45" from "the operator stopped this deliberately". A
  // client able to forge it could have tomorrow's re-arm undo a human's stop.
  const r = validateStrategyPatch({ disabledByGuard: { paper: { day: '2026-08-14', trigger: 'stop' } } })
  assert.equal(r.ok, false)
  assert.match(r.ok ? '' : r.error, /written by the day guard/)
})

test('a patch replaces the limits WHOLESALE — no half-merged pair', () => {
  const armed = row({ dailyLimits: { target: 10_000, stop: 3_000 } })
  const next = applyStrategyPatch(armed, { dailyLimits: { target: 20_000 } }, 5)
  assert.deepEqual(next.dailyLimits, { target: 20_000 })
  // Cleared means the KEY IS GONE, not present-and-undefined: Mongo would store
  // the latter as an explicit null and every reader would have to normalise it.
  const off = applyStrategyPatch(armed, { dailyLimits: null }, 6)
  assert.equal('dailyLimits' in off, false)
})

test('a patch that does not mention the limits leaves them exactly as they were', () => {
  const armed = row({ dailyLimits: { stop: 3_000 } })
  const next = applyStrategyPatch(armed, { liveLots: 4 }, 5)
  assert.deepEqual(next.dailyLimits, { stop: 3_000 })
})

test('the guard stamp is per RAIL, and one rail’s stamp never disturbs the other', () => {
  const stamped = applyStrategyPatch(
    row({ modes: { paper: { enabled: true }, live: { enabled: true } } }),
    { modes: { paper: { enabled: false } }, disabledByGuard: { paper: { day: '2026-08-14', trigger: 'stop' } } },
    5,
  )
  assert.deepEqual(stamped.disabledByGuard, { paper: { day: '2026-08-14', trigger: 'stop' } })

  const both = applyStrategyPatch(
    stamped,
    { modes: { live: { enabled: false } }, disabledByGuard: { live: { day: '2026-08-14', trigger: 'target' } } },
    6,
  )
  assert.deepEqual(both.disabledByGuard, {
    paper: { day: '2026-08-14', trigger: 'stop' },
    live: { day: '2026-08-14', trigger: 'target' },
  })
})

test('switching a rail back ON clears that rail’s stamp — and only that one', () => {
  // The stamp means "the guard stopped this and it may be re-armed". A row a
  // human has just turned back on is neither, and a stale badge saying
  // "stopped for the day" over a trading strategy is the worst reading of it.
  const stopped = row({
    modes: { paper: { enabled: false }, live: { enabled: false } },
    disabledByGuard: {
      paper: { day: '2026-08-14', trigger: 'stop' },
      live: { day: '2026-08-14', trigger: 'stop' },
    },
  })
  const back = applyStrategyPatch(stopped, { modes: { paper: { enabled: true } } }, 5)
  assert.deepEqual(back.disabledByGuard, { live: { day: '2026-08-14', trigger: 'stop' } })

  const clean = applyStrategyPatch(back, { modes: { live: { enabled: true } } }, 6)
  assert.equal('disabledByGuard' in clean, false)
})

test('an unreadable stored limit falls to UNARMED, never to an invented number', () => {
  // There is no safe default here: a made-up target stops a strategy that did
  // nothing wrong, and a made-up stop claims a protection nobody configured.
  for (const bad of [{ stop: -1 }, { target: 'x' }, { target: 0 }, 'nope', null, { target: 1e12 }]) {
    const parsed = strategyFromDoc({ tag: 'T', modes: {}, dailyLimits: bad })
    assert.equal(parsed?.dailyLimits, undefined, JSON.stringify(bad))
  }
  const good = strategyFromDoc({ tag: 'T', modes: {}, dailyLimits: { target: 10_000, stop: -1 } })
  assert.deepEqual(good?.dailyLimits, { target: 10_000 }, 'the readable half survives')
})

test('a half-written guard stamp is not evidence of anything', () => {
  for (const bad of [{ paper: { day: '2026-08-14' } }, { paper: { trigger: 'stop' } }, { paper: 1 }]) {
    const parsed = strategyFromDoc({ tag: 'T', modes: {}, disabledByGuard: bad })
    assert.equal(parsed?.disabledByGuard, undefined, JSON.stringify(bad))
  }
})
