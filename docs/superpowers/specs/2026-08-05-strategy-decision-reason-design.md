# Surfacing the strategy's decision reason on the dashboard

Date: 2026-08-05
Status: approved (design), not yet implemented

## The problem this solves

On 2026-08-05 the operator saw the DLF book's delta-neutral figure reach 2.4%
— outside the variant's 2% band — and no new position appear. The dashboard
said the book was in sync, which was true, but offered nothing to explain the
inaction. Answering the question took an SSH session and a read of
`data/desk/<TAG>/live.jsonl` on the server.

The engine had already written the answer at every mark:

```
recenter-otm: netΓ -3.8 — allowance 188 under one lot (225); no convexity to centre
```

That string never leaves the Python process. `translate.to_actions` returns
`[]` for `action == "hold"`, so a hold posts an empty action list to the bridge
and the reason is dropped on the floor. The dashboard cannot show what it is
never told.

This is a visibility gap, not a behaviour bug. The hold was correct — the
allowance (`|netΓ| × 2% × spot` = 188) was under one lot (225), which is the
documented "no convexity to centre" guard in `playbooks.py`. Note also that the
same near-zero net gamma is what made the displayed percentage large in the
first place: the tile plots `spot − netΔ/netΓ` (`apps/web/src/positions.ts:210`),
so a small denominator throws the neutral point far from spot. The alarming
number and the inaction share one cause. The panel must make that legible
without the operator reasoning it out from greeks.

## What we are building

A STRATEGY panel on `#/strategies/{run}`, below the order log, in two parts:

```
┌─ STRATEGY ─────────────────────────────────┐
│ NOW  11:10 · holding                       │
│  netΓ -3.8 — allowance 188 under one lot   │
│  (225); no convexity to centre             │
│                                            │
│ ACTIONS                                    │
│  09:16  opened 4 legs · entry structure    │
│  (nothing since)                           │
└────────────────────────────────────────────┘
```

- **NOW** — the current reason, whatever the book is doing, refreshed every
  mark. Shows the mark timestamp only.
- **ACTIONS** — only decisions that actually did something (bought, sold,
  adjusted), since book inception.

## Why this shape

The engine emits a reason every ~30s per book, and consecutive holds are
near-identical (`allowance 188` → `187` → `188`). Storing every one would add
~800 rows per book per day that say nothing changed, and reading them back
would bury the two rows that matter.

Splitting current-state from event-history solves that without a retention
policy: the NOW line is overwritten in place and never grows, and the action
list only gains a row when the book actually traded.

## Design

### 1. Python — attach the reason to the payload that already goes out

`sensibull_tools/live/desk/driver.py:_route` already posts on EVERY mark,
including holds. Confirmed in the live logs: `POST /v1/desk/actions 200` every
30s through a day on which every decision was a hold. The payload is:

```python
payload = {
    "symbol": self.symbol, "expiry": self.expiry, "mode": self.mode,
    "tag": self.tag, "decisionId": decision_id, "actions": actions,
}
```

Add two fields:

```python
    "action": exec_dec.get("action"),   # "hold" | "adjust" | ...
    "reason": exec_dec.get("reason"),   # the engine's verbatim string
```

No new endpoint, no new HTTP call, no change to cadence. `to_actions` keeps
returning `[]` for a hold — the reason rides alongside the empty list rather
than through it.

The reason is stored VERBATIM. It is generated text from the rule engine and
the dashboard is a reader, not an interpreter; parsing it into fields would
couple the web app to wording that changes whenever a playbook does.

### 2. desk-api — two writes, no new collection

`validateActionsRequest` (`apps/api/src/validate.ts:119`) is allowlist-style:
it reads named fields and ignores unknown ones. It must be extended to carry
`action` and `reason` through as OPTIONAL fields.

**This gives an independent-deploy property worth preserving.** Until desk-api
is taught to read them the extra fields are silently dropped; if desk-api ships
first, the fields are simply absent and the panel shows "no reason recorded".
Neither side breaks the other, so the two repos can deploy in either order.
That matters here because `desk-runner` squares off positions on SIGTERM, and a
coordinated mid-session deploy across two repos is exactly the risk we do not
want to take for a display feature.

**Write A — current reason.** `$set` onto the book's `desk-books-registry` doc,
alongside the existing `lastDecision` / `lastMarkAt`:

- `lastReason: string`
- `lastAction: string`
- `lastReasonAt: number` (epoch ms)

Overwritten each mark. Bounded by book count, not by time.

**Write B — action history.** `desk-decisions` ALREADY writes one row per
decision, including holds (today's rows carry `fills: []`, `skips: []`,
`status: "DONE"`). Adding `reason` and `action` to that row therefore costs no
extra document and no extra write — it is a field on a row that exists either
way.

The filtering to "only what it did" happens at READ time (`fills` non-empty),
not write time. No new collection, no retention policy, and the full
per-decision trail stays available for debugging without being rendered.

### 3. Read endpoint

`GET /v1/desk/decisions?tag=<tag>` returns:

```json
{
  "lastReason": "recenter-otm: netΓ -3.8 — allowance 188 under one lot (225)…",
  "lastAction": "hold",
  "lastReasonAt": 1785908478807,
  "actions": [
    { "at": 1785823000000, "decisionId": "…", "action": "adjust",
      "reason": "…", "fills": [ … ] }
  ]
}
```

`actions` is `desk-decisions` for that tag where `fills` is non-empty, oldest
first, since inception. Books live to expiry and adjust rarely — the live books
carry 18 and 11 fills total — so this is a short list in practice. It is still
capped server-side (200, newest kept) so a pathological book cannot wedge the
page.

### 4. Web

A panel in the `#/strategies/{run}` view under the order log, fed by the
existing polling/stream path rather than a new timer.

- No reason recorded yet → "no reason recorded" rather than an empty box, so a
  book that predates the feature is distinguishable from one that is broken.
- Reason present, no actions → the NOW line plus "(nothing since)". This is the
  normal state for a healthy quiet book and must not read as an error.
- The reason string renders as plain text, wrapped, never truncated mid-token —
  the numbers in it are the content.

## Error handling

Every part of this is best-effort and must not touch routing. A decision routes
or does not route on its own merits; the reason is telemetry attached to it.

- Python: `exec_dec.get("reason")` on a decision without one yields `None`,
  which serialises to `null`. No new failure path.
- desk-api: a missing or non-string `reason` is stored as absent, not as the
  string "undefined". The decision still applies.
- Web: a missing panel payload renders the empty state. It never blocks the
  order log above it.

## Testing

- `validate.ts` — `action`/`reason` carried through when present; request still
  valid when they are absent (the independent-deploy property, which is the one
  a regression here would silently cost us).
- The actions handler — registry `$set` fires on a hold with empty actions;
  `desk-decisions` row carries the reason.
- The read endpoint — filters to `fills`-non-empty; ordering; the cap.
- Web — the three states above (no reason / reason with no actions / reason
  with actions).

A fixture built from a real recorded hold payload, so the exact shape the live
supervisor sends is the thing under test rather than an idealised one.

## Out of scope

- **Parsing the reason into structured fields.** Verbatim only, as above.
- **Backfilling history.** `data/desk/<TAG>/live.jsonl` on the server holds
  every past reason, but importing it is a separate job with its own decisions
  about duplicate decisionIds. The panel starts from the deploy.
- **Alerting on a stale mark.** Considered and dropped: the operator chose the
  timestamp-only NOW line. A dead-supervisor warning belongs with the other
  health signals, not in a per-book reason panel.
- **The margin tile's 403.** Same investigation, unrelated cause, tracked
  separately — the feed's enctoken is being rejected for REST while the
  websocket keeps streaming, so `feed-recovery.ts` never rotates it.
