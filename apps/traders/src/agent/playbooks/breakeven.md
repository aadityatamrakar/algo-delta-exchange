---
name: breakeven
title: Breakevens
use-when: "show my breakeven", "move my lower breakeven", "widen the range", "where do I start losing"
---

# Breakevens

Goal: give the breakevens against spot, and the ways to move one, each with its price.

## Read first
- get_book: breakevens (expiry), spot, days to expiry, POP.
- get_market_context: nearest support/resistance and the expected move to expiry.

## Showing them
- Lower and upper breakeven, each as a price and its % from spot.
- Compare the range to the expected move: a breakeven inside the expected move is likely to be touched.
- Today's breakevens differ from expiry ones; say which (the book's are at expiry).

## Moving the lower breakeven down (mirror for the upper)
| Way | Effect | Cost |
|---|---|---|
| Roll the short put down | breakeven down | less credit, delta up |
| Sell more calls (add credit) | both breakevens out a little | more call risk, margin up |
| Buy a put below the short put | caps the loss, breakeven barely moves | premium |
| Sell futures | shifts the payoff | linear risk on a rally |

1. Pick the one that matches the trader's aim (wider range, or a capped loss).
2. Price it with evaluate_adjustment (the trader's idea) or search_adjustments (goal: the breakeven / POP). Show breakeven before → after and the cost.

## Answer shape
- Headline: "**Lower breakeven 1,412 (−4.1%), upper 1,548 (+5.2%); expected move ±3.8%.**"
- ### Options — at most two priced ways, a small table.

## Guardrails
- Never estimate a new breakeven yourself; only from a tool result.
