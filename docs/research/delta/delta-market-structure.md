# Delta India BTC options — market structure (sub-agent report relayed 2026-11-03)
- Lot 0.001 BTC; price USD per BTC (lot cost = price/1000); tick $0.10; balances INR at fixed 1 USD = 85 INR (guides.delta.exchange account-setup/usd-inr-rate).
- European, cash-settled vs 30-min TWAP of index; all options settle 17:30 IST (12:00 UTC). New dailies list at 17:30 IST then 5-min auction.
- Live chain 3 Nov: 3 dailies (3,4,5 Nov), Fridays 6/13/20 Nov, monthlies 27 Nov, 25 Dec, 29 Jan.
- Strikes live: dailies 200 near ATM / 400 wings (25-28 strikes); weeklies 500 / 1000 (21-33); monthlies 1000 (32-43). Guide table (D1 200, D2 250, W 1000, M1 1000, M2 2000, M3 5000) is stale.
- Fees: 0.01% notional, cap 3.5% of premium, +18% GST; settlement fee at taker rate on contracts open at expiry (cap UNCONFIRMED). Liquidation fee min(50% premium, 0.25% notional).
- Margin: isolated / cross / portfolio (SPAN-like, 29 scenarios; short-option floor Σ max(5% premium, OM% notional) OM 0.5%→2%; maintenance 75% of initial). Liquidation: cancel orders → perp delta hedge (≥$100k) → scale down.
- 24/7/365; maintenance announced ≥24h ahead (cancel-only → frozen → auction). Trading up to settlement UNCONFIRMED.
- Order types: limit, market, stop-market, stop-limit, trailing, TP, bracket; GTC/IOC; post-only; reduce-only; MMP; batch 50. Stops/brackets on options UNCONFIRMED.
- Hosts: testnet REST https://cdn-ind.testnet.deltaex.org; WS wss://socket-ind.testnet.deltaex.org, wss://socket-ind-pub.testnet.deltaex.org; prod WS wss://socket.india.delta.exchange. api.delta.exchange = Global, rejects India keys. WS: 150 connections / 5 min / IP.
- MOVE straddle contracts (MV-BTC) exist per guide; listing UNCONFIRMED.
Snapshot 2026-11-03 07:15 UTC, spot $76,592 (USD per BTC):
| Contract | bid/ask | spread | IV | OI |
| D 3 Nov 76600 C/P | 212/215, 209/212 | $3 | 29.7/29.4 | 28.7k/62.6k |
| D 4 Nov 76600 C/P | 808/813, 793/798 | $5 | 46.2/45.4 | 2.6k/2.7k |
| W 6 Nov 76500 C/P | 1199/1206, 1061/1069 | $7-8 | 40.4/39.1 | 5.0k/2.8k |
| M 27 Nov 77000 C/P | 2659/2715, 2767/2822 | $55 | 36.5/32.9 | 10.6k/12.6k |
Top-of-book depth ~4-15k contracts. BTC OI ~$614M notional; 24h ~$2.78B. Deribit DVOL 39.4 (30d 35.7-44.3); India VIX 15.9. Calls>puts IV on longer expiries → Delta IV likely vs spot not forward; average C/P for ATM.
Raw: scratchpad/dl, scratchpad/api/tickers.json
