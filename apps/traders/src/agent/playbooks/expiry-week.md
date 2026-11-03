---
name: expiry-week
title: Expiry week and delivery
use-when: under 7 days to expiry, a short option in or near the money, "what happens at expiry", delivery, index weekly expiry
---

# Expiry week and delivery

Goal: show what expiry does to the book and what it costs to avoid it.

## Facts
- NSE stock options settle by **physical delivery**: an in-the-money short becomes shares (short call → short shares, short put → long shares) at the strike.
- Gamma is highest in the last days: a small move flips a near-the-money short from worthless to a full loss.
- F&O trades until 15:40 on expiry day; the cash market closes at 15:30.
- Desk record: series still holding shorts at the expiry close won 46% (median −₹25k); series closed earlier won 80% (median +₹23k). Most series are flat a median 13 days before expiry.

## Steps
1. get_book: days to expiry; every short within 2% of spot or in the money.
2. For each: shares that would be delivered (lots × lot size) and their value at spot — say the cash or margin that needs.
3. Ways out, priced with the tools: close or roll the short (needs "Allow closing legs" for a plan, or evaluate it as the trader's idea), or buy the same-strike option to flatten.
4. Index weeklies: cash-settled, no delivery, but expiry-day gamma is the same — size the shock from get_book.

## Answer shape
- Headline: "**2 days left; L3 short 435 PE is ITM → 18,375 shares (₹73 L) on delivery.**"
- ### Exposure — each risky short: strike, distance, shares.
- ### Ways out — at most two, with cost.

## Guardrails
- Do-not-exercise and STT on exercise are not modelled: say so when an ITM long matters.
