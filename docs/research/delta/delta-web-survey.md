# apps/web — NSE/India assumptions (Explore sub-agent report, relayed 2026-11-03)
Paths relative to apps/web/src.
1. Currency: format.ts:20 inr() en-IN; signed/money/inrCompact (L/Cr) route through it (142/50/46/4 calls). Seven bypass copies: strategies.tsx:178,211; traders/repair-card.tsx:41-44; traders/assistant/metrics.ts:31-34; traders/book-strip.tsx:34; traders/results-badge.tsx:27; traders/booked.tsx:64; traders/wire.ts:88. Also dials-plan.ts:318,805; strategies.tsx:678-693 "Daily target (₹)".
2. Lots × lotSize, integer qty: payoff.tsx:909,1068,259,1209; book-build.tsx:895,903 (default lot 750 :583); manual-order.tsx:369..603; protect.tsx:64-154; report-orders.ts:170,327; broker-view.tsx:329. isIntegerOnly payoff.tsx:973, strategies.tsx:659, protect.tsx:148. liveLots integer api.ts:1013,1042,1073.
3. Tick 0.05 hard-coded: entry-plan.ts:49-50, book-build.tsx:904, payoff.tsx:990. No hard-coded strike step; strikes from chain.
4. IST: api.ts:3289-3330 istDate/istDaysBefore/istDayLabel/istTime; api.ts:3410-3435 inSession() = weekdays 09:15-15:30 (books.tsx:79,113,157,570; strategies.tsx:1169; pages.tsx:1044,1051; broker-view.tsx:87). books.tsx:85 expiry check is date-only (17:30 IST expiry needs time).
5. Instrument identity: contract.ts:14-83 parseContract/formatContract NSE formats only (22 calls, unparsable shown raw). book-build.tsx:80-81 builds NSE symbol; :905 exchange 'NFO'. Numeric instrumentToken entry-plan.ts:22, manual-order-plan.ts:249.
6. Mode: api.ts:15 DeskMode paper|live; mode.tsx:15-188 localStorage provider = pattern for a venue switch; route builders api.ts:2324-2467 send ?mode=, no venue.
Venue-neutral: sign/RED/GREEN/money null handling, ago/localTime/localStamp, legs carry strike/optType/expiry separately.
Fewest edits: format.ts currency param; sessionFor(venue) replacing inSession; contract.ts formatContract; venue context beside mode.tsx + ?venue= on routes.
