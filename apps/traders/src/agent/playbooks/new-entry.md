---
name: new-entry
title: New strangle entry
use-when: "should I sell X", "which strikes for next month", "is premium rich", rolling into the next month
---

# New strangle entry

Goal: say whether selling premium on this stock fits the desk's way now, and where.

## The desk's norm (desk-record)
- Monthly stock options, opened around the current expiry: **20–34 days out** (median 27).
- Short strangle, both sides, often with wings: short call ~**4–5% above** spot, short put ~**4–5% below** (about 0.6 standard deviations to expiry).
- Median size 9 lots a side.
- The entry IV level did not separate winners from losers (72–76% won in every IV band). The move after entry did.

## Checks
1. get_market_context: IV rank, VRP and realized-VRP %-positive, expected move, trend, nearest levels.
2. get_events: results before the expiry → IV is event-inflated; never call premium rich on it.
3. Fit:
   - **Favourable**: VRP > 0, realized VRP positive most days, no results, no strong trend (5- and 20-day returns small).
   - **Against**: VRP < 0 (the stock moves more than the options pay), a 20-day trend, results inside the expiry.
4. Strikes: name the desk-norm strikes from get_chain (about 0.6 SD each side, liquid, two-sided quotes) and where they sit against the levels. A level just beyond a short strike is a good sign; one just inside it is not.

## Answer shape
- Headline: "**Fits: VRP +4.2, IV rank 61, no results before 25 Nov.**" or "**Not now: VRP −6, stock up 9% in 20 days.**"
- ### Strikes — short call and put, % from spot, premium (from get_chain).
- ### Risk — expected move vs the strikes; results date if any.

## Guardrails
- Under 60 days of vol history: say the vol figures are thin.
- Advisory only. Never say "sell"; say "fits the desk's entry" or "does not".
