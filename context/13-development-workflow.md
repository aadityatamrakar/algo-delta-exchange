# How work actually gets done here

*Written **2026-07-28**, describing the workflow in use on branch `overhaul/foundation`. This is a
record of practice, not a proposal — every step below has an artefact in the repo you can point at.*

---

## The loop

```
brainstorm  ->  design doc  ->  implement  ->  verify  ->  review + merge  ->  commit  ->  deploy
                (committed)     (worktrees)   (2 suites)   (on the merged     (over        (over SSH)
                                                            tree)              SSH)
```

### 1. Brainstorm

Nothing gets built from a one-line request. The complaint is restated until the *actual* cause is
named, which is often not the one in the complaint. Two examples from today:

- "REST polling is slow for an algo trading app" → the transport was never the expensive part;
  `/v1/desk/pnl` rescans 30 days of `desk-decisions` per poll. Swapping the transport without
  fixing that would have multiplied the load by ten.
  (`docs/superpowers/specs/2026-07-28-websocket-push-design.md`, opening section.)
- "there is too much whitespace on the strategy page" → one `proportional()` column absorbing
  ~1000px of a wide monitor, which is why an earlier padding fix (`5ff9db55`) could not touch it.
  (`docs/superpowers/specs/2026-07-28-strategy-page-layout-design.md`, "The problem".)

### 2. The design doc is committed before the code

```
docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md
```

Fourteen of them exist. Each carries a **Date**, a **Status** and a **Scope** header, states the
locked decisions with their reasons, and — the part that earns its keep — records the alternatives
that were rejected and why. Plans, when the work needs sequencing across sessions, go in
`docs/superpowers/plans/` under the same naming; agent reviews in `docs/superpowers/reviews/`.

**Keep the Status line honest.** Two docs said "approved, not yet implemented" hours after they
shipped; both were corrected on 2026-07-28. A stale status is worse than no status, because the next
reader plans around it.

**The doc is not the authority once the code exists.** The layout spec says 58/42; the shipped grid
is 50/50 (`apps/web/src/comfort.css:201-213`), changed mid-implementation for a reason discovered
during implementation. Where they disagree, the code is right and the doc gets a correction note.

### 3. Implement — often in isolated worktrees

Independent slices are handed to subagents working in **separate git worktrees** under
`.claude/worktrees/agent-*`, each on its own `worktree-agent-*` branch. Today's three:

| Worktree branch | Landed as |
|---|---|
| `worktree-agent-ab0ca25e58bfc4682` | `4eb85002` — responsive layout, merged `e083e1d6` |
| `worktree-agent-acec09a25c8eb6043` | `90923d3b` — websocket push phase 1, merged `2f96c79c` |
| `worktree-agent-afb9de014edf18390` | `660434ba` — mobile cards, merged `0641215a` |

`.claude/worktrees/` is **gitignored** (`66854772`). It had to be: `git add -A` swept the worktrees
into the index as embedded git repositories — 160000-mode gitlinks — and a clone would have got
empty directories with no way to fill them.

### 4. Verify — and the root typecheck is not enough

```sh
make check                                # typecheck + BOTH suites
npm run typecheck                         # tsc -p tsconfig.json  — DOES NOT COVER apps/web
cd apps/web && npx tsc -b                 # the gate that does
npm run build --workspace @algomaker/web  # tsc -b && vite build
```

**There are exactly two test suites, and running one reports green while half the system is
untested.** `package.json:13-16`:

- `test:node` — `node --test 'packages/*/test/**/*.test.ts' 'apps/*/test/**/*.test.ts'`
- `test:web` — `vitest run` in `apps/web` (jsdom)

They are split because **`node --test` cannot run JSX**. Every web test is `.test.tsx` and is
therefore not matched by the node glob — the reason is spelled out in a `_comment:test:web` key in
`package.json` precisely so nobody re-merges them.

**And the root typecheck excludes the dashboard.** `tsconfig.json:11` lists `apps/web` in `exclude`,
and its `include` globs only `*.ts`, never `*.tsx`. `make check` runs that same root typecheck, so
it does not cover `apps/web` either. On 2026-07-28 a type error reached the server this way
(`cc7f6933`): `size={phone ? 'sm' : undefined}` passes an *explicit* `undefined`, which
`exactOptionalPropertyTypes` rejects, and the first symptom was a **failed deploy with the previous
bundle still being served** — the dashboard build is the last step of `scripts/deploy.sh`.

> **Note for the next person to re-derive this:** the difference is *not* that the root config lacks
> `exactOptionalPropertyTypes`. `tsconfig.base.json:13` sets it and the root config inherits it
> unchanged. The difference is the `exclude` and the `*.ts`-only `include`. Same conclusion, but the
> wrong reason leads to the wrong fix.

**`npm run build --workspace @algomaker/web` currently FAILS on the developer laptop** with
`ERR_MODULE_NOT_FOUND: Cannot find package 'esbuild'` — vite's platform binary is missing from the
local `node_modules`. `tsc -b` passes; the failure is entirely in `vite build`. It works on the
server. Do not go hunting for a regression in the dashboard; `npm ci` at the repo root is the fix if
it needs fixing locally.

### 5. Review and merge — over the current tip

Agent branches are merged into `overhaul/foundation` by hand, and the merge commit message records
what was resolved and how.

> ## THE WORKTREE-MERGE HAZARD. It bit twice on 2026-07-28.
>
> **An agent branch based on an older tip can silently revert newer work.** The agent's tree is
> internally consistent and its tests pass; it simply never saw the commits that landed on the tip
> while it was working. Git merges its version of those files without complaint or, worse, resolves
> a conflict in favour of the branch.
>
> - `e083e1d6` — the responsive-layout branch predated `fc94ca17` and **reordered the Orders columns
>   back** to `… | Phase | Order id | Detail`. Both conflicts were resolved in favour of the newer
>   work: `Phase` stays deleted (it read FILL on every row of a paper session) and `Detail` stays
>   folded into `Status` (it restated the Qty and Price columns while holding twice the width of the
>   order id, which is what made 35-character ids wrap).
> - `2f96c79c` — the websocket branch predated the same commit, and its stream test anchored a row by
>   its `PLANNED` badge: the `Phase` column, since deleted. Re-anchored on the contract, which is
>   what the assertion was about in the first place.
>
> **The rule that came out of it:** resolve every conflict *deliberately*, naming which side wins and
> why in the merge message, and then **re-verify ON THE MERGED TREE** — not on either side of it.
> Both merge commits say so explicitly, which is the point: a passing agent branch and a passing tip
> do not add up to a passing merge.

### 6. Commit

Subject as a sentence about the *effect*, not the change: "the dashboard build broke on
exactOptionalPropertyTypes", "positions and paper orders were read from collections nothing writes",
"a switched-off strategy kept reporting 'running'". Bodies explain **why it happened and why the fix
is the right one**, and routinely record what was discovered on the way ("Found on the way:
`blockedEvents` never stamped WHICH rail it refused"). Several of the file:line facts in
`12-dashboard-data-and-push.md` came out of commit bodies before they came out of the code.

Merge and feature commits carry a verification line — what was run, and on which tree.

### 7. Deploy — over SSH

```sh
make deploy-remote            # laptop -> ubuntu@3.108.231.230 -> the same `make deploy` on the box
make status-remote            # pm2 list + /health
```

The full procedure, guards and rollback are in `docs/DEPLOYMENT.md` §11. The two things that decide
whether a deploy is safe:

- **`desk-runner` squares off on SIGTERM.** Restarting it mid-session closes real positions. A safe
  mid-session deploy is: rebuild the web bundle (static, zero risk) and restart **only** `desk-api`,
  plus `desk-gateway` if it changed. `scripts/deploy.sh` restarts all four and refuses during market
  hours by design.
- **A `desk-api` restart during market hours can cost a signal.** The runner covers a submit for
  ~600 ms (3 attempts, 200 ms apart); beyond that the outcome is recorded as OUTCOME UNKNOWN and
  deferred to the strategy's next tick, which replays the same `clientOrderId`. Nothing
  double-routes.

---

## What the skills contribute

The `superpowers` skill set is what keeps the loop from being skipped: `brainstorming` before
creative work, `writing-plans` before code, `test-driven-development`,
`verification-before-completion` (evidence before assertions — run the command, paste the output),
`requesting-code-review`, `using-git-worktrees`, and `subagent-driven-development` for parallel
slices. Their working state lands in `.superpowers/sdd/` (task briefs, per-task reports, review
diffs) and the durable output in `docs/superpowers/`.

## What is deliberately not in the loop

- **No CI.** GitHub Actions was removed on 2026-07-27 (`45be0db8`) in favour of deploying from a
  laptop over SSH. The guards live in `scripts/deploy.sh`, which means **the local verification step
  is the only gate** — there is nothing downstream to catch what it misses. That is the whole reason
  §4 above is worth its length.
- **No merge commits on the deploy host.** `scripts/deploy.sh` pulls `--ff-only`; a failure means
  someone committed on the server, which needs a human.
