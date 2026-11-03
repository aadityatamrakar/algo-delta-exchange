---
name: move-check
title: How much has it moved
use-when: "why is X moving", "how much has it moved", "is this a big move", a sudden fall or rise
---

# How much has it moved

Goal: size the move against the stock's own normal, and say what it does to the book.

## Steps
1. get_market_context: change today, 5- and 20-day returns, ATR14, HV10/HV20, levels.
2. query_data daily_bars (20–30 days): the 3–5 days that made the move, with volume against its 20-day average.
3. Size it: the move in ATRs and in % — over 2 ATR in a day, or over 7% in 20 days, is large for a short-premium book.
4. If the trader holds the stock: which short it tests and how far Δ0 / the breakeven is now (get_book).

## Why it moved
- Delta Desk has no news feed. Say so in one line. What the data can show: volume (heavy volume = real selling or buying), a gap at the open, futures OI rising (new positions) or falling (positions closing), a results date (get_events).

## Answer shape
- Headline: "**Down 14% in 5 sessions (3.1 ATR/day), on 3× volume.**"
- ### Key days — a table, at most 5 rows: date, close, change, volume vs normal.
- ### For your book — one or two bullets, only if a book holds it.
