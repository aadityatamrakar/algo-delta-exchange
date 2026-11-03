---
name: adjust
title: Adjusting a tested book
use-when: "what should I do", "what else can we do", "how do I fix delta", a short strike is tested, delta is out of band, the stock is trending
---

# Adjusting a tested book

Goal: show the smallest change that fixes the problem, beside doing nothing, with what it costs.

## How this desk adjusts (desk-record)
- Delta is kept in the band with options, not futures: on a 1.5%+ day the usual move is to **roll the untested side toward spot** (about 8 days in 10). The tested short is cut about 1 day in 7.
- That works in a range. In a trend it builds a short straddle at the new price and doubles the loss on the next leg of the move.
- The desk's losses sit in trend months: the worst 10% of series had a ~10% move from entry and ~13 adjustment days, and lost about what all winning series made.

## Steps
1. Name the problem in one line: tested side, delta out of band, or expiry/delivery.
2. Count the series' rolls so far (get_track_record open row, or trades). Two or more rolls the same way, or a 7%+ move from entry = **trend month**.
3. Range (move < 7%, few rolls): rolling the untested side is the desk's normal fix — check it with evaluate_adjustment, or search_adjustments with the neutralize goal.
4. Trend month: lead with plans that cap the tested side instead of re-centring —
   - buy a wing on the tested side (defines the loss),
   - the futures route from neutralize_delta (exact delta, no new gamma),
   - closing or rolling the tested short only if "Allow closing legs" is ticked; otherwise evaluate it as the trader's idea when they name it.
   Say plainly that another untested-side roll adds to the trend risk.
5. Always: do-nothing column, cost (charges + spread), max loss and worst shock before → after, margin change.

## Answer shape
- Headline: the fix in one line — "**Buy 2 lots 2700 CE (P3): max loss −₹4.1 L → −₹2.6 L for ₹18k.**"
- ### Plan — one table: Do nothing | P# (at most 2 plans), rows: max loss, worst shock, delta, margin, cost.
- ### Why — two bullets.
- ### Watch — what would make you change it.

## Guardrails
- Plans and their figures come only from the search tools. Never price a plan yourself.
- Never more than two plans in the table; name others in one line.
- Quotes after the close are stale: say "indicative" and suggest re-running after 09:20.
