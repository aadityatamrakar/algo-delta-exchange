---
name: book-review
title: Book review
use-when: the trader asks about one book — "tell me about the book", "how is TCS", "what's your view", "is it safe"
---

# Book review

Goal: in a few lines, tell the trader where the book stands and the one thing that can hurt it.

## Read first
1. get_book — legs, delta, Δ0, breakevens, max loss, POP, days to expiry, P&L, Today, band.
2. get_market_context — spot, nearest support and resistance, trend, ATR, IV rank, VRP.
3. get_events only when results fall before the near expiry (the context says so).

## Check in this order
1. **Tested side.** Spot against each short strike and each breakeven, in % and in ATR. A short within 1 ATR of spot, or in the money, is the tested side.
2. **Delta.** Lots against the book's band. Outside the band, or more than half the band with spot moving the same way, is a flag.
3. **Move since entry.** From get_track_record's open-series row or the daily bars: a move of 7% or more from where the series was opened is a trend month (see desk-record).
4. **Days left.** Under 7 days with a short near the money: expiry risk (see expiry-week).
5. **Vol.** VRP negative = the stock is moving more than the options pay for; say it hurts the short side.
6. **Size.** Margin and max loss against the book's usual. Only when one stands out.

## Answer shape
- Headline: the state in one line — "**Holding, call side tested: spot 2% under the 2600 CE, 9 days left.**"
- ### Position — P&L, Today, delta (lots), Δ0 vs spot. Four bullets at most.
- ### Risk — the one biggest risk and its rupee size (max loss or the shock).
- ### Watch — the price that changes the view (a short strike, a level, Δ0).
- Stop there. Offer adjustments only when asked, or when the risk check found a flag — then name the first step of the adjust playbook in one line.

## Guardrails
- "View" means the book's state and risk, not a market call. Never predict direction.
- Levels only from get_market_context. If none, say so.
- Never list every leg. Name a leg (L3) only when it is the risk.
