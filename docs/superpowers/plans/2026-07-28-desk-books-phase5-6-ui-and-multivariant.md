# Desk Books Phases 5–6 — Books UI and Multi-Variant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create, configure, start, stop and watch a book from the dashboard — then prove it by running a second variant beside `hold-recycle-r` on BHEL paper.

**Architecture:** The dashboard already splits manage from monitor: `#/strategies` is the registry with switches, `#/positions/<symbol>` is the live view. A positional book is the positional sibling of a strategy row, so it takes the same split — a new `#/books` route for lifecycle, and the existing positions page re-keyed to tags. Phase 6 is not code: it is the A/B that proves phases 0–5 actually delivered independent books.

**Tech Stack:** React 19, Vite, TypeScript, the in-repo `astryx` component set. Hash routing via `apps/web/src/shell.tsx`.

## Global Constraints

- **`npm run typecheck` at the root SKIPS `apps/web`.** Run `npx tsc -p apps/web --noEmit` explicitly, every task, or type errors reach prod.
- **Follow `apps/web/src/strategies.tsx`'s patterns** — it is the closest existing analogue. Read it before writing the Books page.
- **All API calls go through the `api` object** (`apps/web/src/api.ts:844`). Do not call `fetch` from a component.
- **A created book starts stopped and switched off.** The UI must never create a book that is already a trading permission.
- **`#/positions/<tag>`** — `Location` in `shell.tsx:59-64` already carries both `symbol` and `tag`.
- **Depends on phases 0–4** being merged and deployed.
- Commit after every task.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `apps/web/src/api.ts` | Typed API client | **Modify.** Books registry, variants, chain; positions by tag |
| `apps/web/src/shell.tsx` | Routes and hash parsing | **Modify.** Add `books`; positions carries a tag |
| `apps/web/src/App.tsx` | Shell and nav | **Modify.** Mount the route |
| `apps/web/src/books.tsx` | The Books page: list, create, lifecycle | **Create** |
| `apps/web/src/book-create.tsx` | The create wizard | **Create** |
| `apps/web/src/pages.tsx` | Positions page | **Modify.** Key by tag; readiness checklist |

---

### Task 1: Re-key the dashboard's positions calls

**Files:**
- Modify: `apps/web/src/api.ts`, `apps/web/src/shell.tsx`, `apps/web/src/pages.tsx`, `apps/web/src/App.tsx`

**Interfaces:**
- Produces: `api.positions(tag: string, mode: DeskMode)`, `api.booksForSymbol(symbol: string, mode: DeskMode)`, `api.diff(tag, mode)`.

**Do this first.** Phase 0 changed `?symbol=` from "one book" to "an array of books", so **the dashboard is currently rendering wrongly** — it reads `.legs` off a `{books:[...]}` response. Everything else in this plan sits on top of a page that works.

- [ ] **Step 1: Confirm the breakage**

```bash
curl -s -H "Authorization: Bearer $DESK_API_TOKEN" \
  'http://127.0.0.1:8790/v1/desk/positions?symbol=BHEL&mode=paper' | jq 'keys'
```

Expected: `["books"]`, not `["legs","greeks",...]` — which is exactly what `PositionsPage` destructures.

- [ ] **Step 2: Update the client**

In `apps/web/src/api.ts`'s `api` object (`:844`), change the positions call to take a tag, and add a symbol-scoped list:

```ts
  positions: async (tag: string, mode: DeskMode): Promise<PositionsResponse> =>
    await getJson(`/v1/desk/positions?tag=${encodeURIComponent(tag)}&mode=${mode}`),

  /** Every book on a symbol. `symbol` is a FILTER now, not a key — a symbol can
   *  carry several variants at once, which is the whole point of the re-key. */
  booksForSymbol: async (symbol: string, mode: DeskMode): Promise<{ books: PositionsResponse[] }> =>
    await getJson(`/v1/desk/positions?symbol=${encodeURIComponent(symbol)}&mode=${mode}`),

  diff: async (tag: string, mode: DeskMode): Promise<BookDiff> =>
    await getJson(`/v1/desk/diff?tag=${encodeURIComponent(tag)}&mode=${mode}`),
```

Match the file's real request helper name (`getJson` here is indicative — read `:263-300`).

- [ ] **Step 3: Route by tag**

In `shell.tsx`, `parseHash` already extracts a second segment for `positions`. Route it to `tag` rather than `symbol`, and update `ROUTES` with the new entry:

```ts
  { id: 'books', label: 'Books', hash: '#/books' },
```

Add `'books'` to the `Route` union at `:29-31`.

- [ ] **Step 4: Update the positions page**

`PositionsPage` (`pages.tsx:106`) takes `symbol: string | null`; change it to `tag: string | null`. When `tag` is null, list every book for the mode via `api.books(mode)` and let the operator pick — a tab per book labelled `<symbol> · <variant>`, since a symbol alone no longer identifies one.

- [ ] **Step 5: Typecheck and verify in the browser**

```bash
npx tsc -p apps/web --noEmit
npm run dev -w @algomaker/web
```

Expected: no type errors; `#/positions` lists the BHEL book and `#/positions/BHEL-2026-08-25-hold-recycle-r` renders its 8 legs with greeks.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src
git commit -m "fix(web): read positions by tag, not symbol

Phase 0 made ?symbol= return an array; the page was destructuring it as
a single book and rendering empty."
```

---

### Task 2: The Books list page

**Files:**
- Create: `apps/web/src/books.tsx`
- Modify: `apps/web/src/api.ts`, `apps/web/src/App.tsx`

**Interfaces:**
- Consumes: `GET/POST /v1/desk/books/registry`, `/start`, `/stop` (phase 2).
- Produces: `export function BooksPage(props: { mode: DeskMode }): React.ReactElement`, and on `api`: `books.list/create/start/stop/patch`, `variants.list`.

- [ ] **Step 1: Add the client methods**

```ts
  bookRegistry: {
    list: async (mode: DeskMode): Promise<BookRow[]> =>
      await getJson(`/v1/desk/books/registry?mode=${mode}`),
    create: async (body: BookCreate): Promise<BookRow> =>
      await postJson('/v1/desk/books/registry', body),
    start: async (tag: string, mode: DeskMode): Promise<void> =>
      await postJson(`/v1/desk/books/registry/${encodeURIComponent(tag)}/start`, { mode }),
    stop: async (tag: string, mode: DeskMode): Promise<void> =>
      await postJson(`/v1/desk/books/registry/${encodeURIComponent(tag)}/stop`, { mode }),
  },
  variants: async (): Promise<VariantRow[]> => await getJson('/v1/desk/variants'),
```

- [ ] **Step 2: Write the page**

Create `apps/web/src/books.tsx`, following `strategies.tsx`'s table-and-switch shape. One row per book:

| Column | Source |
|---|---|
| Book | `tag`, with `symbol · expiry · variant` beneath |
| State | `desired` vs `actual` — **render the gap explicitly** |
| Net delta | `api.positions(tag, mode).greeks.netDelta` |
| P&L | the pnl endpoint, scoped by tag |
| Last mark | `lastMarkAt`, rendered with `ago()` (`api.ts:1159`) |
| Last decision | `lastDecision` — the `hold-recycle:` reason string |
| | Start/Stop |

**The `desired` ≠ `actual` gap is the most important cell on the page.** "Asked to run, not running" is the state an operator must never have to infer — render it as a distinct visual state, not as `actual` alone.

A book whose `lastMarkAt` is older than ~10 minutes during a session is stalled; say so on the row rather than showing a stale delta as if current.

**Expiry alarm** (spec §4.5): a book still carrying legs past its `expiry` gets a named alarm on its row — never silence.

- [ ] **Step 3: Mount it**

In `App.tsx`, add the `books` case to the route switch beside `strategies`.

- [ ] **Step 4: Typecheck and verify**

```bash
npx tsc -p apps/web --noEmit && npm run dev -w @algomaker/web
```

Expected: `#/books` lists the BHEL book, `stopped`/`stopped`, with its net delta and last decision. Stop and start it and watch `actual` follow `desired` within one supervisor poll.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/books.tsx apps/web/src/api.ts apps/web/src/App.tsx
git commit -m "feat(web): books page with the desired/actual gap made visible

'Asked to run, not running' is the state an operator must never infer."
```

---

### Task 3: The create wizard

**Files:**
- Create: `apps/web/src/book-create.tsx`
- Modify: `apps/web/src/books.tsx`

**Interfaces:** `export function BookCreate(props: { mode: DeskMode; onCreated: (tag: string) => void }): React.ReactElement`

Flow: symbol → expiry (from `/v1/desk/instruments/:underlying`) → variant (from `/v1/desk/variants`) → dials (pre-filled from the variant's `defaults`) → seed legs → review.

- [ ] **Step 1: Build the steps**

The variant step reads the **published catalogue**, never a hardcoded list — that is what keeps the dropdown equal to what the deployed Python can actually run. If the catalogue is empty, say *"no variants published — is the supervisor running?"* rather than rendering an empty select.

The dials step pre-fills `target_pnl` and `margin_cap` from the chosen variant's `defaults` and lets them be overridden.

- [ ] **Step 2: Validate the seed legs client-side**

Mirror `validate.ts:170-184` exactly, so an operator learns before the round trip:

```ts
function legError(leg: SeedLegInput, lotSize: number): string | null {
  if (!Number.isInteger(leg.qty) || leg.qty === 0) return 'qty must be a non-zero integer (short is negative)'
  if (Math.abs(leg.qty) % lotSize !== 0) return `qty must be a multiple of the lot size (${lotSize})`
  // Rate is the price actually PAID. Seeding at 0 silently erases the cost
  // basis, and every P&L number after it is wrong.
  if (!(leg.rate > 0)) return 'rate must be the positive entry price actually paid'
  return null
}
```

- [ ] **Step 3: The review step states the safety property**

Before the create button, say plainly: **the book will be created stopped and switched off.** Creating is not a trading permission; starting it is a separate act.

- [ ] **Step 4: Typecheck and verify**

```bash
npx tsc -p apps/web --noEmit
```

Create a second BHEL book through the wizard on the **shift** variant, seeded with the same 8 legs. Expected: it appears in `#/books` as `stopped`, and the existing `hold-recycle-r` book is untouched.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/book-create.tsx apps/web/src/books.tsx
git commit -m "feat(web): book create wizard driven by the published catalogue

The variant list is what the deployed Python can run, never a hardcoded
one. Seed legs are validated client-side against the same rules."
```

---

### Task 4: The monitor view and the live-readiness checklist

**Files:**
- Modify: `apps/web/src/pages.tsx`

**Interfaces:** `PositionsPage` gains the decision log and, in `live` mode, the §7.2 readiness checklist.

- [ ] **Step 1: Add the decision log**

Under the legs table, list recent decisions for the tag with their `reason` and any `skips`/`routeErrors`. `hold-recycle: spot +2.1% of anchor — outside ±2% corridor` is the line that tells an operator the mechanism is alive; a page that shows only positions cannot distinguish "working and holding" from "dead".

- [ ] **Step 2: Add the readiness checklist (live mode only)**

Three gates, each rendered as pass/fail with what to do (spec §7.2):

1. **API allowlist** — the tag in the API's `DESK_LIVE_TAGS`
2. **Gateway allowlist** — the tag in the **order-gateway's** `DESK_LIVE_TAGS`; a separate process, needing **its own restart**
3. **Registry row** — added and enabled for `live`

Gates 1 and 2 need a probe endpoint; add `GET /v1/desk/live-readiness?tag=` to `apps/api/src/routes/books.ts` returning `{apiAllowlisted, gatewayAllowlisted, registryEnabled}`. The gateway's answer comes from its health surface or from a journalled refusal — **do not infer it from the API's own env**, which is the mistake that made the original cutover procedure wrong.

- [ ] **Step 3: Typecheck and verify**

```bash
npx tsc -p apps/web --noEmit
```

Expected: in paper the checklist is absent; in live it renders three explicit gates.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/pages.tsx apps/api/src/routes/books.ts
git commit -m "feat(web): decision log and the live-readiness checklist

Three gates rendered explicitly, so 'why did nothing route' is answered
on the page. The gateway's allowlist is probed, not inferred."
```

---

### Task 5: Run the second variant

**Files:** none — this is a verification task.

**This is what the whole re-key was for.** If any step here needs a code change, phases 0–4 did not actually deliver independent books.

- [ ] **Step 1: Create and start the second book**

Through `#/books`, create `BHEL-2026-08-25-hold-recycle-shift-r` on the `hold-recycle-shift-r` variant, seeded with the same 8 legs at the same rates. Start it.

- [ ] **Step 2: Verify independence**

```bash
curl -s -H "Authorization: Bearer $DESK_API_TOKEN" \
  'http://127.0.0.1:8790/v1/desk/positions?symbol=BHEL&mode=paper' | jq '.books | length'
ls data/desk/
```

Expected: `2`; two distinct state files. Confirm in `#/books` that both show their own `lastDecision`, and that the feed subscribed **one** chain for both — `planSubscriptions` dedupes by symbol, so two books on BHEL must not double the token count.

- [ ] **Step 3: Verify the A/B is real**

After a corridor breach, the two books must diverge: `hold-recycle-r` sells at ATM±2 and holds every strike; `hold-recycle-shift-r` additionally steps each ITM/ATM short one strike further OTM (`playbooks.py`'s `shift_strikes: 1`). Confirm from the decision logs that they are making **different** decisions on the same marks — identical decisions mean the variant config is not reaching the engine.

- [ ] **Step 4: Record the outcome**

Append to `context/` a short note: which two variants ran, from when, and where their ledgers are (`data/desk/<tag>.*`). This is the first real A/B on live paper and the numbers only mean something if the setup is written down.

- [ ] **Step 5: Commit**

```bash
git add context/
git commit -m "docs: first live-paper A/B — hold-recycle-r vs -shift-r on BHEL"
```

---

## Phase exit condition

```bash
npx tsc -p apps/web --noEmit
npm test -w @algomaker/api
curl -s -H "Authorization: Bearer $DESK_API_TOKEN" 'http://127.0.0.1:8790/v1/desk/positions?symbol=BHEL&mode=paper' | jq '.books | length'
```

Expected: no type errors; suite green; `2`. And in the browser: a book created, started, stopped and watched without touching a shell.

## Self-review

**Spec coverage:** implements §5 (the whole frontend section — the manage/monitor split, the create flow, the two safety properties, the monitor view), §7.2's readiness checklist, §4.5's expiry alarm surface, and §8 phases 5–6.

**Ordering:** Task 1 must be first — the dashboard is broken from the moment phase 0 merges, and every later task builds on a page that renders. Task 5 must be last: it verifies the other four.

**Type consistency:** `api.positions` takes a **tag** everywhere after Task 1; any remaining `api.positions(symbol, ...)` call is a bug, and `npx tsc -p apps/web --noEmit` is what catches it — the root typecheck will not.

**Known gap:** the readiness checklist's gateway probe (Task 4 Step 2) needs a gateway-side surface that does not exist yet. If the gateway has no health endpoint exposing its allowlist, add one there rather than inferring the answer from the API's environment — inferring it is precisely the error the spec's §7.2 correction was about.
