# One global paper/live switch — Design Spec

**Date:** 2026-07-27
**Status:** approved
**Supersedes:** the paper/live page split in `2026-07-27-phase-a-access-control-design.md` §6b and the
split strategy pages in the `2026-07-27b` addendum to the API contract.

## 1. The problem

The operator's words: *"we have paper and live trading, two modes and it complicates all the things
in frontend."*

Paper/live had grown into **six different mechanisms** across the dashboard, each answering the same
question a different way:

| Surface | How the mode was chosen |
|---|---|
| `#/paper`, `#/live` | separate pages |
| Controls | its own toggle |
| Reports | two total cards, side by side |
| Strategy detail | its own toggle |
| Strategies list | about to become two more pages |
| P&L cards | inherited from whichever page you were on |

The duality is real and cannot be removed — the desk genuinely runs both. What can be removed is
**re-deciding it on every screen**.

## 2. The design

**One switch, in the navbar, persisted to `localStorage`.** Every page reads it and renders only
that mode. No page carries a mode control of its own.

```
┌──────────────────────────────────────────────────────────────┐
│ SMPv2   Positions Strategies Reports Orders Feed Controls    │
│                                    [ PAPER | LIVE ]  Theme   │
└──────────────────────────────────────────────────────────────┘
```

Routes lose their mode:

| Was | Becomes |
|---|---|
| `#/paper`, `#/live` | `#/positions` |
| `#/strategies` + `#/strategies-live` | `#/strategies` |
| everything else | unchanged |

Default on a browser that has never set it: **paper**. Not live — the first thing a new machine
does must not be to point at real money.

## 3. Each mode has its own colour, and live is unmissable

The two modes get **distinct, consistent colours** rather than live merely being decorated. The
operator asked for this so the mode is *remembered* rather than read — you should know where you
are from peripheral vision, before you have read a single word.

| Mode | Colour | Why |
|---|---|---|
| **Paper** | blue | Calm, and unmistakably not red. Blue reads as informational everywhere else in this app, which is exactly right for simulated money. |
| **Live** | red | The only red in the chrome. Reserved for this and for destructive buttons, so it never becomes background noise. |

The colour is applied in the same three places every time, so it is learned once:

- the **mode switch** itself — the selected side is filled in its colour
- a **rule across the top of the page**, full width, 3px
- the **badge** beside anything mode-scoped (a book, a strategy row, a total)

Green is deliberately NOT used for either. Green already means profit on this dashboard, and a
green chrome beside a red P&L figure would be two different meanings of colour fighting on one
screen.

### Why live needs more than a colour

The property being given up is real: "am I looking at real money?" used to be answered by *which
page you are on*, which is hard to get wrong and survives a reload. A toggle is easy to get wrong,
and because it persists you can arrive the next morning already on live and act before noticing.

So live also carries the word **LIVE** in the badge, not just the colour — colour alone fails for
the ~8% of men with red-green deficiency, and it fails entirely on a screenshot pasted into a chat.
The rule is a persistent frame, never a dismissible banner somebody learns to ignore.

Switching **to** live costs nothing and asks nothing: looking is free. Enabling a strategy to trade
live still requires the password, exactly as now. **The switch changes what you SEE; it never
grants a permission.**

## 4. Strategies page

One table, for the current mode. It lists **only strategies added to that mode** — the rest of the
catalogue is invisible until added, because the registry will grow well past what is useful to
scroll.

**Membership and enablement are separate states.** Per mode a strategy is:

1. **not added** — invisible on the page
2. **added, off** — in the table, not trading
3. **added, on** — trading

A single boolean cannot express this, and the failure is concrete: with one flag, switching a
strategy off removes it from the table, and there is no way to switch it back on short of
re-adding it. Pausing a strategy for an afternoon would mean deleting and recreating its row.

An **Add strategy** modal lists what is available for the current mode and is the only way into
state 2. A created row is always **off** — adding and permitting are separate acts, for the same
reason a seeded row is off.

Columns, deliberately few: tag, on/off, live lots (live mode only), autostart, last seen, runtime
state. Everything else belongs on the strategy's own page.

## 5. Reports

Replaces the whole-day summary: **pick a strategy, pick a date range** — pre-selected to the last
3 months — and see that strategy's history. Chart across the range, table of days beneath it.

This needs a new backend query. Reports are keyed by single day (`?date=`) today; a range for one
strategy is `GET /v1/desk/reports/history?tag=&from=&to=`.

## 6. What this does NOT change

- The registry is still per-mode on the server; only the UI's way of choosing collapses.
- Every gate, re-auth requirement and safety control is untouched.
- Destructive actions (close-all, flatten, kill switch) act on the **selected mode** — which is
  precisely why §3 is a requirement and not decoration.

## 7. Accepted trade-offs

- **`localStorage` is per browser**, so the switch does not follow the operator between machines.
  Acceptable for one operator; it also means a shared machine remembers the last person's choice,
  which §3's red frame is what makes safe.
- **The mode is no longer in the URL**, so a link cannot carry it. Deliberate: a URL that silently
  changed someone's mode would be worse than not being able to share one.

## 8. Testing

- The switch persists across a reload and a new tab.
- Every page renders the selected mode and no page offers its own mode control.
- Live mode shows the badge and the rule; paper shows neither.
- A default-state browser lands on paper.
- The strategies table shows added-and-off rows; the add modal offers only what is not yet added.
- Nulls still render as "—", never 0.
