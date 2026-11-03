# Strategy Sheet

*Generated 2026-07-25 from `slive-strategies.csv` (156 production strategies) and `legacy-strategies.csv` (408 legacy files). The CSVs are the authoritative, spreadsheet-importable version; this file is the readable rendering.*

> **Reading the `execution` column.** `PaperTrade` is the **order bus**, not paper
> trading — `server/tools/xtsOrder.js:306-309` forwards bus orders to real brokers. So
> `bus-routed` means "emitted onto the order bus"; whether it becomes a real broker order
> depends on which forwarding daemons are running, **not** on the strategy code. `live` means
> the strategy calls `Account.placeAllAccount` (Zerodha, direct and synchronous). See
> `../01-system-overview.md` §2.

## Summary

- **156** production strategy files in `server/slive/` (37,564 LOC)
- **408** files across the 9 legacy directories
- **15-18** genuinely distinct trading ideas across all of it

**Maturity**

| Value | Files |
|---|---|
| active | 144 |
| modern | 10 |
| unknown | 1 |
| legacy | 1 |

**Execution rail**

| Value | Files |
|---|---|
| bus-routed (paper) | 86 |
| live | 55 |
| live entry (Zerodha) + bus-routed SL | 6 |
| n/a | 3 |
| bus-routed (paper(trackOrder v1)) | 3 |
| bus-routed (paper+XTS hybrid) | 1 |
| bus-routed (paper (Positional model, not PaperTrade)) | 1 |
| bus-routed (paper (Positional model)) | 1 |

**Underlying**

| Value | Files |
|---|---|
| BANKNIFTY | 104 |
| NIFTY | 17 |
| SENSEX | 13 |
| FINNIFTY | 6 |
| MIDCPNIFTY | 6 |
| - | 4 |
| BANKNIFTY(default) | 2 |
| BANKNIFTY,NIFTY,SENSEX | 1 |
| BANKNIFTY,NIFTY,SENSEX (per wrapper) | 1 |
| BANKNIFTY(default optionConfig) | 1 |
| BANKNIFTY+others(mirrors optionbhai signals) | 1 |

## Families in `server/slive` (by file count)

| Family | Files | Underlyings | Execution |
|---|---|---|---|
| `bull-s` | 11 | BANKNIFTY, FINNIFTY, MIDCPNIFTY, NIFTY, SENS | bus-routed (paper) |
| `eagle-s` | 11 | BANKNIFTY, FINNIFTY, MIDCPNIFTY, NIFTY, SENS | bus-routed (paper) |
| `lion` | 9 | BANKNIFTY | bus-routed (paper) |
| `stgl-mid` | 9 | BANKNIFTY | live |
| `cp-momentum` | 9 | BANKNIFTY, NIFTY, SENSEX | bus-routed (paper) |
| `rv-roll` | 7 | BANKNIFTY, NIFTY | bus-routed (paper), live |
| `lion-s25` | 6 | BANKNIFTY, FINNIFTY, MIDCPNIFTY, NIFTY | live entry (Zerodha) + bus-routed SL |
| `lion-st15` | 6 | BANKNIFTY | live |
| `lion-fixedsl` | 6 | BANKNIFTY, NIFTY, SENSEX | live |
| `ce-d2-spread` | 6 | BANKNIFTY | bus-routed (paper (Positional model)), |
| `orb-fut` | 5 | -, BANKNIFTY, BANKNIFTY,NIFTY,SENSEX (per wr | bus-routed (paper), n/a |
| `cheetah-trail-sell` | 5 | BANKNIFTY | live |
| `hft-averaging` | 4 | BANKNIFTY, NIFTY, SENSEX | bus-routed (paper) |
| `bull-wing` | 4 | BANKNIFTY, NIFTY | bus-routed (paper) |
| `samlion` | 4 | BANKNIFTY | live |
| `dolphin` | 3 | BANKNIFTY, NIFTY | live |
| `snx-orb` | 3 | SENSEX | live |
| `candlestrategy-mirror` | 3 | -, BANKNIFTY+others(mirrors optionbhai signa | bus-routed (paper) |
| `cheetah-changestream-sell` | 3 | BANKNIFTY | bus-routed (paper) |
| `cheetah-b1-buy` | 3 | BANKNIFTY, SENSEX | live |
| `stgl-s` | 3 | BANKNIFTY | bus-routed (paper), live |
| `p718-supertrend` | 3 | BANKNIFTY | live |
| `atr-band` | 2 | NIFTY | bus-routed (paper), n/a |
| `orb-scalp` | 2 | -, BANKNIFTY,NIFTY,SENSEX | bus-routed (paper), n/a |
| `cal-ce/pe` | 2 | BANKNIFTY, BANKNIFTY(default optionConfig) | bus-routed (paper(trackOrder v1)) |
| `bull-m` | 2 | BANKNIFTY | bus-routed (paper) |
| `stgl-p` | 2 | BANKNIFTY | live |
| `rv-vol` | 2 | BANKNIFTY | bus-routed (paper) |
| `p718-schedule` | 2 | BANKNIFTY | bus-routed (paper) |
| `jk-changestream` | 2 | BANKNIFTY | bus-routed (paper) |
| `bn-breakout` | 1 | BANKNIFTY | bus-routed (paper) |
| `lion-strangle(biglion)` | 1 | BANKNIFTY | bus-routed (paper) |
| `fox` | 1 | BANKNIFTY | live |
| `fut-100` | 1 | BANKNIFTY(default) | bus-routed (paper+XTS hybrid) |
| `target-15` | 1 | BANKNIFTY(default) | bus-routed (paper(trackOrder v1)) |
| `lion-up` | 1 | BANKNIFTY | live |
| `lion-b25` | 1 | BANKNIFTY | live |
| `lion-sp5` | 1 | BANKNIFTY | live |
| `cheetah-fixed-sl-sell` | 1 | BANKNIFTY | live |
| `cheetah-trail-buy` | 1 | BANKNIFTY | live |
| `cheetah-b1-buy-hybrid` | 1 | BANKNIFTY | live |
| `hft-reversal-straddle` | 1 | SENSEX | bus-routed (paper) |
| `bull-r` | 1 | BANKNIFTY | bus-routed (paper) |
| `bull-x` | 1 | BANKNIFTY | bus-routed (paper) |
| `bull-200` | 1 | BANKNIFTY | bus-routed (paper) |
| `eagle-p` | 1 | BANKNIFTY | bus-routed (paper) |
| `jk-live` | 1 | BANKNIFTY | live |

## Full production strategy table

| File | Family | Status | Underlying | Type | Execution | Entry trigger | Exit rules | Key config | LOC |
|---|---|---|---|---|---|---|---|---|---|
| `atr-band-logic.js` | atr-band | modern | NIFTY | logic-lib | n/a | n/a (pure functions: wilderATR/bandWidth/lines/entrySignal/target/stopHitOnClose) | - | - | 69 |
| `atr-band-nifty.js` | atr-band | modern | NIFTY | option-buy | bus-routed (paper) | 2 consecutive 5-min candles both green/red closing beyond ATR-based band from 11:35-11:40 anchor | target min(entry+20,entry*1.3) \| 60min time-stop \| far-line candle-close stop \| EOD 15:15 | atrPeriod=14 widthDivisor=3 targetPts=20 targetPct=0.30 timeStopMin=60 lots=1 strikeStep=50 | 346 |
| `bn-breakout.js` | bn-breakout | modern | BANKNIFTY | option-buy | bus-routed (paper) | 5-min candle body closes beyond +-0.09% band from 09:15-09:20 close (color-matched) | target entryPremium+45 \| 90min time-stop \| opposite-line spot stop \| EOD 15:15 | offsetPct=0.0009 targetPts=45 timeStopMin=90 lots=1 strikeStep=100 | 323 |
| `bull-200-1.js` | bull-200 | active | BANKNIFTY | option-sell | bus-routed (paper) | one-shot at start: for each of 4 target premiums (200/160/130/100), find the strike whose live price is closest and sell | Each leg has an absolute Rs50 stop (entry+50); on breach, buys back just that leg and re-sells a fresh same-type leg at  | premium targets=[200,160,130,100], absolute sl=+Rs50/leg | 183 |
| `bull-m.js` | bull-m | active | BANKNIFTY | option-sell | bus-routed (paper) | ATM crossover of token 260105; sells CE at atm+100/200/300 and PE at atm-100/200/300 | independent per-side stop: spot crossing atm+100 buys back only the 3 CE legs (or atm-100 for the 3 PE legs) then re-sel | offsets=[100,200,300] both sides | 171 |
| `bull-m2.js` | bull-m | active | BANKNIFTY | option-sell | bus-routed (paper) | same as bull-m.js | same as bull-m.js | offsets=[100,200,300] both sides | 171 |
| `bull-r.js` | bull-r | active | BANKNIFTY | option-sell | bus-routed (paper) | ATM crossover of token 260105; sells one CE+PE OTM pair at farOtm distance per new ATM strike | 25% combined-premium stop per strike-level position closes just that strike's pair; position size starts at 7 lots and d | sl_percent=1.25 (implied by 1.25x trigger); currentSize starts at 7, -1 per entry | 178 |
| `bull-fs-1.js` | bull-s | active | FINNIFTY | option-sell | bus-routed (paper) | same engine as bull-s-1.js retargeted to FINNIFTY (token 257801) | same as bull-s-1.js | sl_percent=1.25; farOtm=0 | 177 |
| `bull-fs-2.js` | bull-s | active | FINNIFTY | option-sell | bus-routed (paper) | same as bull-fs-1.js | same as bull-fs-1.js | sl_percent=1.25; farOtm=0 | 177 |
| `bull-ms-1.js` | bull-s | active | MIDCPNIFTY | option-sell | bus-routed (paper) | same engine retargeted to MIDCPNIFTY (token 288009) | same as bull-s-1.js | sl_percent=1.25; farOtm=0 | 177 |
| `bull-ms-2.js` | bull-s | active | MIDCPNIFTY | option-sell | bus-routed (paper) | same as bull-ms-1.js | same as bull-ms-1.js | sl_percent=1.25; farOtm=0 | 177 |
| `bull-ns-1.js` | bull-s | active | NIFTY | option-sell | bus-routed (paper) | same engine retargeted to NIFTY (token 256265) | same as bull-s-1.js | sl_percent=1.25; farOtm=0 | 177 |
| `bull-ns-2.js` | bull-s | active | NIFTY | option-sell | bus-routed (paper) | same as bull-ns-1.js | same as bull-ns-1.js | sl_percent=1.25; farOtm=0 | 177 |
| `bull-s-1.js` | bull-s | active | BANKNIFTY | option-sell | bus-routed (paper) | ATM crossover of token 260105; sells a plain ATM straddle (farOtm forced 0, otmSelector() commented out) | 25% combined-premium stop -> buy back, re-sell fresh at current ATM with position size +1 lot vs the last cycle (pyramid | sl_percent=1.25 (25% stop); farOtm=0 (true ATM straddle, not OTM strangle) | 177 |
| `bull-s-2.js` | bull-s | active | BANKNIFTY | option-sell | bus-routed (paper) | same as bull-s-1.js | same as bull-s-1.js | sl_percent=1.25; farOtm=0 | 177 |
| `bull-s5-1.js` | bull-s | active | BANKNIFTY | option-sell | bus-routed (paper) | same engine as bull-s-1.js | 5% combined-premium stop (vs bull-s-1's 25%) -> buy back, re-sell with size+1 | sl_percent=1.05; farOtm=0 | 177 |
| `bull-s5-2.js` | bull-s | active | BANKNIFTY | option-sell | bus-routed (paper) | same as bull-s5-1.js | same as bull-s5-1.js | sl_percent=1.05; farOtm=0 | 177 |
| `bull-snx-1.js` | bull-s | active | SENSEX | option-sell | bus-routed (paper) | same engine as bull-s-1.js retargeted to SENSEX (token 265) | same as bull-s-1.js | sl_percent=1.25 (matches bull-s-1's scheme); farOtm=0 | 178 |
| `bull-300.js` | bull-wing | active | BANKNIFTY | option-sell | bus-routed (paper) | ATM crossover (round 100) of token 260105; sells CE at atm+300/400/500 and PE at atm-300/400/500 all at once | spot crosses atm+-300 (innermost wing) -> buy back all 6 legs, immediately re-sell fresh 6 at new ATM | offsets=[300,400,500] both sides | 161 |
| `bull-300i.js` | bull-wing | active | BANKNIFTY | option-sell | bus-routed (paper) | same ATM crossover trigger as bull-300.js but sells PE at atm+300/400/500 and CE at atm-300/400/500 -- ITM legs instead  | same roll-the-whole-basket mechanism as bull-300.js | offsets=[300,400,500], CE/PE sides swapped vs bull-300.js | 161 |
| `bulln-300.js` | bull-wing | active | NIFTY | option-sell | bus-routed (paper) | same as bull-300.js retargeted to NIFTY | same as bull-300.js | offsets=[300,400,500] both sides | 161 |
| `bulln-300i.js` | bull-wing | active | NIFTY | option-sell | bus-routed (paper) | same as bull-300i.js retargeted to NIFTY | same as bull-300i.js | offsets=[300,400,500], sides swapped | 161 |
| `bull-x.js` | bull-x | active | BANKNIFTY | option-sell | bus-routed (paper) | ATM crossover of token 260105; sells 3 ATM/atm+300/atm-300 straddle pairs at once | spot reaching the far +300 or -300 strike buys back the OPPOSITE far strike's pair and rolls the whole 3-strike ladder + | 3 straddle pairs, 300pt spacing, continuous rolling ladder | 180 |
| `cal-ce.js` | cal-ce/pe | active | BANKNIFTY(default optionConfig) | option calendar | bus-routed (paper(trackOrder v1)) | single CronJob fire at 09:25: BUY current-week ATM CE, SELL next-week ATM CE | none visible (no SL/target/EOD - fire-and-forget calendar spread) | one-shot at 09:25 | 116 |
| `cal-pe.js` | cal-ce/pe | active | BANKNIFTY | option calendar | bus-routed (paper(trackOrder v1)) | same as cal-ce.js but PE leg | none visible | one-shot at 09:25 | 116 |
| `candlestrategy-a006.js` | candlestrategy-mirror | active | - | option | bus-routed (paper) | (same as candlestrategy.js) | (same) | user=LIVE002 tag=A006 | 132 |
| `candlestrategy-test3.js` | candlestrategy-mirror | active | - | option | bus-routed (paper) | (same) | (same) | user=test3 tag=EMA2050 | 132 |
| `candlestrategy.js` | candlestrategy-mirror | active | BANKNIFTY+others(mirrors optionbhai signals) | option | bus-routed (paper) | WebSocket ORDER_EXECUTION message from optionbhai.com with status EXECUTED | none (exit orders also arrive as mirrored EXECUTED messages) | LOGIN_CREDS user=LIVE001 tag=1PBUY | 132 |
| `ce-d2-0020.js` | ce-d2-spread | active | BANKNIFTY | option ratio/credit sp | bus-routed (paper) | scans a ladder of CE strike-pairs (near/far offsets from day_config[0..3]) via live order-book bid/ask depth; buys the n | Closes (reverse trade) when the spread's live value decays below its entry-minus-profit(15) target; frees pending_qty fo | pending_qty=20, per_trade_qty=2, ratio=2, profit=15, per_trade_jump=0.25, day_config=otmSelector('SD_2') | 190 |
| `ce-d2-extra.js` | ce-d2-spread | active | BANKNIFTY | option ratio/credit sp | bus-routed (paper) | same as ce-d2-0020.js | same as ce-d2-0020.js | pending_qty=50 (vs 0020's 20), otherwise identical | 190 |
| `ce-d2p-extra.js` | ce-d2-spread | active | BANKNIFTY | option ratio/credit sp | bus-routed (paper (Positional mode | same spread-scanning entry as ce-d2-extra.js | same target-decay exit logic; PLUS full state (optionOrders/pending_qty/current_spread) persisted to a StrategyData DB r | pending_qty=20, profit=25 (vs extra's 15), persisted via StrategyData | 216 |
| `pe-d2-0020.js` | ce-d2-spread | active | BANKNIFTY | option ratio/credit sp | bus-routed (paper) | same scanner as ce-d2-0020.js but on PE strikes | same as ce-d2-0020.js | pending_qty=20, per_trade_qty=2, ratio=2, profit=15 | 190 |
| `pe-d2-extra.js` | ce-d2-spread | active | BANKNIFTY | option ratio/credit sp | bus-routed (paper) | same as pe-d2-0020.js | same as pe-d2-0020.js | pending_qty=50 | 190 |
| `pe-d2p-extra.js` | ce-d2-spread | active | BANKNIFTY | option ratio/credit sp | bus-routed (paper (Positional mode | same as ce-d2p-extra.js | same as ce-d2p-extra.js | pending_qty=20, profit=25, persisted via StrategyData | 217 |
| `cheetah-b1-1.js` | cheetah-b1-buy | active | BANKNIFTY | option | live | BUY far-OTM CE/PE in momentum direction (like bt-2117), farOtm via otmSelector | fixed SL (entry-10) and fixed target (entry+90) per leg; on SL, flips side and re-enters; quantity scales +1 per re-entr | trail_sl=10, target_points=90, qty cap 12 | 186 |
| `cheetah-b1-2.js` | cheetah-b1-buy | active | BANKNIFTY | option | live | same as cheetah-b1-1.js | same as cheetah-b1-1.js | trail_sl=10, target_points=90, qty cap 12 | 186 |
| `cheetah-b1-snx.js` | cheetah-b1-buy | active | SENSEX | option | live | same BUY-momentum logic as cheetah-b1-1.js | same fixed SL(-10)/target(+90) + qty-scaling martingale, no EOD cron kill | trail_sl=10; target_points=90; qty cap 12 | 174 |
| `cheetah-b1-2117.js` | cheetah-b1-buy-hybrid | active | BANKNIFTY | option | live | BUY far-OTM CE/PE in momentum direction, same as b1-1, plus Wed next-week-expiry roll logic | fixed SL(entry-10) per leg (no fixed target); uncapped qty martingale (+1 every re-entry no cap); portfolio breaker TGT> | trail_sl=10, portfolio TGT=+5000/SL=-12500, qty uncapped | 251 |
| `cheetah-0042.js` | cheetah-changestream-sell | active | BANKNIFTY | option | bus-routed (paper) | same as cheetah-2117.js | fixed SLM stop (entry+30) via change-stream; re-entry-after-SL block present but COMMENTED OUT (disabled) | trail_sl=30 | 215 |
| `cheetah-2117.js` | cheetah-changestream-sell | active | BANKNIFTY | option | bus-routed (paper) | SELL far-OTM CE/PE opposite momentum, same direction logic as 1910 | fixed SLM stop order (entry+30) placed via OrderUpdate change-stream watcher; on SL fill, re-enters flipped side up to m | trail_sl=30, max_sl_times=3 (ACTIVE re-entry) | 216 |
| `cheetah-2204.js` | cheetah-changestream-sell | active | BANKNIFTY | option | bus-routed (paper) | same as cheetah-2117.js | fixed SLM stop (entry+30) via change-stream; re-entry-after-SL block present but COMMENTED OUT (disabled) | trail_sl=30 | 216 |
| `cheetah-s-2203.js` | cheetah-fixed-sl-sell | active | BANKNIFTY | option | live | same momentum-opposite SELL logic as 1910 | fixed (non-trailing) SL at entry+30; no portfolio-level PNL breaker at all (checkPNL/fetchPositions removed entirely) | trail_sl=30 | 165 |
| `cheetah-bt-2117.js` | cheetah-trail-buy | unknown | BANKNIFTY | option | live | BUY far-OTM CE/PE in direction of momentum (CE if spot>open) -- opposite bias to 1910's sell-side | trailing SL from post-entry high; portfolio breaker on TGT>+2500 flattens via Account.trackOrder | trail_sl=60, portfolio TGT=+2500 | 235 |
| `cheetah-1910.js` | cheetah-trail-sell | active | BANKNIFTY | option | live | momentum: SELL far-OTM CE if spot<open else PE, farOtm via otmSelector | trailing SL from post-entry low (60pt); flip side & re-sell on SL; portfolio SL -2500 flattens all via Account.trackOrde | trail_sl=60, portfolio SL=-2500 | 236 |
| `cheetah-1911.js` | cheetah-trail-sell | active | BANKNIFTY | option | live | same as cheetah-1910.js | same as cheetah-1910.js | trail_sl=60, portfolio SL=-2500 | 236 |
| `cheetah-1963.js` | cheetah-trail-sell | active | BANKNIFTY | option | live | same as cheetah-1910.js | trailing SL 60pt; portfolio breaker flipped to TGT>+2500 (not SL); checkPNL() call is commented out so this breaker is d | trail_sl=60, portfolio TGT=+2500 (unreachable, disabled) | 246 |
| `cheetah-st-60.js` | cheetah-trail-sell | active | BANKNIFTY | option | live | same as cheetah-1910.js | trailing SL 60pt; portfolio breaker flipped to TGT>+2500 instead of SL<-2500 (checkPNL still called, so this breaker IS  | trail_sl=60 (matches its name) | 233 |
| `cheetah-stp-2117.js` | cheetah-trail-sell | active | BANKNIFTY | option | live | SELL, but strike chosen by nearest-premium-to-Rs250 scan across all strikes instead of fixed farOtm point offset | trailing SL 60pt (same mechanic as 1910); portfolio checkPNL disabled (commented out) | target premium ~250 | 191 |
| `cp-b-2040.js` | cp-momentum | active | BANKNIFTY | option (single leg) | bus-routed (paper) | BankNifty spot breaks +-20pts from a base price set at start; buys (not sells) the ATM option opposite the usual cp conv | SL/target via SLM+limit order pair (sl_percent=0.80 below entry, target_percent=1.40 above) placed after fill through Or | breakoutLevel=20, sl_percent=0.80, target_percent=1.40 (BUY-side math) | 359 |
| `cp-ns-2040.js` | cp-momentum | active | NIFTY | option (single leg) | bus-routed (paper) | NIFTY spot breaks +-20pts from base; sells the option opposite momentum (PE on up-break, CE on down-break) | SL 1.20x / target 0.60x combined via SLM+limit; reverses on either exit, stops after -2 losses or +1 win | breakoutLevel=20, sl_percent=1.20, target_percent=0.60 | 359 |
| `cp-rs-030.js` | cp-momentum | active | BANKNIFTY | option (single leg) | bus-routed (paper) | BankNifty breaks +-3pts from base; sells the SAME-direction option (CE on up-break) -- CE/PE assignment flipped vs cp-s- | SL 1.03x / target 0.97x combined via SLM+limit; same win/loss counter cap | breakoutLevel=3, sl_percent=1.03, target_percent=0.97 (side flipped) | 359 |
| `cp-s-010.js` | cp-momentum | active | BANKNIFTY | option (single leg) | bus-routed (paper) | BankNifty breaks +-3pts from base; sells opposite-momentum option | SL 1.03x / target 0.99x (tighter target than cp-s-030's 0.97x) via SLM+limit; win/loss counter cap | breakoutLevel=3, sl_percent=1.03, target_percent=0.99 | 359 |
| `cp-s-030.js` | cp-momentum | active | BANKNIFTY | option (single leg) | bus-routed (paper) | BankNifty spot breaks +-3pts from a base price set 10s after start; sells the option OPPOSITE momentum (PE on up-break,  | SL 3% / target 3% combined via SLM+limit order pair, placed after fill via OrderUpdate change-stream; reverses direction | breakoutLevel=3, sl_percent=1.03, target_percent=0.97 | 359 |
| `cp-s-2040.js` | cp-momentum | active | BANKNIFTY | option (single leg) | bus-routed (paper) | BankNifty breaks +-20pts from base; sells opposite-momentum option | SL 1.20x / target 0.60x (wider breakout trigger and looser SL/target than cp-s-030) | breakoutLevel=20, sl_percent=1.20, target_percent=0.60 | 359 |
| `cp-s-3370.js` | cp-momentum | active | BANKNIFTY | option (single leg) | bus-routed (paper) | BankNifty breaks +-50pts from base; sells opposite-momentum option | Absolute-point SL(33pts)/target(70pts) instead of percentage -- the only cp file using fixed points rather than a percen | breakoutLevel=50, sl_points=33, target_points=70 | 359 |
| `cp-snx-030.js` | cp-momentum | active | SENSEX | option (single leg) | bus-routed (paper) | SENSEX breaks +-3pts from base; sells opposite-momentum option | same SL/target math as cp-s-030.js | breakoutLevel=3, sl_percent=1.03, target_percent=0.97 | 359 |
| `cp-snx-2040.js` | cp-momentum | active | SENSEX | option (single leg) | bus-routed (paper) | SENSEX breaks +-20pts from base; sells opposite-momentum option | same SL/target math as cp-s-2040.js | breakoutLevel=20, sl_percent=1.20, target_percent=0.60 | 359 |
| `dolphin-0020.js` | dolphin | active | BANKNIFTY | option-sell | live | ATM(100-step) crossover of BANKNIFTY token 260105, farOtm=200 fixed OTM strangle | fixed target_profit=70 pts on combined premium; re-sell on next crossover; checkPNL() emergency exit if paper m2m>10000  | farOtm=200 target_profit=70 | 254 |
| `nifty-s-1789.js` | dolphin | active | NIFTY | option-sell | live | ATM(50-step) crossover of NIFTY token 256265, true ATM straddle (no OTM offset) | fixed target_profit=25 pts combined premium; re-sell on next crossover | target_profit=25 strikeStep=50 | 258 |
| `nifty-s-sbm95.js` | dolphin | active | NIFTY | option-sell | live | (same as nifty-s-1789.js) | (same) | target_profit=25 strikeStep=50 | 258 |
| `eagle-p-1.js` | eagle-p | active | BANKNIFTY | option-sell | bus-routed (paper) | same ATM-crossover trigger as eagle-s-1.js, but each add-trigger opens a full NEW CE+PE pair (doubling exposure per trig | NONE -- same no-exit design as eagle-s-1.js | premium floor=Rs20; adds a full pair (not 1 leg) per trigger | 205 |
| `eagle-fs-1.js` | eagle-s | active | FINNIFTY | option-sell | bus-routed (paper) | same engine as eagle-s-1.js retargeted to FINNIFTY (token 257801) | same as eagle-s-1.js (no exit) | premium floor=Rs20 (Rs10 per agent research on the 'ns' sibling; verify per-file) | 199 |
| `eagle-fs-2.js` | eagle-s | active | FINNIFTY | option-sell | bus-routed (paper) | same as eagle-fs-1.js | same as eagle-fs-1.js | premium floor=Rs20 | 199 |
| `eagle-ms-1.js` | eagle-s | active | MIDCPNIFTY | option-sell | bus-routed (paper) | same engine retargeted to MIDCPNIFTY (token 288009) | same as eagle-s-1.js (no exit) | premium floor=Rs20 | 199 |
| `eagle-ms-2.js` | eagle-s | active | MIDCPNIFTY | option-sell | bus-routed (paper) | same as eagle-ms-1.js | same as eagle-ms-1.js | premium floor=Rs20 | 199 |
| `eagle-ns-1.js` | eagle-s | active | NIFTY | option-sell | bus-routed (paper) | same engine retargeted to NIFTY (token 256265); premium floor lowered to Rs10 | same as eagle-s-1.js (no exit) | premium floor=Rs10 (vs Rs20 elsewhere) | 199 |
| `eagle-ns-2.js` | eagle-s | active | NIFTY | option-sell | bus-routed (paper) | same as eagle-ns-1.js | same as eagle-ns-1.js | premium floor=Rs10 | 199 |
| `eagle-s-1.js` | eagle-s | active | BANKNIFTY | option-sell | bus-routed (paper) | ATM crossover of token 260105 sells an initial CE+PE pair; as spot approaches within either leg's own premium distance,  | NONE -- no BUY order anywhere in the file; the only 'exit' is a >Rs20 premium floor gating new adds, and a commented-out | premium floor=Rs20 to add a new leg; no SL/target at all | 199 |
| `eagle-s-2.js` | eagle-s | active | BANKNIFTY | option-sell | bus-routed (paper) | same as eagle-s-1.js | same as eagle-s-1.js (no exit) | premium floor=Rs20 | 199 |
| `eagle-s-3.js` | eagle-s | active | BANKNIFTY | option-sell | bus-routed (paper) | same as eagle-s-1.js | same as eagle-s-1.js (no exit) | premium floor=Rs20 | 199 |
| `eagle-s-4.js` | eagle-s | active | BANKNIFTY | option-sell | bus-routed (paper) | same as eagle-s-1.js | same as eagle-s-1.js (no exit) | premium floor=Rs20 | 199 |
| `eagle-snx-1.js` | eagle-s | active | SENSEX | option-sell | bus-routed (paper) | same engine as eagle-s-1.js retargeted to SENSEX (token 265) | same as eagle-s-1.js (no exit) | premium floor=Rs20 | 201 |
| `fox-1.js` | fox | active | BANKNIFTY | option (CE+PE pair) | live | one-shot at start: sells pair if premium fell since candle open, else buys pair | trailing SL (trail_sl=60pts) with side-flip on hit; max 6 order count cap | farOtm=otmSelector('Cheetah') trail_sl=60 maxOrderCount=6 | 175 |
| `fut-100.js` | fut-100 | active | BANKNIFTY(default) | future | bus-routed (paper+XTS hybrid) | first +-15pt move from base future price (one-shot, isFirstTrade flag) | SL 50pts / target 100pts via trackOrder_slm/trackOrder_limit; reverses (multiplier=2) and re-arms SL/target on either hi | sl_points=50 target_points=100 multiplier=2 triggerLevel=15 | 284 |
| `bn-hft.js` | hft-averaging | active | BANKNIFTY | option | bus-routed (paper) | same synthetic-ATM straddle logic as hft-averaging.js | identical to hft-averaging.js | TARGET_POINTS=10, AVERAGING_TRIGGER=10, MAX_AVERAGING_STEPS=1, STRIKES=[0] | 878 |
| `hft-averaging.js` | hft-averaging | active | SENSEX | option | bus-routed (paper) | buy ATM synthetic straddle (CE+PE) computed via put-call parity mid-price; MAX_AVERAGING_STEPS=1 so no averaging actuall | exit whole pair when combined premium rises TARGET_POINTS above avg cost; global PROFIT_TARGET=3,000,000 stops strategy  | TARGET_POINTS=10, AVERAGING_TRIGGER=10, MAX_AVERAGING_STEPS=1, STRIKES=[0] | 878 |
| `hft-multi.js` | hft-averaging | active | SENSEX | option | bus-routed (paper) | same synthetic-ATM straddle buy across 3 strikes: ATM, +100, -100 | same target/averaging/profit-target mechanics as hft-averaging.js but averaging IS enabled | TARGET_POINTS=10, AVERAGING_TRIGGER=10, MAX_AVERAGING_STEPS=10, STRIKES=[-100,0,100] | 878 |
| `hft-nifty.js` | hft-averaging | active | NIFTY | option | bus-routed (paper) | same synthetic-ATM straddle logic as hft-averaging.js | same as hft-averaging.js, tighter target/trigger | TARGET_POINTS=5; AVERAGING_TRIGGER=5; MAX_AVERAGING_STEPS=1; STRIKES=[0] | 878 |
| `hft-snx-sell.js` | hft-reversal-straddle | active | SENSEX | option | bus-routed (paper) | synthetic-ATM straddle, starts LONG (BUY CE+PE), fixed qty=1, no averaging | target hit -> close and re-enter SAME direction; stoploss hit -> close and REVERSE direction (writes/sells the straddle  | TARGET_POINTS=10, STOPLOSS_POINTS=20, STRIKES=[0], re-entry delay 2s | 844 |
| `jk-0020.js` | jk-changestream | active | BANKNIFTY | option-sell | bus-routed (paper) | ATM crossover (round to 100) of token 260105; re-enter once CE/PE open count = 0 | Fixed SLM via PaperTrade.trackOrder_slm, change-stream fill state machine (same engine as lion-0020.js) | sl_percent=1.25 | 252 |
| `jk-zzJ4351.js` | jk-changestream | active | BANKNIFTY | option-sell | bus-routed (paper) | same as jk-0020.js | same as jk-0020.js | sl_percent=1.25 | 252 |
| `jk-m6000.js` | jk-live | active | BANKNIFTY | option-sell | live | ATM crossover (round to 100) of token 260105; re-enter once CE/PE open count = 0 | LIVE Account.placeAllAccount SELL entry; SL tracked in a local optionOrders array polled every tick AND mirrored via Pap | sl_percent=1.25 | 241 |
| `lion-0020.js` | lion | active | BANKNIFTY | weekly index options C | bus-routed (paper) | ATM crossover (round to 100) of spot index token 260105; re-enter strike once CE/PE open count = 0 | Fixed SLM via PaperTrade.trackOrder_slm at sl_percent, filled via OrderUpdate change-stream state machine (place_sl -> r | sl_percent=1.25, farOtm=otmSelector(), futureToken=260105 | 249 |
| `lion-1789.js` | lion | active | BANKNIFTY | weekly index options C | bus-routed (paper) | ATM crossover (round to 100) of token 260105; re-enter once CE/PE open count = 0 | Fixed SLM via PaperTrade.trackOrder_slm, change-stream fill state machine | sl_percent=1.25 | 247 |
| `lion-m6000.js` | lion | active | BANKNIFTY | weekly index options C | bus-routed (paper) | ATM crossover (round to 100) of token 260105; re-enter once CE/PE open count = 0 | Fixed SLM via PaperTrade.trackOrder_slm, change-stream fill state machine | sl_percent=1.25 | 249 |
| `lion-s15-zzJ4351.js` | lion | active | BANKNIFTY | weekly index options C | bus-routed (paper) | ATM crossover (round to 100) of token 260105; re-enter once CE/PE open count = 0 | Fixed SLM via PaperTrade.trackOrder_slm, change-stream fill state machine | sl_percent=1.15 (tighter than the 1.25 default) | 249 |
| `lion-zzJ4351-2.js` | lion | active | BANKNIFTY | weekly index options C | bus-routed (paper) | ATM crossover (round to 100) of token 260105; re-enter once CE/PE open count = 0 | Fixed SLM via PaperTrade.trackOrder_slm, change-stream fill state machine | sl_percent=1.25 | 249 |
| `lion-zzJ4351-3.js` | lion | active | BANKNIFTY | weekly index options C | bus-routed (paper) | ATM crossover (round to 100) of token 260105; re-enter once CE/PE open count = 0 | Fixed SLM via PaperTrade.trackOrder_slm, change-stream fill state machine | sl_percent=1.25 | 249 |
| `lion-zzJ4351-4.js` | lion | active | BANKNIFTY | weekly index options C | bus-routed (paper) | ATM crossover (round to 100) of token 260105; re-enter once CE/PE open count = 0 | Fixed SLM via PaperTrade.trackOrder_slm, change-stream fill state machine | sl_percent=1.25 | 249 |
| `lion-zzJ4351.js` | lion | active | BANKNIFTY | weekly index options C | bus-routed (paper) | ATM crossover (round to 100) of token 260105; re-enter once CE/PE open count = 0 | Fixed SLM via PaperTrade.trackOrder_slm, change-stream fill state machine | sl_percent=1.25 | 249 |
| `lion-zzj11574.js` | lion | active | BANKNIFTY | weekly index options C | bus-routed (paper) | ATM crossover (round to 100) of token 260105; re-enter once CE/PE open count = 0 | Fixed SLM via PaperTrade.trackOrder_slm, change-stream fill state machine | sl_percent=1.25 | 249 |
| `lion-b25-1.js` | lion-b25 | active | BANKNIFTY | weekly index options C | live | ATM crossover (round to 100) of token 260105; re-enter once CE/PE open count = 0 | Fixed trigger=entry*sl_percent checked each tick; live Account.placeAllAccount SELL to close when price rises above trig | sl_percent=1.25 (used as an exit trigger, not a stop, given the long/BUY entry), farOtm=otmSelector() | 198 |
| `lion-ns25-2.js` | lion-fixedsl | active | NIFTY | weekly index options C | live | ATM crossover (round to 50) of token 256265; re-enter once CE/PE open count = 0 | Fixed sl_trigger=entry*sl_percent checked each tick; live BUY to close on breach | sl_percent=1.25, farOtm=otmSelector() | 199 |
| `lion-s25-2.js` | lion-fixedsl | active | BANKNIFTY | weekly index options C | live | ATM crossover (round to 100) of dynamically-resolved current-future token (optionData.currentFuture.token); re-enter onc | Fixed sl_trigger=entry*sl_percent checked each tick; live BUY to close on breach | sl_percent=1.25, farOtm=otmSelector() | 199 |
| `lion-s25-2e.js` | lion-fixedsl | active | BANKNIFTY | weekly index options C | live | ATM crossover (round to 100) of hardcoded token 260105; re-enter once CE/PE open count = 0 | Fixed sl_trigger=entry*sl_percent checked each tick; live BUY to close on breach | sl_percent=1.25, farOtm forced to 0 (near-ATM, the 'E' variant) | 199 |
| `lion-s25-3.js` | lion-fixedsl | active | BANKNIFTY | weekly index options C | live | ATM crossover (round to 100) of hardcoded token 260105; re-enter once CE/PE open count = 0 | Fixed sl_trigger=entry*sl_percent checked each tick; live BUY to close on breach | sl_percent=1.25, farOtm=otmSelector() | 199 |
| `lion-s25-3e.js` | lion-fixedsl | active | BANKNIFTY | weekly index options C | live | ATM crossover (round to 100) of hardcoded token 260105; re-enter once CE/PE open count = 0 | Fixed sl_trigger=entry*sl_percent checked each tick; live BUY to close on breach | sl_percent=1.25, farOtm forced to 0 (near-ATM, 'E' variant) | 199 |
| `lion-snx-1.js` | lion-fixedsl | active | SENSEX | weekly index options C | live | ATM crossover (round to 100) of spot token 265; re-enter once CE/PE open count = 0 | Fixed sl_trigger=entry*sl_percent checked each tick; live Account.placeAllAccount BUY to close on breach | sl_percent=1.25, farOtm=otmSelector('Lion_SNX') | 199 |
| `lion-fs25-1.js` | lion-s25 | active | FINNIFTY | weekly index options C | live entry (Zerodha) + bus-routed  | ATM crossover (round to 50) of token 257801; re-enter once CE/PE open count = 0 | Same paper-only SL logging as lion-s25-1.js; no live exit order found | sl_percent=1.25; farOtm forced to 0 (near-ATM) | 231 |
| `lion-fs25-2.js` | lion-s25 | active | FINNIFTY | weekly index options C | live entry (Zerodha) + bus-routed  | ATM crossover (round to 50) of token 257801; re-enter once CE/PE open count = 0 | Same paper-only SL logging as lion-s25-1.js; no live exit order found | sl_percent=1.25; farOtm forced to 0 (near-ATM) | 231 |
| `lion-ms25-1.js` | lion-s25 | active | MIDCPNIFTY | weekly index options C | live entry (Zerodha) + bus-routed  | ATM crossover (round to 50) of token 288009; re-enter once CE/PE open count = 0 | Same paper-only SL logging as lion-s25-1.js; no live exit order found | sl_percent=1.25; farOtm forced to 0 (near-ATM) | 231 |
| `lion-ms25-2.js` | lion-s25 | active | MIDCPNIFTY | weekly index options C | live entry (Zerodha) + bus-routed  | ATM crossover (round to 50) of token 288009; re-enter once CE/PE open count = 0 | Same paper-only SL logging as lion-s25-1.js; no live exit order found | sl_percent=1.25; farOtm forced to 0 (near-ATM) | 231 |
| `lion-ns25-1.js` | lion-s25 | active | NIFTY | weekly index options C | live entry (Zerodha) + bus-routed  | ATM crossover (round to 50) of token 256265; re-enter once CE/PE open count = 0 | Same paper-only SL logging as lion-s25-1.js; no live exit order found | sl_percent=1.25; farOtm forced to 0 (near-ATM) | 231 |
| `lion-s25-1.js` | lion-s25 | active | BANKNIFTY | weekly index options C | live entry (Zerodha) + bus-routed  | ATM crossover (round to 100) of token 260105; re-enter once CE/PE open count = 0 | checkSL polls ticksCache vs fixed sl_trigger; on breach only marks a PaperTrade record COMPLETE via executeSL() and decr | sl_percent=1.25 | 231 |
| `lion-sp5-1.js` | lion-sp5 | active | BANKNIFTY | weekly index options C | live | ATM crossover (round to 100) of token 260105; re-enter once CE/PE open count = 0 | checkSL compares combined CE+PE premium (not per-leg) to (entry_ce+entry_pe)*sl_percent; live BUY-both-legs to close whe | sl_percent=0.95 (a premium-decay/combined SL, not a per-leg stop), farOtm forced to 0 (effectively ATM straddle) | 192 |
| `lion-st15-0020.js` | lion-st15 | active | BANKNIFTY | weekly index options C | live | ATM crossover (round to 100) of token 260105; re-enter once CE/PE open count = 0 | Trailing stop identical mechanism to lion-st15-1.js; live BUY to close | trail_sl=0.15; farOtm=otmSelector() | 202 |
| `lion-st15-1.js` | lion-st15 | active | BANKNIFTY | weekly index options C | live | ATM crossover (round to 100) of token 260105; re-enter once CE/PE open count = 0 | Trailing stop: tracks running low since entry; live Account.placeAllAccount BUY to close when price rises above entry+(t | trail_sl=0.15 (15%); farOtm=otmSelector() | 204 |
| `lion-st15-1789.js` | lion-st15 | active | BANKNIFTY | weekly index options C | live | ATM crossover (round to 100) of token 260105; re-enter once CE/PE open count = 0 | Trailing stop identical mechanism to lion-st15-1.js; live BUY to close | trail_sl=0.15; farOtm=otmSelector() | 202 |
| `lion-st15-2.js` | lion-st15 | active | BANKNIFTY | weekly index options C | live | ATM crossover (round to 100) of token 260105; re-enter once CE/PE open count = 0 | Trailing stop identical to lion-st15-1.js; live BUY to close | trail_sl=0.15; farOtm=otmSelector() | 204 |
| `lion-st15-3.js` | lion-st15 | active | BANKNIFTY | weekly index options C | live | ATM crossover (round to 100) of token 260105; re-enter once CE/PE open count = 0 | Trailing stop identical to lion-st15-1.js; live BUY to close | trail_sl=0.15; farOtm=otmSelector() | 204 |
| `lion-st25-1.js` | lion-st15 | active | BANKNIFTY | weekly index options C | live | ATM crossover (round to 100) of token 260105; re-enter once CE/PE open count = 0 | Trailing stop identical mechanism to lion-st15-1.js but wider trail; live BUY to close | trail_sl=0.25 (25%, wider than ST15's 15%); farOtm=otmSelector() | 204 |
| `biglion-0020.js` | lion-strangle(biglion) | active | BANKNIFTY | option-sell | bus-routed (paper) | ATM(100-step) crossover of BANKNIFTY future/spot token 260105 | sl_percent=1.25 SLM per leg via change-stream event machine; no time/EOD exit seen | sl_percent=1.25 farOtm=otmSelector() 4 pair legs per crossover at spread 0/100/200/300 | 251 |
| `lion-up-1.js` | lion-up | active | BANKNIFTY | weekly index options C | live | ATM crossover of token 260105; strike gap 0 on BUY side (near-ATM), farOtm on SELL side | Live Account.placeAllAccount BUY or SELL close depending on stored tradeType; 'pair' SL (combined premium *1.05) for bou | sl_percent=1.25, farOtm=otmSelector() | 232 |
| `orb-fut-bn.js` | orb-fut | modern | BANKNIFTY | future | bus-routed (paper) | (see orb-fut-core.js) | (see orb-fut-core.js) | rangeFilterPts=250 lots=1 bufferPct=0.001 | 7 |
| `orb-fut-core.js` | orb-fut | modern | BANKNIFTY,NIFTY,SENSEX (per wrapper) | future | bus-routed (paper) | 09:15-09:45 opening range; 5m candle close beyond range +-0.10% buffer | SL opposite ORB end \| single target T1=1x range \| EOD 15:15 | lots=cfg(1) bufferPct=0.001 rangeFilterPts=cfg | 247 |
| `orb-fut-logic.js` | orb-fut | modern | - | logic-lib | n/a | pure functions computeRange/passesFilter/breakoutSide/computeLevels/openPosition/evaluateExit | - | - | 73 |
| `orb-fut-nifty.js` | orb-fut | modern | NIFTY | future | bus-routed (paper) | (see orb-fut-core.js) | (see orb-fut-core.js) | rangeFilterPts=0 lots=1 bufferPct=0.001 | 7 |
| `orb-fut-snx.js` | orb-fut | modern | SENSEX | future | bus-routed (paper) | (see orb-fut-core.js) | (see orb-fut-core.js) | rangeFilterPts=0 lots=1 bufferPct=0.001 | 7 |
| `orb-scalp-logic.js` | orb-scalp | modern | - | logic-lib | n/a | pure functions atmStrike/sideFromSignal/spotSl/evaluateExit | - | - | 47 |
| `orb-scalp.js` | orb-scalp | modern | BANKNIFTY,NIFTY,SENSEX | option-buy | bus-routed (paper) | 09:15-09:45 opening range; later 5m candle body-closes beyond range +-0.10% buffer | premium target +targetPts \| per-index time-stop \| opposite-ORB-end spot stop \| EOD 15:15 | BN:tgt40/ts90/filt250 NIFTY:tgt20/ts60/filt0 SNX:tgt25/ts90/filt0 bufferPct=0.001 lots=1 | 319 |
| `p718-4.js` | p718-schedule | active | BANKNIFTY | option-sell | bus-routed (paper) | dozens of hardcoded CronJobs per weekday (18-20 on Mon-Fri), each selling a fresh ATM straddle at a specific minute with | Per-leg SLM via change-stream (sl_trigger = entry * per-slot SL%, ranging 1.1-2.0x); 14:58 squareOff() calls Papertrade. | ~18-20 time-of-day entries/weekday, SL% varies 1.1-2.0 per slot, Thursday hedge +-1000pt | 356 |
| `p718-5.js` | p718-schedule | legacy | BANKNIFTY | option-sell | bus-routed (paper) | sparser per-weekday schedule (4 entries/day); each entry computes option-chain max-pain and sells CE if spot>max_pain el | Simple per-tick SL poll (sell price > sl_trigger) via legacy PaperTrade.trackOrder; XtsAccount/Manager.stop calls presen | ~4 time-of-day entries/weekday, SL% 1.1-2.0 per slot, max-pain directional bias | 249 |
| `p718-1.js` | p718-supertrend | active | BANKNIFTY | option-sell | live | Supertrend(14,5) computed on a synthetic 3-min candle series built from summed CE+PE closes (100pt OTM strangle); sells  | closes (buys back) when supertrend flips below the synthetic close; no fixed SL/points -- pure indicator-flip exit; proc | farAtm=100, Supertrend(14,5), 3-min candles, check every 3 min | 187 |
| `p718-2.js` | p718-supertrend | active | BANKNIFTY | option-sell | live | same Supertrend entry as p718-1.js but at 200pt OTM | adds a real per-trade SL (entry+30 combined) plus a cumulative max_stoploss=80/day breaker that disables new trades for  | farAtm=200; max_stoploss=80 | 228 |
| `p718-3.js` | p718-supertrend | active | BANKNIFTY | option-sell | live | same Supertrend entry as p718-2.js but at 300pt OTM | same SL/max_stoploss=80 mechanics as p718-2.js | farAtm=300; max_stoploss=80 | 228 |
| `rv-25n.js` | rv-roll | active | NIFTY | option-sell | bus-routed (paper) | one-shot ~20s after start: sell 50pt OTM NIFTY strangle | Roll each leg further OTM on 25%-ish loss (up to max_sl_count=3) or back toward ATM on target | OTM=50, max_sl_count=3 (~SL/target implied by '25n' tag) | 233 |
| `rv-40.js` | rv-roll | active | BANKNIFTY | option-sell | bus-routed (paper) | one-shot ~20s after start: sell 100pt OTM strangle | Roll a leg further OTM (MOVE_OTM=100) on 40% loss (max_sl_count=2) or back toward ATM on 50% target recovery; floor at m | OTM=100, SL_percent=1.40, Tgt_percent=0.50, max_sl_count=2 | 229 |
| `rv-40e1.js` | rv-roll | active | BANKNIFTY | option-sell | bus-routed (paper) | same as rv-40.js but OTM forced to 0 (ATM straddle, not 100pt strangle) -- the 'e' variant | same roll mechanics as rv-40.js | OTM=0 (ATM), SL_percent=1.40, Tgt_percent=0.50, max_sl_count=2 | 229 |
| `rv-40e2.js` | rv-roll | active | BANKNIFTY | option-sell | bus-routed (paper) | same as rv-40e1.js | same as rv-40e1.js | OTM=0, SL_percent=1.40, Tgt_percent=0.50, max_sl_count=2 | 229 |
| `rv-40n.js` | rv-roll | active | NIFTY | option-sell | bus-routed (paper) | same rv-40.js roll engine retargeted to NIFTY (50pt OTM instead of 100pt) | same roll mechanics as rv-40.js | OTM=50, SL_percent=1.40 (implied), max_sl_count=2 | 225 |
| `rv-40sl.js` | rv-roll | active | BANKNIFTY | option-sell | live | same entry as rv-40.js | same per-leg roll mechanics as rv-40.js, PLUS a portfolio-level circuit breaker: closes both legs entirely if combined P | OTM=100, SL_percent=1.40 (implied), stoploss_limit=-1200 | 276 |
| `rv-s2.js` | rv-roll | active | BANKNIFTY | option-sell | bus-routed (paper) | same as rv-40.js but always trades NEXT-week expiry (not current week), and forces OTM=0 on Wednesdays | same roll-and-reload mechanics as rv-40.js | SL_percent=1.25, Tgt_percent=0.60, max_sl_count=3 (looser than rv-40's 1.40/0.50/2) | 233 |
| `rv-1.js` | rv-vol | active | BANKNIFTY | option-sell | bus-routed (paper) | one-shot at start: sell 100pt OTM strangle; every minute, roll a leg toward the strike with higher realized volatility ( | Roll = buy back current leg + sell new leg when new-strike RV exceeds old-strike RV; no fixed SL/target | OTM=100, RV window=14 ticks, roll check every 3 min after a 13 min warm-up | 189 |
| `rv-2.js` | rv-vol | active | BANKNIFTY | option-sell | bus-routed (paper) | same core idea as rv-1.js but re-implemented with the rv-40-style single-shot takeTrade() instead of the minute-candle R | SL_percent=1.25/Tgt_percent=0.60 roll mechanics (same shape as rv-40.js) with max_sl_count=3; Wed sets OTM=0 (ATM) | OTM=100, SL=1.25, Tgt=0.60, max_sl_count=3 | 233 |
| `samlion-10.js` | samlion | active | BANKNIFTY | option-sell | live | same as samlion-9.js | same as samlion-9.js (checkSL rewritten with .forEach instead of a for-in loop, same behavior) | 10 wing pairs at 0-900pt spacing, sl_percent=1.25 | 169 |
| `samlion-11.js` | samlion | active | BANKNIFTY | option-sell | live | same as samlion-10.js | same as samlion-10.js | 10 wing pairs at 0-900pt spacing, sl_percent=1.25 | 169 |
| `samlion-12.js` | samlion | active | BANKNIFTY | option-sell | live | same as samlion-10.js | same as samlion-10.js | 10 wing pairs at 0-900pt spacing, sl_percent=1.25 | 169 |
| `samlion-9.js` | samlion | active | BANKNIFTY | option-sell | live | one-shot ~10s after start: sells 10 CE+PE pairs at strikes ATM+0,100,200,...900 (a very wide iron-condor-style ladder),  | Combined-premium SL 1.25x per pair; on breach, buys back whichever leg (CE or PE) is underwater; no re-entry after close | 10 wing pairs at 0-900pt spacing, sl_percent=1.25 | 173 |
| `snx-orb-1.js` | snx-orb | active | SENSEX | option (CE+PE independ | live | 09:15-09:30 15-min range candle on SENSEX option premium (not spot); CE/PE each independently break high+11 or low-11 (f | hard SL at opposite trigger; re-entry per side with fresh SL from post-break day hi/lo; EOD 15:20 | lotSize=20 offset=11(Rs) maxLoss=20000/side risk-based qty | 376 |
| `snx-orb-25.js` | snx-orb | active | SENSEX | option (CE+PE independ | live | same as snx-orb-1.js but offset=1% of range-close price (dynamic), roundStep=25 | same as snx-orb-1.js | lotSize=20 roundStep=25 offsetPct=0.01 maxLoss=20000/side | 387 |
| `snx-orb-50.js` | snx-orb | active | SENSEX | option (CE+PE independ | live | same as snx-orb-25.js but roundStep=50 | same as snx-orb-25.js | lotSize=20 roundStep=50 offsetPct=0.01 maxLoss=20000/side | 387 |
| `stgl-mid-0020-1.js` | stgl-mid | active | BANKNIFTY | option-sell | live | 5s after start: pick CE and PE each closest in premium to Rs250, sell both | SLM 1.25x per leg via change-stream; re-enter a leg once its position closes if price re-crosses trade-start level | target_premium=250 sl_percent=1.25 | 284 |
| `stgl-mid-0020-2.js` | stgl-mid | active | BANKNIFTY | option-sell | live | same as stgl-mid-0020-1.js (minor refactor of the distance calc, same behavior) | same as stgl-mid-0020-1.js | target_premium=250 sl_percent=1.25 | 281 |
| `stgl-mid-0020-3.js` | stgl-mid | active | BANKNIFTY | option-sell | live | same as stgl-mid-0020-1.js | same as stgl-mid-0020-1.js | target_premium=250 sl_percent=1.25 | 281 |
| `stgl-mid-0020-4.js` | stgl-mid | active | BANKNIFTY | option-sell | live | same as stgl-mid-0020-1.js | same as stgl-mid-0020-1.js | target_premium=250 sl_percent=1.25 | 281 |
| `stgl-mid-2117-1.js` | stgl-mid | active | BANKNIFTY | option-sell | live | same as stgl-mid-0020-1.js | same as stgl-mid-0020-1.js | target_premium=250 sl_percent=1.25 | 281 |
| `stgl-mid-2117-2.js` | stgl-mid | active | BANKNIFTY | option-sell | live | same as stgl-mid-0020-1.js | same as stgl-mid-0020-1.js | target_premium=250 sl_percent=1.25 | 281 |
| `stgl-mid-2117-3.js` | stgl-mid | active | BANKNIFTY | option-sell | live | same as stgl-mid-0020-1.js | same as stgl-mid-0020-1.js | target_premium=250 sl_percent=1.25 | 281 |
| `stgl-mid-2117-4.js` | stgl-mid | active | BANKNIFTY | option-sell | live | same as stgl-mid-0020-1.js | same as stgl-mid-0020-1.js | target_premium=250 sl_percent=1.25 | 281 |
| `stgl-mid-3.js` | stgl-mid | active | BANKNIFTY | option-sell | live | same as stgl-mid-0020-1.js | same as stgl-mid-0020-1.js | target_premium=250 sl_percent=1.25 | 282 |
| `stgl-p-2117.js` | stgl-p | active | BANKNIFTY | option-sell | live | 3 sequential straddle sells targeting premium ~250, then ~200, then ~150 (next fires only after prior stop-loss closes) | Combined-premium SL 1.25x; on SL, immediately re-enters at the next (lower) premium target | sl_percent=1.25, targets=[250,200,150], max 3 sequential trades | 176 |
| `stgl-p-2203.js` | stgl-p | active | BANKNIFTY | option-sell | live | same as stgl-p-2117.js | same as stgl-p-2117.js | sl_percent=1.25, targets=[250,200,150] | 180 |
| `stgl-s.js` | stgl-s | active | BANKNIFTY | option-sell | live | 5s after start: sell 4 CE+PE pairs at fixed offsets 100/200/300/400 from ATM, one-shot (no crossover re-trigger) | Per-leg SLM 1.25x via own checkSL poll + PaperTrade.trackOrder_slm mirror; no re-entry after a leg closes | offsets=[100,200,300,400] sl_percent=1.25 | 222 |
| `stgl-s2.js` | stgl-s | active | BANKNIFTY | option-sell | live | same as stgl-s.js | same as stgl-s.js | offsets=[100,200,300,400] sl_percent=1.25 | 222 |
| `stgl-sm.js` | stgl-s | active | BANKNIFTY | option-sell | bus-routed (paper) | same as stgl-s.js | same offsets, but SL is placed/managed purely via the OrderUpdate change-stream (PaperTrade.trackOrder_slm), no Account. | offsets=[100,200,300,400] sl_percent=1.25 | 221 |
| `target-15.js` | target-15 | active | BANKNIFTY(default) | option-sell | bus-routed (paper(trackOrder v1)) | immediate ATM straddle sell 5s after init (OTM_DISTANCE=0 default) | either leg hits dynamic target = 1.5% of combined premium -> square off both legs -> re-enter after 9s delay | OTM_DISTANCE=0 TARGET_POINTS(dynamic,~1.5%) RESTART_DELAY=9000ms | 260 |

## Legacy directories — verdicts

| Directory | Verdict | Files |
|---|---|---|
| `server/smp` | possibly-active | 108 |
| `server/scripts` | dead | 85 |
| `server/tob` | dead | 66 |
| `server/archive` | dead | 28 |
| `server/monks` | dead | 26 |
| `server/smp` | superseded-by-slive | 26 |
| `server/asmp` | dead | 23 |
| `extra` | dead | 12 |
| `server/archive/xts` | dead | 8 |
| `server/wealth` | dead | 8 |
| `server/insta` | dead | 7 |
| `server/wealth/archive` | dead | 6 |
| `server/scripts` | possibly-active | 2 |
| `server/datafeed` | dead | 1 |
| `server/parity` | dead | 1 |
| `server/scripts` | active | 1 |

*Per-file legacy detail is in `legacy-strategies.csv` (408 rows).*