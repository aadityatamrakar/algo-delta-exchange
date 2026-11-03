# Ticket 17 (plan Task 19) — Dials panel: sections, toggles, presets, Protect

**Branch:** `worktree-agent-a73002bd804d4b980` (worktree, branched from `recenter-migration`)
**Commit:** `f8c38841` — *feat(web): the dials modal is sections and toggles with presets; legs can be protected by quantity*

---

## 1. What shipped

### 1.1 `DIAL_SECTIONS` — the schema, grouped, in the engine
`packages/desk-engine/src/dials.ts` gains `DialSection` + `DIAL_SECTIONS`: fourteen
sections in spec §5's order, each `{ key, label, toggle?, fields, collapsed? }`.

- `toggle` is only ever one of the four dials that really is a master switch
  (`shift_enabled`, `unwind_enabled`, `trend_enabled`, `balance_enabled` — the file
  header already named them). Sections whose off-state is a NUMBER — Recycle
  (`recycle_frac` 0), EOD (`eod_flat_min` 0), Anchor (`anchor_ema_marks` 0) —
  deliberately carry **no** toggle: inventing a boolean for them would be a second
  spelling of "off", the exact ambiguity the typed schema retires.
- `collapsed?: true` is the one addition to the brief's shape, and it is load-bearing:
  spec §5/§11 require Advanced to render collapsed, and the alternative was the panel
  hard-coding which section key is "advanced" — i.e. schema knowledge back in the web app.
- Unwind is a toggle with an **empty** `fields` array, because `unwind_share` /
  `unwind_entry_book` are engine constants now (§5 "Deleted Python semantics").
- The suite proves the partition: every dial in `DEFAULT_DIALS` appears in exactly one
  section, as a toggle or a field; every toggle is a boolean; section keys are unique.
  **A dial added to the schema and forgotten in the table now fails a test** rather than
  becoming a knob the operator cannot see.

**No dial default was touched.** The schema is frozen; this is metadata only.

### 1.2 Two leaf export paths, so the browser does not import the engine
`packages/desk-engine/package.json` gains `"./dials"` and `"./presets"` beside `"."`.
`dials.ts` imports nothing and `presets.ts` imports one *type* from it, so
`apps/web` gets the metadata table and the twelve dial-sets without dragging
`marking`/`shed`/`shift`/`@algomaker/greeks` into the bundle. Measured: **+3 KB**
(1,139.82 → 1,142.91 KB). Every server-side consumer keeps importing `"."`.
`apps/web/package.json` declares `@algomaker/desk-engine` (lockfile synced).

### 1.3 `apps/web/src/dials-plan.ts` — the pure logic (node-tested)
`planDialsView(preset, overrides) -> { preset, presetKnown, sections, unknown }`.
Each field row is `{ key, value, presetValue, overridden, inert, kind }`.

- **`overridden` is measured on the VALUE**, not on the key's presence: a stored `0.02`
  beside a preset that says `0.02` differs from nothing, and flagging it would make the
  indicator noise within a week. `presetValue` rides along so the panel can print what
  the field was changed *from* — "changed" with nothing to compare to is half a badge.
- **Two folds, not one, and the difference is load-bearing.** `resolveDials` always folds
  onto `DEFAULT_DIALS` (the relief-r live set), so resolving preset+overrides in ONE call
  would show a *refused* dial at the ENGINE default rather than at the preset's own value
  — a `recenter-r` book with a hand-broken `shift_enabled` would read "shift on" when what
  it will actually run is the preset's "shift off". The preset is resolved first to make
  the baseline; the overrides are folded onto that, with `resolveDials` still the only
  judge of which are acceptable (no second copy of the type rules).
- **F-29:** every refused entry comes out as an error row, in the document's own key
  order, with a reason distinguishable from the key and value (`not a dial` / `must be a
  boolean` / `must be a finite number`).
- `dialsPatch(stored, draft)` returns only what CHANGED — never a `null` for a deleted
  key, because `patchBookDials` cannot unset one.

**Deviation from the brief's signature, deliberate:** the brief says `planDialsView`
produces an `Array<{section, fields}>`. It returns an object `{ sections, unknown,
presetKnown, preset }` instead — the F-29 error rows belong to no section, and an array
has nowhere to hang them; suppressing them was the one thing the ticket forbids. Each
element of `sections` is exactly the brief's `{ section, fields }` plus `toggle`.

### 1.4 `apps/web/src/dials-panel.tsx` — replaces `DialsPanel` in `books.tsx`
Renders from `DIAL_SECTIONS` (no field list in web): a `Collapsible` per section
(Advanced/Balance open shut), the master switch *inside* the section rather than in the
trigger (a switch inside a button is not keyboard-operable), a `Switch` for booleans and
a `NumberInput` for numbers — so the JSON box's "boolean typed as a number" class of
mistake is now unrepresentable. Per-field description says `preset default` or
`changed from the preset's X`, prefixed with `inert — <toggle> is off.` where it applies.
Inert fields stay **editable** on purpose: setting a value before turning the tier on is
the sane order to work in.

- The **live re-auth flow is carried over verbatim** (statement text, `promptFirst: row.mode === 'live'`, `withReauth`, the same `onDone`/`onError` shape); only the payload changed
  from "the whole parsed blob" to the diff.
- Save is disabled until something changes, and the button names the count and lists the
  keys it will send.
- A preset picker prefills fields ("copy another preset's dials in"). It cannot re-label
  the book — `variant` is immutable after creation and the endpoint refuses it — and the
  copy says so in words rather than pretending.
- Unknown-preset and F-29 rows render as `warning` banners, not `error`: the book is
  running, it simply is not running *that*.

`books.tsx` drops its `GET /v1/desk/variants` poll entirely — the panel no longer needs a
published catalogue for defaults, and that publication is being retired (§5).

### 1.5 Preset picker on create (`book-build.tsx`)
The Variant selector (published catalogue, with a text-box fallback for when the read
failed) becomes a **Preset** selector fed by `PRESETS`. Registration writes
`variant: <presetKey>` as the label and **the preset's whole dial-set** on the row, with
`lot_size` and the two on-screen boxes (`target_pnl`, `margin_cap`) folded in last so what
the operator typed wins.

> A row carrying only the three boxes would resolve every other dial against
> `DEFAULT_DIALS` — the relief-r LIVE set — so a book created as `recenter-r` would run
> relief's margin-gated shift and nothing would ever say so. That is now a test.

`lot_size` is still written: it is not an engine dial, but the Python supervisor reads it
until the cutover (Tasks 20/22). The panel surfaces it honestly as stored-but-unread.

### 1.6 Protect (spec §4, D12)
- `POST/GET /v1/desk/engine/protect` in `apps/api/src/routes/engine.ts`
  (path constant beside `ENGINE_DECISIONS_PATH` in the engine contract).
- Writes through `apps/supervisor/src/state-store.ts`'s `StateStore` — cross-app src
  import, the same seam `state-store.ts` already uses in the other direction for
  `../../api/src/errors.ts`. **load → merge → CAS save → retry ONCE with a fresh read →
  409.** A blind `$set` on the one field would be silently overwritten by a supervisor
  that had already read the state and was about to write its own version back.
- Quantity **per instrument**, in **LOTS**, `0` deletes the key.
- Live costs the password (same gate, same order — request validated *before* the prompt),
  written to `desk-audit` with `before`/`after`, and refused for a tag with no registry row.
- `apps/web/src/protect.tsx` is the dialog (converts contracts→lots and shows its working,
  warns on a claim larger than the position, and states plainly that protection is exempt
  at *selection* only — greeks/MTM/margin still count it, and the terminal exits ignore it).
- The positions table gains a `Protected` column with the claim as a badge and a
  Protect/Change button. **The map is checked against the book on screen** before it paints:
  the page is not remounted between tabs and `usePoll` keeps its last payload, so without
  that check a book sharing a contract with the previous one would show the other book's
  claim for up to 30s.
- `PositionRow` gains `lotSize` (a property of the contract, like `delta`) so the dialog
  never guesses the divisor.

### 1.7 Carried finding — `STATUS_RANK`
Added `HALTED: 6` and `REJECTED: 7`.

**Honest correction to the finding's wording.** The rank is only consulted when *no*
event on the order is `ok: false`, and both gateway halt paths journal `ok: false` — so
today a halted order usually renders from the `failure` branch, not the rank. The entry
is still right and the ordering the finding asked for ("above PARTIAL, below REJECTED")
is only *literally* satisfiable once REJECTED is in the table, which is why both went in:
with HALTED at 4.5 the described symptom would survive, because a halted order's filled
tranche journals `COMPLETE` (rank 5) and would still win. Two tests pin it.

**Adjacent defect found, NOT fixed (out of scope — gateway, ticket 13's ground):**
`apps/order-gateway/src/main.ts:665` (`refuseSlice`) journals its halt with `phase:
'FAILED'` and an `error` but **no `status`**, so `groupOrders` falls back to
`failure.status ?? 'REJECTED'` and the collapsed row reads **REJECTED** for an order that
was halted with fills. One line (`status: 'HALTED'`) would close it.

---

## 2. Server change that was necessary, and was not in the brief

`validateDialsAgainstCatalogue` (`apps/api/src/books-registry.ts`) refused any dial key
not in `catalogue defaults ∪ row dials`. A book built from a preset carries only that
preset's dials and the Python catalogue is being retired — so **every field the preset
omits would have been un-savable from the new panel** (`confirm_ms`, `cooldown_s`,
`work_tranche_lots`, …), and after Task 20 nothing would be savable at all. The known set
is now seeded with `DEFAULT_DIALS` first, then catalogue, then row — so the row and the
catalogue still win the *type* check (a live book running a knob as a number keeps running
it as a number), and a typo is still refused by all three.

One existing test asserted the unpublished-catalogue refusal using `target_pnl`, which is
a real dial; it now uses `unwind_share` (a Python dial the port deleted) so the sentence
is still exercised. Three tests added around the new behaviour.

---

## 3. Tests

| Suite | Result |
|---|---|
| `packages/desk-engine/test/dials.test.ts` (+3 section tests) | 11 pass |
| `apps/web/test/dials-plan.test.ts` (new, node:test, 15 tests) | 15 pass |
| `apps/web/test/dials-panel.test.tsx` (new, vitest, 13 tests) | 13 pass |
| `apps/web/test/positions.test.tsx` (+6 Protect tests) | 64 pass |
| `apps/api/test/engine-protect.test.ts` (new, real Mongo, 17 tests) | 17 pass |
| `apps/web` full suite | **542 pass / 30 files** |
| `npm run test:node` (whole repo) | 3,189 pass, **1 pre-existing failure** |
| `npm run typecheck` (both projects) | clean |
| `npm run build --workspace @algomaker/web` | clean |

**Pre-existing failure, not mine:** `apps/api/test/service.integration.test.ts` — "a
PARTIALLY marked book names only the missing legs". Verified by `git stash` → the failure
reproduces on the untouched branch head.

TDD was followed on `dials-plan` (test file written and run RED — module missing — before
the implementation).

---

## 4. Known gaps / follow-ups

1. **The CAS retry path has no test.** Forcing a lost race between the route's `load` and
   `save` needs a hook the route does not have. The single-write and version-advance
   properties are covered; the retry and the 409 are reasoned, not proven.
2. **The panel's draft is seeded on mount** (as the JSON box was). If the supervisor or
   another operator changes a dial while the panel is open, the draft's older value shows
   as a pending change and would be re-sent on Save. It is visible — the button lists the
   keys it will send — but it is not detected. Same hazard the old box carried.
3. `book-create.tsx` (the unreachable legacy wizard) still reads `api.variants()`. Left
   alone; Task 20 owns the removals.
4. `dials.lot_size` is still written on create and now renders as an F-29 warning row on
   every book. Correct for the TS engine, and it will read as noise until Task 20 drops
   the Python reader. Deliberate, and stated in the panel's wording ("stored, and not read
   by the engine").
5. The panel's "copy another preset's dials in" selector has no vitest coverage (the plan
   function behind it does).
6. Two unrelated `package-lock.json` corrections came along with `npm install` in the
   worktree: `apps/api` → `@algomaker/desk-engine`, `apps/order-gateway` → `@algomaker/bus`
   were declared in their `package.json` but missing from the lock. Left in — the lock now
   matches the manifests.

---

## 5. Files

**Created:** `apps/web/src/dials-plan.ts`, `apps/web/src/dials-panel.tsx`,
`apps/web/src/protect.tsx`, `apps/web/test/dials-plan.test.ts`,
`apps/web/test/dials-panel.test.tsx`, `apps/api/test/engine-protect.test.ts`

**Modified:** `packages/desk-engine/src/dials.ts`, `packages/desk-engine/src/contract.ts`,
`packages/desk-engine/package.json`, `packages/desk-engine/test/dials.test.ts`,
`apps/api/src/routes/engine.ts`, `apps/api/src/books-registry.ts`, `apps/api/src/main.ts`,
`apps/api/test/books-registry.test.ts`, `apps/api/test/engine-decisions.test.ts`,
`apps/web/src/books.tsx`, `apps/web/src/book-build.tsx`, `apps/web/src/pages.tsx`,
`apps/web/src/positions.ts`, `apps/web/src/api.ts`, `apps/web/package.json`,
`apps/web/test/{books,book-build,positions,orders}.test.tsx`, `package-lock.json`
