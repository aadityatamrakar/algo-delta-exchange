# Delta Desk AI — desk playbooks, track record, and a cleaner chat

Date: 2026-11-01. Builds on 2026-10-23-traders-ai-desk-design.md (the assistant) and keeps every ruling there (R1 advisory
only, R2 numbers from tools, R5/R11 redaction, R9 envelope, R10 caps).

## Why

The operator: "use trader skills or build one based on open source GitHub skills, specific for our delta neutral option
selling desk; analyse how we trade and build the skill around it. Improve the chat UI: easy to read, remove excess,
format it well, don't put too much data in one place."

What the stored answers show (8 conversations, 23–30 Oct): the questions are book reviews ("tell me about the book",
"what's your view", "what else can we do"), moves ("why is BHEL moving"), vol concepts (VRP, IVR vs IVP) and breakevens.
The answers are right but dense: 200–300 words, a header-less two-column table of eight rows, long parentheticals,
caveats mixed into the lead, and every tool chip left on screen.

Trade analysis (scratch, not in the repo: 86,763 fills, 505 option series, 5 traders, Jul 2025 – Oct 2026, against the
NSE daily history): the desk sells monthly stock strangles ~27 days out with shorts ~4.5% OTM each side, keeps delta in
the band by rolling the untested side toward spot (futures are rare), is flat a median 13 days before expiry, and wins
74% of series — but the worst 10% of series (trend months: ~10% move from entry, ~14 adjustment days) lost about what
all winners made. The figures are in `apps/traders/src/agent/playbooks/desk-record.md`.

## Design

Two lanes, merged in `feat/ai-playbooks`.

### Lane P — server (apps/traders)

**P1. Playbooks: an open-source skill router, in our tool loop.** The pattern of the LLMQuant / Agent Skills packs: a
short index always in the prompt, the body opened on demand. Files: `apps/traders/src/agent/playbooks/*.md` (already
written: book-review, adjust, breakeven, new-entry, expiry-week, vol-read, move-check, desk-record). Each starts with
frontmatter:

```
---
name: <kebab-case, equal to the file's stem>
title: <short title>
use-when: <one line: the questions it answers>
---
```

`apps/traders/src/agent/playbooks.ts` reads the folder once at module load (sorted by name, so the prompt is
byte-stable), parses the three keys, and throws on a missing key, a name that is not the stem, or a duplicate. Exports
`PLAYBOOKS: readonly { name, title, useWhen, body }[]` and `PLAYBOOK_NAMES`. The body is the text after the frontmatter.
The app runs from source (`node src/main.ts`), so `new URL('./playbooks/', import.meta.url)` resolves on the box.

**P2. `read_playbook` tool** (`tools/playbook.ts`): input `{ name: z.enum(PLAYBOOK_NAMES) }` (strict); result
`{ ...envelope(ctx), name, title, body }`; label `reading the <title> playbook`; summary = title. Not a search. Placed
LAST in `AGENT_TOOLS`.

**P3. Prompt** (`prompt.ts`, PROMPT_VERSION → `desk-ai-2026-11-01.1`). Every existing rule and every string the tests
assert stays. Add three sections, in this order, after "What you are":

1. `The desk's way` — four lines: the desk sells monthly stock strangles ~4 weeks out, shorts ~4–5% OTM, and keeps delta
   in the band by rolling with options; most series win small; the risk is the trend month (a 7%+ move from entry or 8+
   adjustment days), where the worst tenth lost what the winners made; so the first check on any book is the tested side.
2. `Desk playbooks` — "Before answering a question that matches one, call read_playbook for it (at most two a turn); its
   steps and answer shape take precedence over the general style" + one line per playbook: `- <name>: <use-when>`,
   generated from PLAYBOOKS.
3. `Answer format` — replaces nothing; sits after `Style`:
   - First line: the answer in one bold sentence with its key figure.
   - Then at most three short sections, each opened by a `### ` heading of one to three words (Position, Risk, Plan,
     Why, Watch…), each with at most four bullets or one table. A yes/no or one-figure question gets one or two lines and
     no headings.
   - One fact per bullet; no bullet over about 20 words; no chains of brackets.
   - Tables only to compare (now vs plan, strikes, dates): a header row with names, at most 6 rows and 4 columns. Never
     a header-less table. Never repeat a table's figures in bullets.
   - A data caveat (indicative, stale, missing) goes last, once, on a line starting with `> `.

**P4. Track record.** `analytics/track-record.ts`, pure: the trader's option series (stock, expiry) from their trades,
the history closes and the Booked ledger's rows.

Per series (expired series, plus the trader's open ones flagged `open: true` with no P&L):
`stock, expiry, kind ('stock' | 'index'), entryDay, dteAtEntry, lastDay, dteAtLast, adjustDays` (days with fills after
the entry day), `contracts` (distinct option contracts traded), `shortCallPct` / `shortPutPct` (qty-weighted % of the
strikes SOLD on the entry day from the previous day's close; null when none or no close), `wings` (any option bought on
the entry day), `maxUpPct` / `maxDownPct` (largest close above / below the entry reference close over the series' life,
%), `heldToExpiry` (the ledger settled a cycle of it), `pnl` (the Booked row's net for that stock and expiry — the same
figure the Booked page shows; null with `pnlNote` when the row has no net), `open`.

Summary over the expired series in the window: `n, wins, winRate, medianWin, medianLoss, worstTenthLoss` (sum of the
worst ⌈n/10⌉), `allWins` (sum of winners), and buckets `byMove` (largest |move| from entry: <4%, 4–7%, 7–10%, ≥10%),
`byAdjustDays` (1, 2–3, 4–7, 8+), `heldToExpiry` vs `closedBefore` — each `{ n, winRate, medianPnl }`; `typical`:
medians of dteAtEntry, shortCallPct, shortPutPct, adjustDays, dteAtLast. Stock and index series are summarised apart.

Tool `get_track_record` (`tools/track-record.ts`), input `{ stock?: NSE symbol, months?: 1–18 (default 12) }`; series
newest first, at most 40 rows (the summary covers all in the window, and says so when rows were cut); envelope with
the Booked page's notes that apply (history start, charges estimate, unsettled). Label `reading your track record`
(or `… on TCS`). Placed after get_events. Reads through existing deps — the trades collection, the ledger, charges,
master, history — and keeps the result per trader, leg version and day like `bookedReader` (reuse it: `app.ts`
already builds one; add it to the deps if needed, keeping test fixtures compiling). Never a client code, order or trade
number in the result.

### Lane W — the chat (apps/web/src/traders/assistant)

Plain and dense stays the house style (no avatars, no chat-app chrome); the aim is reading ease.

- **W1. Answer typography**: line-height ~1.5 for answer text; paragraph and list spacing; the first paragraph, when it
  is wholly bold (the headline), drawn a step larger as the answer's lead; `#`–`###` headings as small uppercase
  section labels with space above and a hairline rule; bullets with a clear marker and hanging indent.
- **W2. Tables**: a header row (muted, small, bottom border), numbers right-aligned tabular, row hover; a table whose
  header cells are all empty is drawn as a key–value list (label muted left, value right), never an empty header row.
  Wide tables scroll inside their box.
- **W3. Callouts**: markdown `> ` lines become a muted callout (left rule, soft tinted background); a caveat that starts
  with "Indicative" gets the warning tint.
- **W4. Turns**: the trader's line as a compact tinted block aligned right (max ~85% width); a turn separator with
  air instead of a rule under every answer.
- **W5. Tools, folded**: while running, one status line with a small spinner and the current step label; when done,
  one muted line "Used N tools" that expands (details/summary) to the chips. Errors stay visible.
- **W6. Feedback, quieter**: thumbs smaller, shown at reduced opacity, full on hover/focus or when rated; on the last
  answer always shown.
- **W7. Empty state**: a one-line intro and 4–6 suggestion buttons that send at once — with a book: "Review this book",
  "What can I adjust?", "Show my breakevens", "Is premium rich here?", "My record on <STOCK>"; without: "Review my
  books", "Which book is most at risk?", "Explain VRP in two lines", "My track record".
- **W8. Composer**: textarea grows with the text (2 to ~8 rows), Enter sends / Shift+Enter new line hint, Send as a
  compact primary button; the "Sent with" line stays.
- **W9. Wider drawer**: an expand toggle in the drawer head switches 440px ↔ ~720px (capped by the viewport), kept in
  localStorage (wrapped in try/catch). Phones unchanged (full width).

The markdown renderer stays text-only (no raw HTML, no links, no images); blockquote is the one new block.

## Not in scope

No change to cards' figures, Plan search, the History list, the server's wire or events; no new P&L headline on any
page (the track record lives only in the chat).

## Ship

Each lane: its suites green (traders: `cd apps/traders && TRADERS_TEST_LANE=<lane> node --test test/*.test.ts` or the
touched files; web: `cd apps/web && npx vitest run --maxWorkers=3` on the touched tests, `npx tsc --noEmit -p .`),
`node --test apps/web/test/traders-css-braces.test.ts` after any CSS edit. Review, merge to master, push, `make
web-build`. desk-traders needs the operator's restart (`npx pm2 startOrRestart ecosystem.traders.config.cjs --only
desk-traders --update-env`) for P1–P4; the web is live on build.
