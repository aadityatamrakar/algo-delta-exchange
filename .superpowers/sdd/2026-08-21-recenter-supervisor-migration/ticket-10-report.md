# Ticket 10 — Supervisor state store + lease (plan Task 12)

**Status:** DONE (judgement calls flagged in §5; nothing blocked)
**Branch:** `worktree-agent-a6c53a3fa866174ec` (worktree at
`/Users/aaditya/Documents/dev/algomaker/.claude/worktrees/agent-a6c53a3fa866174ec`,
based off `df634222` on `recenter-migration`)

| Commit | Subject |
|---|---|
| `99db14bc` | feat(supervisor): durable per-book state with CAS and a lease that stops two supervisors steering one book |

---

## 1. What was implemented

### `apps/supervisor/package.json` — the workspace scaffold (I own it)

Mirrors `apps/runner/package.json`: `@algomaker/supervisor`, `private`,
`"type": "module"`, `scripts.test = node --test test/*.test.ts`,
`engines.node >= 22`. Dependencies are exactly the two the parent brief named:
`@algomaker/core` and `@algomaker/desk-engine`. Deliberately minimal — no
`main`, no `exports`, no bin entry, no `mongodb`: `main.ts` and
`bin/desk-supervisor.mjs` are Task 15's, and the Mongo driver is declared by
`apps/api` (the one workspace that `require`s it), exactly as
`apps/order-gateway` does while importing `../../api/src/mongo.ts`.

`npm install` at the worktree root linked it
(`node_modules/@algomaker/supervisor -> ../../apps/supervisor`);
`package-lock.json` picked up 15 additive lines and nothing else changed
(verified by diffing the lock).

### `apps/supervisor/src/state-store.ts` — owns `desk-supervisor-state`

Exports `SUPERVISOR_STATE_COLLECTION`, `SupervisorBookState`,
`StateCollection` (narrow Mongo port), `stateKey`, `emptyBookState`,
`nextVersion`, and `class StateStore { ensureIndexes, load, save }`.

- `load(tag, mode)` → the book's state or `emptyBookState` (`EMPTY_RULE_STATE`,
  `seq 0`, `updatedAt 0`, `workingPackage`/`inFlight` null, `protectedQty {}`).
- `save(prev, next)` → `findOneAndUpdate({key, updatedAt: prev.updatedAt},
  {$set: …}, {upsert: true})`, per the `queue.ts:172-187` claim pattern.
  `false` on conflict: a stale filter that matches nothing upserts into the
  `key` unique index and comes back E11000, which is the *same* answer the
  first-save race gives, so both conflict shapes read identically to the
  caller. `isDuplicateKey` is imported from `apps/api/src/errors.ts` rather
  than re-spelled (cross-app import, order-gateway precedent).
- `ensureIndexes()` creates the `{key: 1}` UNIQUE index. It is load bearing,
  not decoration: without it the losing upsert *inserts a second document* for
  the same book and each supervisor keeps a private memory of it. Task 15 must
  call it on the boot path.

### `apps/supervisor/src/lease.ts` — owns `desk-supervisor-lease`

Exports `SUPERVISOR_LEASE_COLLECTION`, `LeaseCollection`, `LeaseDeps`, and
`class Lease { owner (getter), ensureIndexes, acquire, heartbeat, release }`.
Constructor takes `{collection, key, now}`; `acquire(owner, ttlMs)` keeps the
brief's signature and the instance remembers owner+TTL for the fenced
`heartbeat`/`release`.

- `acquire` — conditional upsert on `key` AND (`owner` is us OR `expiresAt <=
  now` OR `expiresAt` missing/null). Loser collides with the `{key: 1}` unique
  index → `false`, which is a STANDBY signal, not a crash.
- `heartbeat` — `updateOne` fenced on `owner`; `matchedCount === 1` → `true`,
  anything else clears the remembered owner and returns `false` so a process
  paused past the TTL learns it lost. A lease that lapsed but that nobody took
  is still renewed (a GC pause should cost a beat, not the book).
- `release` — `deleteOne` fenced on `owner`, silent when we hold nothing.

### Tests

`apps/supervisor/test/require-mongo.ts` — `skipUnlessMongo`, **copied** from
`apps/api/test/require-mongo.ts` (see §5.1). Per-suite URLs:
`DESK_TEST_MONGO_SUPERVISOR_STATE` / `_LEASE`, else own databases on
`127.0.0.1:27017` — the per-suite default that stops parallel node:test
processes wiping each other's fixtures.

`state-store.test.ts` (12) — key is tag+mode; `nextVersion` clamps a frozen and
a backwards clock; fresh load defaults; first save creates and writes exactly
the version it was given; full round trip (rcStack, scrapBanned,
workingPackage `WireAction`s, protectedQty, negative cumRealized); stale writer
refused with the winner's state standing; stale FIRST writer refused **and only
one document exists**; two same-millisecond saves both advance and the
superseded version is dead (ABA); a partial legacy document hydrates to
`EMPTY_RULE_STATE` values with `typeof` assertions and is still writable;
cross-book save throws; non-advancing version throws; NaN/Infinity throw naming
the field and write nothing.

`lease.test.ts` (12) — free lease taken; second owner refused while the holder
heartbeats; heartbeats push the expiry past two TTLs; after a TTL lapse the
second owner takes it and the zombie's heartbeat is `false`; the evicted
holder's `release` does not free the new holder's lease; `release` hands over
without waiting out the TTL; same-owner re-acquire renews; heartbeat before
acquire is `false`; a refused acquirer can neither heartbeat nor release the
holder out; a lease document with no `expiresAt` is takeable; a non-positive or
NaN TTL throws and writes nothing; different keys do not contend.

---

## 2. Verification

| Check | Result |
|---|---|
| `npm test --workspace @algomaker/supervisor` with `DESK_REQUIRE_MONGO=1` | **24 pass, 0 fail, 0 skipped** |
| Same suite with no env vars (default 27017) | 24 pass, 0 skipped |
| `npx tsc -p tsconfig.json` (root project) | clean, exit 0 |
| `npm run test:node` (whole tree) | 2914 tests, **2913 pass, 1 fail, 0 skipped** — see §3 |
| RED before GREEN | both suites failed with ERR_MODULE_NOT_FOUND before `src/` existed |

Mongo for the run: a scratch `mongod` started on `127.0.0.1:27099` with a
dbpath under the session scratchpad (no local Mongo was running; the repo's
`make mongo-up` needs a Docker daemon that is not up). Stopped afterwards. A
peer agent's scratch `mongod` occupies 27017; my suites use their own database
names, so nothing collided.

---

## 3. The one failing test in the tree is PRE-EXISTING

`apps/api/test/service.integration.test.ts` → *"a PARTIALLY marked book names
only the missing legs"* (`pos.complete` is `true`, expected `false`).

Proven not mine, two ways:

1. `git stash push -u` (my untracked `apps/supervisor` + the lock change), then
   the same file against a private empty database: **still 39/40, same test**.
   Restored with `git stash pop`.
2. The only file outside `apps/supervisor/` I touched is `package-lock.json`,
   and its diff is 15 additive lines describing the new workspace — no version
   of any package moved.

Not investigated further (different ticket's surface). Worth someone's eye: the
fixtures use a `26JUL` expiry and today is 2026-08-21, which smells like a
time-bomb fixture rather than a live defect.

---

## 4. Interfaces the later tickets get

```ts
// state-store.ts
export const SUPERVISOR_STATE_COLLECTION = 'desk-supervisor-state'
export function stateKey(tag: string, mode: Mode): string          // `${tag}:${mode}`
export function emptyBookState(tag: string, mode: Mode): SupervisorBookState
export function nextVersion(prev: SupervisorBookState, nowMs: number): number
export class StateStore {
  constructor(collection: StateCollection)                          // cast the driver collection once
  ensureIndexes(): Promise<void>                                    // MUST run on the boot path
  load(tag: string, mode: Mode): Promise<SupervisorBookState>
  save(prev: SupervisorBookState, next: SupervisorBookState): Promise<boolean>
}

// lease.ts
export const SUPERVISOR_LEASE_COLLECTION = 'desk-supervisor-lease'
export class Lease {
  constructor(deps: { collection: LeaseCollection; key: string; now: () => number })
  get owner(): string | null                                        // for GET /health
  ensureIndexes(): Promise<void>                                    // MUST run on the boot path
  acquire(owner: string, ttlMs: number): Promise<boolean>
  heartbeat(): Promise<boolean>
  release(): Promise<void>
}
```

**How Task 14 must use `save`** (the one thing that is easy to get wrong):
build `next` with `updatedAt: nextVersion(prev, now())`. After a `true`, the
version on disk IS that number, so the caller can keep `next` and save again
without re-reading. After a `false`, **reload and decide again** — never retry
the same `next`, because the writer that won may have routed orders this one
knows nothing about.

---

## 5. Judgement calls (flagged for review)

**5.1 `require-mongo.ts` is copied, not imported.** `apps/api/test/` is not a
workspace product — nothing is exported from it and no package.json can see the
dependency — so a suite here reaching into another app's *test* folder is a
worse coupling than duplicating one env var and a comment. The copy names the
original as the source of truth. If a third workspace needs it, that is the
moment for a shared test package. (Cross-app **src** imports, e.g.
`../../api/src/errors.ts`, are the established house pattern and I used those.)

**5.2 `save` takes the version from the caller and refuses one that does not
advance.** The brief fixes `save(prev, next): Promise<boolean>`, so the store
cannot hand a stamped version back. Stamping it internally would force a
`load()` between every two saves; letting the caller pass it keeps the state
object current after a `true`. The strict-advance rule (and `nextVersion`'s
`Math.max(nowMs, prev.updatedAt + 1)`) is lifted verbatim from
`apps/api/src/store.ts:saveBook` — same reasoning, same hazard.

**5.3 Extras beyond the brief's two methods**, each because the guard it adds
is one line and the failure it prevents is silent:
- `ensureIndexes()` on both classes — the CAS and the claim are *built on* the
  unique index.
- Non-finite refused at the write, naming the field (a NaN fold poisons every
  later comparison and is found by reading rules line by line).
- `acquire` throws on a non-positive/NaN `ttlMs`: `now + NaN` is `NaN`, `NaN`
  fails every `$lte`, and the lease would then be held forever by nobody — a
  TTL fumbled out of an unset env var bricks the book for the session.
- `acquire` also treats a missing/null `expiresAt` as free, for the same
  "held forever by nobody" reason (older document, shell repair).
- `Lease.owner` getter — Task 15's `GET /health` reports lease state.

**5.4 Hydration drops malformed `rcStack` entries rather than zero-filling
them.** A `strike: 0` entry would send the LIFO unwind buying back a strike
that does not exist. `workingPackage.remaining` is read back structurally
(cast, not parsed) because the process that EXECUTES a `WireAction` is the one
that must validate it — a parse here would be a second, quieter contract.

**5.5 A non-finite number that somehow reaches the document reads as absent**
(`num()`'s fallback) rather than throwing on load. NaN propagating into the
engine is strictly worse than a visible zero: it makes every comparison false
silently. Documented in the file header.

---

## 6. Follow-ups for Task 15 (boot path)

1. Call `StateStore.ensureIndexes()` **and** `Lease.ensureIndexes()` before the
   first save/acquire. Neither guard exists without its unique index.
2. `acquire` returning `false` means WAIT AND RETRY — a second supervisor is a
   standby, never an exit (the brief already says this; the class is built for
   it).
3. Heartbeat interval must be comfortably under the TTL, and a `false` from
   `heartbeat()` must stop the evaluate loop, not just log.
4. Give each process a genuinely unique owner id (host:pid:startMs). A stable
   id would let a restarted process renew a lease a peer may have taken.
5. The collection casts (`as unknown as StateCollection` / `LeaseCollection`)
   happen once at wiring time — `apps/api`'s `Collection` port does not declare
   `findOneAndUpdate`, same as `queue.ts`.

---

## 7. Review fix round 1 — `0da5e0e4`

**Finding (Important, from task review):** every contention test was a
SEQUENTIAL simulation — zero `Promise.all` in either file. They prove the
filter is right under author-controlled ordering; they cannot see whether the
write is atomic, and they would not catch a future refactor that reintroduces a
read-then-write gap (a `findOne` pre-check in front of the `findOneAndUpdate`),
because under chosen ordering that gap looks exactly like a compare-and-set.

### 7.1 Changes

**`test/state-store.test.ts` — three real races added**
- *two supervisors saving AT ONCE off one read* — both saves fired through
  `Promise.all` off the same freshly-loaded `prev`; asserts exactly one `true`,
  that the reloaded document `deepEqual`s the winner's state **whole** (a
  field-by-field assertion would let a torn write pass), and that one document
  exists. Decided by the unique key (nothing to match yet).
- *the same race against an EXISTING document* — same shape after a seeded
  save, so the winner is decided by the version in the CAS filter, which is the
  other half of the mechanism.
- *the unique index builds ITSELF* — drops `key_1`, builds a brand-new
  `StateStore` that is never told to `ensureIndexes()`, races two saves, and
  asserts one winner and one document.

**`test/lease.test.ts` — three real races added**
- *two supervisors claiming AT ONCE* — exactly one `true`; the winner
  heartbeats, the loser cannot, one document.
- *two supervisors taking an EXPIRED lease at once* — the dangerous shape:
  both claims MATCH the document, so nothing but the server re-evaluating the
  filter under the write keeps them apart. Confirmed it does; no fix needed.
- *the unique index builds ITSELF* — drops `key_1`, races two claims with no
  `ensureIndexes()` call anywhere, asserts one winner and one document.

Every race assertion is on the outcome SHAPE (`won.filter(Boolean).length ===
1`) and never names the winner, so the tests are deterministic even though the
winner's identity is not.

**Minor 1 — lazy self-invoking index guard (both classes).** `#indexed()`
caches the `createIndex` promise and is awaited by `StateStore.save` and
`Lease.acquire`; the public `ensureIndexes()` now delegates to it, so an
explicit boot-path call and the lazy guard share one build. A failed build
clears the cache and rethrows — the next write retries rather than inheriting a
rejection forever, and until it succeeds no write goes out unguarded. Rationale
in both file headers: the unique index is what makes the CAS and the claim work
at all, and "the caller calls `ensureIndexes()` first" is a precondition that
survives review and dies in a refactor, silently and only under a race.

**Minor 2 — header note.** `state-store.ts` now states that
`workingPackage.remaining` is deliberately NOT validated on the way out: a
malformed `WireAction` surfaces at the EXECUTOR (Task 14 / desk-api's decision
endpoint), which owns the live contract, rather than being parsed against a
second quieter copy here. What hydration still promises is the shape around
them (always an array, every element an object).

### 7.2 The new tests were proven to bite (mutation testing)

| Mutation | Result |
|---|---|
| `save`: `findOne` pre-check + `findOneAndUpdate({key})` — i.e. the exact read-then-write gap the finding names | **3 race tests fail** with `exactly one writer may land, got true,true`; **all 12 sequential tests still pass** — the finding demonstrated, not just accepted |
| `acquire`: expiry fence widened to `$lte: now + 999_999` | 8 tests fail, both lease races among them |

Both mutations were reverted; `grep` for leftovers is clean and the committed
diff is additive only (`203 insertions(+), 2 deletions(-)`, the two deletions
being the old `ensureIndexes` bodies).

### 7.3 Verification

```
DESK_REQUIRE_MONGO=1 \
DESK_TEST_MONGO_SUPERVISOR_STATE=mongodb://127.0.0.1:27099/algomaker_supervisor_state_test \
DESK_TEST_MONGO_SUPERVISOR_LEASE=mongodb://127.0.0.1:27099/algomaker_supervisor_lease_test \
npm test --workspace @algomaker/supervisor
→ ℹ tests 30 / ℹ pass 30 / ℹ fail 0 / ℹ skipped 0

npx tsc -p tsconfig.json
→ clean, exit 0
```

(24 tests before this round, 30 after.) §6's follow-up 1 for Task 15 is now
softened but NOT retired: calling `ensureIndexes()` on the boot path is still
the right thing to do — it just is no longer the difference between one
supervisor and two.
