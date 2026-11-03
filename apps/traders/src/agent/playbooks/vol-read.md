---
name: vol-read
title: Reading volatility
use-when: questions on IV, IV rank, IV percentile, VRP, HV, "is vol cheap", "which side of VRP makes sellers money"
---

# Reading volatility

Goal: answer the vol question in plain words, then with this stock's figures if one is named.

## The terms (one line each)
- **IV**: the move the options are pricing, yearly %.
- **HV10 / HV20**: the move the stock actually made over 10 / 20 days, yearly %.
- **VRP = IV − HV20**: positive = options pay more than the stock has been moving. Sellers want it positive.
- **Realized VRP**: IV at the time minus the move that came after. Its %-positive says how often selling paid on this stock.
- **IV rank**: where today's IV sits between the year's low (0) and high (100).
- **IV percentile**: % of the year's days with IV below today. Rank is moved by one spike; percentile is not.
- **Event-inflated IV**: results before expiry lift near IV; a high rank then does not mean rich.

## The two-line rule
Sellers make money when IV stays above the move the stock delivers (VRP positive).
When the stock moves more than IV priced (VRP negative), short options lose.

## With a stock named
- get_market_context: IV, HV10, HV20, VRP and its percentile, realized-VRP %-positive, IV rank and percentile.
- HV10 well below HV20 means the big moves are 10–20 days old and VRP should improve as they roll off; say so.
- Results inside the near expiry (results.inNear): say the IV is event-inflated.

## Answer shape
- Concept questions: the two-line rule, or three bullets at most. No headings.
- Stock questions: headline verdict ("**Rich: VRP +5.1, rank 72, no results.**") + a 4-row table (IV, HV20, VRP, IV rank).
