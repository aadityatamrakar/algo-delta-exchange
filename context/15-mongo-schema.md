# 15 — Mongo schema, as stored (generated 2026-10-19)

The field-level shape of every collection in the live `algomaker` database. **Inferred, not declared**: the app has no schema layer (the driver sits behind the narrow `Collection` port in `apps/api/src/store.ts`), so this was read off the data itself — a `$sample` of up to 500 documents per collection, nested to 3 levels, arrays described by their first element. **Presence %** is the share of sampled documents carrying the field; a field absent from every sampled document is absent here. Who writes and who reads each collection is in [00 §5](00-live-system-map.md).

Retention: `desk-pnl-snapshots` keeps 30 days (`DESK_PNL_KEEP_DAYS`, nightly prune in `apps/api/src/pnl-jobs.ts`, only after the day is rolled up); `desk-marks` drops a token that left the instrument master once unpriced for 7 days (`apps/marketdata/src/marks-store.ts`, after each daily sync); `desk-sessions` and `desk-broker-session` expire. Everything else is kept indefinitely — the journals (`desk-decisions`, `desk-order-events`, `desk-book-marks`, `desk-daily-reports`, …) are the post-mortem record.

## Collections

| collection | rows | data | indexes (besides `_id`) |
|---|---:|---:|---|
| [desk-audit-log](#desk-audit-log) | 719 | 265 KB | `{at:-1}` |
| [desk-book-margin](#desk-book-margin) | 3 | 1 KB | — |
| [desk-book-marks](#desk-book-marks) | 21,659 | 6.3 MB | `{tag:1,mode:1,dateIst:1,mark:1}` unique, `{tag:1,mode:1,ts:-1}` |
| [desk-book-series](#desk-book-series) | 105 | 23 KB | `{tag:1,mode:1}` unique |
| [desk-books](#desk-books) | 16 | 14 KB | `{tag:1,mode:1}` unique, `{symbol:1,mode:1}` |
| [desk-books-registry](#desk-books-registry) | 20 | 57 KB | `{tag:1,mode:1}` unique |
| [desk-broker-cancels](#desk-broker-cancels) | 45 | 9 KB | — |
| [desk-broker-session](#desk-broker-session) | 0 | 0 KB | `{updatedAtDate:1}` TTL 604800s |
| [desk-broker-snapshot](#desk-broker-snapshot) | 1 | 0 KB | — |
| [desk-broker-snapshot-daily](#desk-broker-snapshot-daily) | 29 | 958 KB | — |
| [desk-brokers](#desk-brokers) | 2 | 1 KB | `{kind:1}` unique |
| [desk-daily-guard](#desk-daily-guard) | 15 | 5 KB | — |
| [desk-daily-reports](#desk-daily-reports) | 868 | 211 KB | `{date:1,tag:1,mode:1}` unique, `{date:-1}` |
| [desk-decisions](#desk-decisions) | 10,857 | 5.1 MB | `{decisionId:1}` unique, `{tag:1,mode:1,createdAt:1}`, `{mode:1,createdAt:1}` |
| [desk-declarations](#desk-declarations) | 9 | 3 KB | `{tag:1}` unique |
| [desk-engine-decisions](#desk-engine-decisions) | 2,302 | 1.6 MB | `{decisionId:1}` unique |
| [desk-fills](#desk-fills) | 4,156 | 1.7 MB | `{baseClientOrderId:1,ts:1}`, `{clientOrderId:1,ts:1}` |
| [desk-freeze-limits](#desk-freeze-limits) | 225 | 13 KB | `{symbol:1}` unique |
| [desk-gateway-orders](#desk-gateway-orders) | 1,621 | 1.7 MB | `{state:1,createdAt:1}`, `{clientOrderId:1}` unique, `{brokerOrderIds:1}` |
| [desk-marks](#desk-marks) | 5,946 | 543 KB | — |
| [desk-order-events](#desk-order-events) | 16,494 | 5.3 MB | `{clientOrderId:1,ts:1}`, `{ok:1,ts:-1}`, `{ts:-1}`, `{tag:1,ts:-1}` |
| [desk-paper-trade](#desk-paper-trade) | 5,931 | 2.8 MB | `{order_timestamp:-1}`, `{clientOrderId:1}` unique sparse |
| [desk-payoff-snapshots](#desk-payoff-snapshots) | 1,471 | 22.7 MB | `{tag:1,ts:-1}` |
| [desk-pnl-snapshots](#desk-pnl-snapshots) | 484,817 | 61.2 MB | `{tag:1,mode:1,ts:1}`, `{ts:1}` |
| [desk-positions-compare](#desk-positions-compare) | 1 | 0 KB | — |
| [desk-repair-applies](#desk-repair-applies) | 2 | 3 KB | `{tag:1}` unique, `{tag:1,updatedAt:-1}` |
| [desk-safety](#desk-safety) | 1 | 0 KB | — |
| [desk-sessions](#desk-sessions) | 3 | 0 KB | `{token:1}` unique, `{expiresAt:1}` |
| [desk-strategies](#desk-strategies) | 51 | 13 KB | `{tag:1}` unique |
| [desk-strategy-runtime](#desk-strategy-runtime) | 18 | 3 KB | `{tag:1,mode:1}` unique |
| [desk-strategy-state](#desk-strategy-state) | 35 | 22 KB | `{tag:1,key:1}` unique |
| [desk-submissions](#desk-submissions) | 20,760 | 8.3 MB | `{clientOrderId:1}` unique |
| [desk-subscriptions](#desk-subscriptions) | 2 | 13 KB | `{source:1}` unique |
| [desk-supervisor-lease](#desk-supervisor-lease) | 1 | 0 KB | `{key:1}` unique |
| [desk-supervisor-state](#desk-supervisor-state) | 105 | 116 KB | `{key:1}` unique |
| [desk-users](#desk-users) | 1 | 0 KB | `{username:1}` unique |
| [desk-variants](#desk-variants) | 40 | 16 KB | — |
| [instrument](#instrument) | 10,015 | 2.2 MB | `{instrument_token:1}` unique, `{tradingsymbol:1}` |

Counts as of 2026-10-19 15:20 IST. The two indexes added that day — `desk-marks {token: 1}` unique and `desk-decisions {createdAt: 1}` — are built at the next boot of desk-marketdata / desk-api and are not in this snapshot.

## desk-audit-log

719 rows; sampled 500.

| field | type | presence |
|---|---|---:|
| `at` | number | 100% |
| `principal` | string | 100% |
| `principalKind` | string | 100% |
| `source` | string | 100% |
| `action` | string | 100% |
| `tag` | string | 93% |
| `mode` | string | 70% |
| `detail` | object | 100% |
| `detail.before` | object | string | 53% |
| `detail.after` | object | string | 53% |
| `detail.tradingsymbol` | string | 4% |
| `detail.style` | string | 7% |
| `detail.decisionId` | string | 7% |
| `detail.legs` | number | 7% |
| `detail.fills` | number | 4% |
| `detail.skips` | number | 4% |
| `detail.trigger` | string | 2% |
| `detail.pnlAtTrigger` | number | 2% |
| `detail.limits` | object | 2% |
| `detail.limits.target` | number | 2% |
| `detail.limits.stop` | number | 2% |
| `detail.incomplete` | boolean | 2% |
| `detail.switchOff` | string | 2% |
| `detail.flatten` | string | 2% |
| `detail.symbol` | string | 15% |
| `detail.expiry` | string | 14% |
| `detail.variant` | string | 28% |
| `detail.series` | string | 8% |
| `detail.dials` | object | 14% |
| `detail.dials.delta_tol_pct` | number | 13% |
| `detail.dials.delta_shorts_only` | boolean | 14% |
| `detail.dials.gamma_shorts_only` | boolean | 14% |
| `detail.dials.tol_ref_dte` | number | 13% |
| `detail.dials.shift_enabled` | boolean | 13% |
| `detail.dials.shift_itm_steps` | number | 13% |
| `detail.dials.shift_land_steps` | number | 13% |
| `detail.dials.shift_margin_frac` | number | 13% |
| `detail.dials.hedge_after_shift` | boolean | 13% |
| `detail.dials.min_band_lots` | number | 13% |
| `detail.dials.no_band_floor` | boolean | 13% |
| `detail.dials.shed_scan_strikes` | number | 13% |
| `detail.dials.strikes_out` | number | 13% |
| `detail.dials.min_sell_dte` | number | 13% |
| `detail.dials.min_sell_delta` | number | 13% |
| `detail.dials.scrap_close_delta` | number | 13% |
| `detail.dials.unwind_enabled` | boolean | 13% |
| `detail.dials.recycle_frac` | number | 13% |
| `detail.dials.recycle_bank` | boolean | 13% |
| `detail.dials.recycle_opposite` | boolean | 13% |
| `detail.dials.eod_flat_min` | number | 13% |
| `detail.dials.trend_enabled` | boolean | 13% |
| `detail.dials.trend_skew` | number | 13% |
| `detail.dials.anchor_ema_marks` | number | 13% |
| `detail.dials.…` | string | 13% |
| `detail.before.paper` | boolean | 22% |
| `detail.before.live` | boolean | 22% |
| `detail.before.liveLots` | number | 22% |
| `detail.before.dailyLimits` | null | object | 22% |
| `detail.after.paper` | boolean | 22% |
| `detail.after.live` | boolean | 22% |
| `detail.after.liveLots` | number | 22% |
| `detail.after.dailyLimits` | null | object | 22% |
| `detail.booked` | number | 1% |
| `detail.unresolved` | number | 1% |
| `detail.wasEnabled` | boolean | 1% |
| `detail.kind` | string | 3% |
| `detail.flattenRequested` | boolean | 12% |
| `detail.purged` | boolean | 12% |
| `detail.appOrderID` | string | 6% |
| `detail.routed` | number | 3% |
| `detail.flat` | boolean | 3% |
| `detail.dials.margin_cap` | number | 1% |
| `detail.dials.target_pnl` | number | 1% |
| `detail.bookUnchanged` | boolean | 2% |
| `detail.ok` | boolean | 1% |
| `detail.error` | string | 1% |
| `detail.before.shed_scan_strikes` | null | number | 1% |
| `detail.after.shed_scan_strikes` | number | 1% |
| `detail.before.delta_tol_pct` | number | 0% |
| `detail.before.strikes_out` | number | 0% |
| `detail.before.min_sell_dte` | number | 0% |
| `detail.before.target_pnl` | number | 0% |
| `detail.before.cooldown_min` | number | 0% |
| `detail.before.shift_itm_steps` | number | 0% |
| `detail.before.shift_land_steps` | number | 0% |
| `detail.before.shift_margin_frac` | number | 0% |
| `detail.before.hedge_after_shift` | boolean | 0% |
| `detail.before.no_buy` | boolean | 0% |
| `detail.before.no_close` | boolean | 0% |
| `detail.before.margin_cap` | number | 0% |
| `detail.before.lot_size` | number | 0% |
| `detail.before.delta_shorts_only` | boolean | 0% |
| `detail.before.gamma_shorts_only` | boolean | 0% |
| `detail.after.delta_tol_pct` | number | 0% |
| `detail.after.strikes_out` | number | 0% |
| `detail.after.min_sell_dte` | number | 0% |
| `detail.after.target_pnl` | number | 0% |
| `detail.after.cooldown_min` | number | 0% |
| `detail.after.shift_itm_steps` | number | 0% |
| `detail.after.shift_land_steps` | number | 0% |
| `detail.after.shift_margin_frac` | number | 0% |
| `detail.after.hedge_after_shift` | boolean | 0% |
| `detail.after.no_buy` | boolean | 0% |
| `detail.after.no_close` | boolean | 0% |
| `detail.after.margin_cap` | number | 0% |
| `detail.after.lot_size` | number | 0% |
| `detail.after.delta_shorts_only` | boolean | 0% |
| `detail.after.gamma_shorts_only` | boolean | 0% |
| `detail.desired` | string | 0% |
| `detail.reason` | string | 0% |
| `detail.before.dl_day_max_loss` | number | 1% |
| `detail.after.dl_day_max_loss` | number | 1% |
| `detail.settled` | array | 0% |
| `detail.settled[]` | object | 0% |
| `detail.settled[].tradingsymbol` | string | 0% |
| `detail.settled[].qty` | number | 0% |
| `detail.settled[].side` | string | 0% |
| `detail.settled[].price` | number | 0% |
| `detail.settled[].source` | string | 0% |
| `detail.settled[].expiry` | string | 0% |
| `detail.settled[].strike` | number | 0% |
| `detail.settled[].type` | string | 0% |
| `detail.settled[].close` | number | 0% |
| `detail.settled[].closeSource` | string | 0% |
| `detail.settled[].closeAt` | number | 0% |
| `detail.settled[].decisionId` | string | 0% |
| `detail.remaining` | number | 0% |
| `detail.operatorClose` | number | 0% |
| `detail.unpriceable` | number | 0% |
| `detail.settled[].closeNote` | string | 0% |
| `detail.enabled` | boolean | 0% |
| `detail.liveLots` | number | 0% |

## desk-book-margin

3 rows; sampled 3.

| field | type | presence |
|---|---|---:|
| `asOf` | number | 100% |
| `diagnostic` | string | 100% |
| `exposure` | number | 100% |
| `legs` | array | 100% |
| `ok` | boolean | 100% |
| `premium` | number | 100% |
| `premiumPaid` | number | 100% |
| `source` | string | 100% |
| `span` | number | 100% |
| `total` | number | 100% |

## desk-book-marks

21,659 rows; sampled 500.

| field | type | presence |
|---|---|---:|
| `tag` | string | 100% |
| `mode` | string | 100% |
| `mark` | number | 100% |
| `dateIst` | string | 100% |
| `ts` | number | 100% |
| `spot` | number | 100% |
| `netDelta` | number | 100% |
| `netGamma` | number | 100% |
| `band` | number | 100% |
| `totalPnl` | number | 100% |
| `marginSource` | string | 100% |
| `reason` | string | 100% |
| `forwardSource` | string | 1% |

## desk-book-series

105 rows; sampled 105.

| field | type | presence |
|---|---|---:|
| `mode` | string | 100% |
| `tag` | string | 100% |
| `createdAt` | number | 100% |
| `expiry` | string | 100% |
| `series` | string | 100% |
| `symbol` | string | 100% |
| `variant` | string | 100% |

## desk-books

16 rows; sampled 16.

| field | type | presence |
|---|---|---:|
| `tag` | string | 100% |
| `mode` | string | 100% |
| `symbol` | string | 100% |
| `expiry` | string | 100% |
| `legs` | array | 100% |
| `updatedAt` | number | 100% |
| `appliedCorrections` | array | 100% |
| `legs[]` | object | 6% |
| `legs[].deskTag` | string | 6% |
| `legs[].instrument` | object | 6% |
| `legs[].instrument.tradingsymbol` | string | 6% |
| `legs[].instrument.instrumentToken` | number | 6% |
| `legs[].instrument.lotSize` | number | 6% |
| `legs[].instrument.tickSize` | number | 6% |
| `legs[].instrument.exchange` | string | 6% |
| `legs[].underlying` | string | 6% |
| `legs[].expiry` | string | 6% |
| `legs[].strike` | number | 6% |
| `legs[].type` | string | 6% |
| `legs[].side` | string | 6% |
| `legs[].qty` | number | 6% |
| `legs[].entryPrice` | number | 6% |
| `legs[].openedTs` | number | 6% |

## desk-books-registry

20 rows; sampled 20.

| field | type | presence |
|---|---|---:|
| `mode` | string | 100% |
| `tag` | string | 100% |
| `actual` | string | 100% |
| `createdAt` | number | 100% |
| `desired` | string | 100% |
| `dials` | object | 100% |
| `dials.delta_tol_pct` | number | 85% |
| `dials.delta_shorts_only` | boolean | 100% |
| `dials.gamma_shorts_only` | boolean | 100% |
| `dials.tol_ref_dte` | number | 85% |
| `dials.shift_enabled` | boolean | 85% |
| `dials.shift_itm_steps` | number | 85% |
| `dials.shift_land_steps` | number | 85% |
| `dials.shift_margin_frac` | number | 85% |
| `dials.hedge_after_shift` | boolean | 85% |
| `dials.min_band_lots` | number | 85% |
| `dials.no_band_floor` | boolean | 85% |
| `dials.shed_scan_strikes` | number | 85% |
| `dials.strikes_out` | number | 85% |
| `dials.min_sell_dte` | number | 85% |
| `dials.min_sell_delta` | number | 85% |
| `dials.scrap_close_delta` | number | 85% |
| `dials.unwind_enabled` | boolean | 85% |
| `dials.recycle_frac` | number | 85% |
| `dials.recycle_bank` | boolean | 85% |
| `dials.recycle_opposite` | boolean | 85% |
| `dials.eod_flat_min` | number | 85% |
| `dials.trend_enabled` | boolean | 85% |
| `dials.trend_skew` | number | 85% |
| `dials.anchor_ema_marks` | number | 85% |
| `dials.confirm_marks` | number | 85% |
| `dials.target_pnl` | number | 100% |
| `dials.margin_cap` | number | 100% |
| `dials.work_tranche_lots` | number | 85% |
| `dials.chase_max_ms` | number | 85% |
| `dials.chase_cross_buffer_pct` | number | 85% |
| `dials.rest_max_min` | number | 85% |
| `dials.confirm_ms` | number | 85% |
| `dials.cooldown_s` | number | 85% |
| `dials.scrap_close_px` | number | 85% |
| `dials.min_sell_px` | number | 85% |
| `dials.crash_delta` | number | 85% |
| `dials.target_confirm_marks` | number | 85% |
| `dials.lock_exclude_mark0` | boolean | 85% |
| `dials.lock_executability` | boolean | 85% |
| `dials.target_snap_multiple` | number | 85% |
| `dials.lock_branch_lots` | number | 85% |
| `dials.sell_max_spread_pct` | number | 85% |
| `dials.quote_max_age_ms` | number | 85% |
| `dials.balance_min_dte` | number | 85% |
| `dials.balance_enabled` | boolean | 85% |
| `dials.delta_lean_enabled` | boolean | 85% |
| `dials.dl_day_max_loss` | number | 85% |
| `dials.dl_day_target` | number | 85% |
| `dials.dl_open_lots` | number | 85% |
| `dials.dl_stuck_loss` | number | 85% |
| `dials.dl_stuck_confirm_s` | number | 85% |
| `dials.dl_open_by_min` | number | 65% |
| `dials.dl_open_fallback` | boolean | 65% |
| `dials.dl_open_trend_up` | boolean | 65% |
| `dials.dl_open_trend_down` | boolean | 65% |
| `dials.dl_open_quiet` | boolean | 65% |
| `dials.dl_expiry_day_only` | boolean | 65% |
| `dials.dl_adjust_confirm_s` | number | 85% |
| `dials.dl_adjust_cooldown_s` | number | 85% |
| `dials.dl_max_adjusts_day` | number | 85% |
| `dials.dl_fast_window_s` | number | 85% |
| `dials.dl_slow_window_s` | number | 85% |
| `dials.dl_context_window_s` | number | 85% |
| `dials.dl_context_on` | boolean | 85% |
| `dials.dl_trend_mult` | number | 85% |
| `dials.dl_trend_exit_mult` | number | 85% |
| `dials.dl_clean_min` | number | 85% |
| `dials.dl_quiet_mult` | number | 85% |
| `dials.dl_regime_dwell_s` | number | 85% |
| `dials.dl_long_delta_lo` | number | 85% |
| `dials.dl_long_delta_hi` | number | 85% |
| `dials.dl_short_delta_lo` | number | 85% |
| `dials.dl_short_delta_hi` | number | 85% |
| `dials.dl_credit_short_delta_max` | number | 85% |
| `dials.dl_wing_delta` | number | 85% |
| `dials.dl_min_strike_gap` | number | 85% |
| `dials.dl_neutral_short_delta_lo` | number | 85% |
| `dials.dl_neutral_short_delta_hi` | number | 85% |
| `dials.dl_dead_band_lots` | number | 85% |
| `dials.dl_quote_fresh_s` | number | 85% |
| `dials.dl_max_spread_pct` | number | 85% |
| `dials.dl_max_spread_abs` | number | 85% |
| `dials.dl_spot_stale_s` | number | 85% |
| `dials.dl_warmup_min` | number | 85% |
| `dials.dl_flatten_passive_min` | number | 85% |
| `dials.dl_flatten_urgent_min` | number | 85% |
| `dials.dl_flat_by_min` | number | 85% |
| `dials.dl_eval_min_ms` | number | 85% |
| `dials.dl_max_orders_min` | number | 85% |
| `dials.dl_max_orders_s` | number | 85% |
| `dials.dl_max_orders_day` | number | 85% |
| `dials.dl_hold_to_expiry` | boolean | 85% |
| `dials.dl_parity_forward` | boolean | 65% |
| `dials.pb_playbook` | number | 65% |
| `dials.pb_min_dte` | number | 65% |
| `dials.pb_expiry_day_only` | boolean | 65% |
| `dials.pb_lots` | number | 65% |
| `dials.pb_entry_start_min` | number | 65% |
| `dials.pb_entry_end_min` | number | 65% |
| `dials.pb_max_entries` | number | 65% |
| `dials.pb_reentry_cooldown_s` | number | 65% |
| `dials.pb_confirm_s` | number | 65% |
| `dials.pb_gap_min_pct` | number | 65% |
| `dials.pb_gap_max_pct` | number | 65% |
| `dials.pb_retry_s` | number | 65% |
| `dials.pb_max_gap_min` | number | 65% |
| `dials.pb_trade_max_loss` | number | 65% |
| `dials.pb_trade_target` | number | 65% |
| `dials.pb_trail_start` | number | 65% |
| `dials.pb_late_trail_start` | number | 65% |
| `dials.pb_late_min` | number | 65% |
| `dials.pb_trail_keep` | number | 65% |
| `dials.pb_time_exit_min` | number | 65% |
| `dials.pb_stop_hold_s` | number | 65% |
| `dials.pb_rupee_hold_s` | number | 65% |
| `dials.pb_strike_mode` | number | 65% |
| `dials.pb_short_str_k` | number | 65% |
| `dials.pb_debit_stop_frac` | number | 65% |
| `dials.pb_target_max_frac` | number | 65% |
| `dials.pb_flip_confirm_s` | number | 65% |
| `dials.pb_max_adds` | number | 65% |
| `dials.pb_add_ext_k` | number | 65% |
| `dials.pb_wing_str_k` | number | 65% |
| `dials.pb_wing_min_steps` | number | 65% |
| `dials.pb_combined_stop` | number | 65% |
| `dials.pb_stop_str_k` | number | 65% |
| `dials.pb_calm_min` | number | 65% |
| `dials.pb_calm_mult` | number | 65% |
| `dials.pb_max_move_k` | number | 65% |
| `dials.pb_target_frac` | number | 65% |
| `dials.pb_trend_exit_s` | number | 65% |
| `dials.pb_stage_abort_k` | number | 65% |
| `dials.pb_stage_gap_s` | number | 65% |
| `dials.pb_wing_fresh_s` | number | 65% |
| `dials.pb_wing_spread_abs` | number | 65% |
| `dials.pb_rev_min_ext` | number | 65% |
| `dials.pb_rev_retrace` | number | 65% |
| `dials.pb_rev_stop_k` | number | 65% |
| `dials.pb_box_min` | number | 65% |
| `dials.pb_box_max_k` | number | 65% |
| `dials.pb_brk_buf_k` | number | 65% |
| `dials.pb_premium_budget` | number | 65% |
| `dials.pb_gamma_max_lots` | number | 65% |
| `dials.pb_otm_steps` | number | 65% |
| `dials.pb_prem_stop_frac` | number | 65% |
| `dials.pb_prem_trail_arm` | number | 65% |
| `expiry` | string | 100% |
| `lastDecision` | string | 100% |
| `lastMarkAt` | number | 100% |
| `series` | string | 85% |
| `symbol` | string | 100% |
| `updatedAt` | number | 100% |
| `variant` | string | 100% |
| `lastAction` | string | 80% |
| `lastReason` | string | 80% |
| `lastReasonAt` | number | 80% |

## desk-broker-cancels

45 rows; sampled 45.

| field | type | presence |
|---|---|---:|
| `error` | string | 100% |
| `requestedAt` | number | 100% |
| `requestedBy` | string | 100% |
| `status` | string | 100% |
| `finishedAt` | number | 100% |

## desk-broker-session

0 rows; sampled 0.

_Empty — no documents to sample._

## desk-broker-snapshot

1 rows; sampled 1.

| field | type | presence |
|---|---|---:|
| `asOf` | number | 100% |
| `error` | string | 100% |
| `ok` | boolean | 100% |
| `orders` | array | 100% |
| `positions` | array | 100% |
| `emptyDiagnostic` | object | 100% |
| `emptyDiagnostic.orders` | string | 100% |
| `emptyDiagnostic.trades` | string | 100% |
| `emptyDiagnostic.positions` | string | 100% |
| `trades` | array | 100% |
| `errorClass` | string | 100% |
| `sessionOpenAtSnapshot` | boolean | 100% |
| `funds` | null | 100% |
| `fundsDiagnostic` | string | 100% |

## desk-broker-snapshot-daily

29 rows; sampled 29.

| field | type | presence |
|---|---|---:|
| `asOf` | number | 100% |
| `day` | string | 100% |
| `error` | string | 100% |
| `funds` | object | 100% |
| `funds.BalanceList` | array | 100% |
| `funds.BalanceList[]` | object | 100% |
| `funds.BalanceList[].limitHeader` | string | 100% |
| `funds.BalanceList[].limitObject` | object | 100% |
| `fundsDiagnostic` | string | 100% |
| `ok` | boolean | 100% |
| `orders` | array | 100% |
| `positions` | array | 100% |
| `positions[]` | object | 76% |
| `positions[].AccountID` | string | 76% |
| `positions[].TradingSymbol` | string | 76% |
| `positions[].ExchangeSegment` | string | 76% |
| `positions[].ExchangeInstrumentId` | string | 76% |
| `positions[].ProductType` | string | 76% |
| `positions[].Marketlot` | string | 76% |
| `positions[].Multiplier` | string | 76% |
| `positions[].BuyAveragePrice` | string | 76% |
| `positions[].SellAveragePrice` | string | 76% |
| `positions[].OpenBuyQuantity` | string | 76% |
| `positions[].OpenSellQuantity` | string | 76% |
| `positions[].Quantity` | string | 76% |
| `positions[].BuyAmount` | string | 76% |
| `positions[].SellAmount` | string | 76% |
| `positions[].NetAmount` | string | 76% |
| `positions[].UnrealizedMTM` | string | 76% |
| `positions[].RealizedMTM` | string | 76% |
| `positions[].MTM` | string | 76% |
| `positions[].BEP` | string | 76% |
| `positions[].SumOfTradedQuantityAndPriceBuy` | string | 76% |
| `positions[].SumOfTradedQuantityAndPriceSell` | string | 76% |
| `positions[].statisticsLevel` | string | 76% |
| `positions[].isInterOpPosition` | boolean | 76% |
| `positions[].ActualSellAmount` | number | 76% |
| `positions[].ActualSellAveragePrice` | number | 76% |
| `positions[].ActualBuyAmount` | number | 76% |
| `positions[].ActualBuyAveragePrice` | number | 76% |
| `positions[].SumOfTradedQuantityAndActualPriceBuy` | number | 76% |
| `positions[].SumOfTradedQuantityAndActualPriceSell` | number | 76% |
| `positions[].childPositions` | object | 76% |
| `positions[].MessageCode` | number | 76% |
| `positions[].MessageVersion` | number | 76% |
| `positions[].TokenID` | number | 76% |
| `positions[].ApplicationType` | number | 76% |
| `positions[].SequenceNumber` | number | 76% |
| `trades` | array | 100% |
| `emptyDiagnostic` | object | 90% |
| `emptyDiagnostic.orders` | string | 90% |
| `emptyDiagnostic.trades` | string | 86% |
| `errorClass` | string | 79% |
| `sessionOpenAtSnapshot` | boolean | 79% |
| `orders[]` | object | 45% |
| `orders[].LoginID` | string | 45% |
| `orders[].ClientID` | string | 45% |
| `orders[].AppOrderID` | number | 45% |
| `orders[].OrderReferenceID` | string | 45% |
| `orders[].GeneratedBy` | string | 45% |
| `orders[].ExchangeOrderID` | string | 45% |
| `orders[].OrderCategoryType` | string | 45% |
| `orders[].ExchangeSegment` | string | 45% |
| `orders[].ExchangeInstrumentID` | number | 45% |
| `orders[].OrderSide` | string | 45% |
| `orders[].OrderType` | string | 45% |
| `orders[].ProductType` | string | 45% |
| `orders[].TimeInForce` | string | 45% |
| `orders[].OrderPrice` | number | 45% |
| `orders[].OrderQuantity` | number | 45% |
| `orders[].OrderStopPrice` | number | 45% |
| `orders[].OrderStatus` | string | 45% |
| `orders[].OrderAverageTradedPrice` | string | 45% |
| `orders[].LeavesQuantity` | number | 45% |
| `orders[].CumulativeQuantity` | number | 45% |
| `orders[].OrderDisclosedQuantity` | number | 45% |
| `orders[].OrderGeneratedDateTime` | string | 45% |
| `orders[].ExchangeTransactTime` | string | 45% |
| `orders[].TradingSymbol` | string | 45% |
| `orders[].LastUpdateDateTime` | string | 45% |
| `orders[].OrderExpiryDate` | string | 45% |
| `orders[].CancelRejectReason` | string | 45% |
| `orders[].OrderUniqueIdentifier` | string | 45% |
| `orders[].OrderLegStatus` | string | 45% |
| `orders[].BoLegDetails` | number | 45% |
| `orders[].IsSpread` | boolean | 45% |
| `orders[].BoEntryOrderId` | string | 45% |
| `orders[].ApiOrderSource` | string | 45% |
| `orders[].MessageCode` | number | 45% |
| `orders[].MessageVersion` | number | 45% |
| `orders[].TokenID` | number | 45% |
| `orders[].ApplicationType` | number | 45% |
| `orders[].SequenceNumber` | number | 45% |
| `orders[].IsAMO` | boolean | 45% |
| `trades[]` | object | 45% |
| `trades[].LoginID` | string | 45% |
| `trades[].ClientID` | string | 45% |
| `trades[].AppOrderID` | number | 45% |
| `trades[].OrderReferenceID` | string | 45% |
| `trades[].GeneratedBy` | string | 45% |
| `trades[].ExchangeOrderID` | string | 45% |
| `trades[].OrderCategoryType` | string | 45% |
| `trades[].ExchangeSegment` | string | 45% |
| `trades[].ExchangeInstrumentID` | number | 45% |
| `trades[].OrderSide` | string | 45% |
| `trades[].OrderType` | string | 45% |
| `trades[].ProductType` | string | 45% |
| `trades[].TimeInForce` | string | 45% |
| `trades[].OrderPrice` | number | 45% |
| `trades[].OrderQuantity` | number | 45% |
| `trades[].OrderStopPrice` | number | 45% |
| `trades[].OrderStatus` | string | 45% |
| `trades[].OrderAverageTradedPrice` | string | 45% |
| `trades[].LeavesQuantity` | number | 45% |
| `trades[].CumulativeQuantity` | number | 45% |
| `trades[].OrderDisclosedQuantity` | number | 45% |
| `trades[].OrderGeneratedDateTime` | string | 45% |
| `trades[].ExchangeTransactTime` | string | 45% |
| `trades[].LastUpdateDateTime` | string | 45% |
| `trades[].OrderUniqueIdentifier` | string | 45% |
| `trades[].OrderLegStatus` | string | 45% |
| `trades[].LastTradedPrice` | number | 45% |
| `trades[].LastTradedQuantity` | number | 45% |
| `trades[].LastExecutionTransactTime` | string | 45% |
| `trades[].ExecutionID` | string | 45% |
| `trades[].TradingSymbol` | string | 45% |
| `trades[].ExecutionReportIndex` | number | 45% |
| `trades[].ApiOrderSource` | string | 45% |
| `trades[].IsSpread` | boolean | 45% |
| `trades[].MessageCode` | number | 45% |
| `trades[].MessageVersion` | number | 45% |
| `trades[].TokenID` | number | 45% |
| `trades[].ApplicationType` | number | 45% |
| `trades[].SequenceNumber` | number | 45% |
| `emptyDiagnostic.positions` | string | 24% |

## desk-brokers

2 rows; sampled 2.

| field | type | presence |
|---|---|---:|
| `kind` | string | 100% |
| `label` | string | 100% |
| `lastError` | string | 100% |
| `lastVerifiedAt` | number | 100% |
| `meta` | object | 100% |
| `meta.userId` | string | 50% |
| `secret` | string | 100% |
| `updatedAt` | number | 100% |
| `meta.clientId` | string | 50% |
| `meta.baseUrl` | string | 50% |
| `lastFailedAt` | number | 50% |

## desk-daily-guard

15 rows; sampled 15.

| field | type | presence |
|---|---|---:|
| `tag` | string | 100% |
| `mode` | string | 100% |
| `day` | string | 100% |
| `firedAt` | number | 100% |
| `trigger` | string | 100% |
| `pnlAtTrigger` | number | 100% |
| `incomplete` | boolean | 100% |
| `actions` | array | 100% |
| `actions[]` | object | 100% |
| `actions[].step` | string | 100% |
| `actions[].at` | number | 100% |
| `actions[].note` | string | 100% |

## desk-daily-reports

868 rows; sampled 500.

| field | type | presence |
|---|---|---:|
| `tag` | string | 100% |
| `date` | string | 100% |
| `mode` | string | 100% |
| `closingPositions` | number | 100% |
| `closingSource` | string | 100% |
| `maxLoss` | null | number | 100% |
| `maxProfit` | null | number | 100% |
| `orderCount` | number | 100% |
| `realised` | number | 100% |
| `snapshots` | number | 100% |
| `total` | null | number | 100% |
| `writtenAt` | number | 100% |

## desk-decisions

10,857 rows; sampled 500.

| field | type | presence |
|---|---|---:|
| `decisionId` | string | 100% |
| `symbol` | string | 100% |
| `expiry` | string | 100% |
| `mode` | string | 100% |
| `tag` | string | 100% |
| `fills` | array | 100% |
| `fills[]` | object | 71% |
| `fills[].op` | string | 71% |
| `fills[].deskTag` | string | 71% |
| `fills[].tradingsymbol` | string | 71% |
| `fills[].side` | string | 71% |
| `fills[].qty` | number | 71% |
| `fills[].price` | number | 71% |
| `fills[].ts` | number | 71% |
| `fills[].orderType` | string | 65% |
| `fills[].limitPrice` | number | 65% |
| `skips` | array | 100% |
| `createdAt` | number | 100% |
| `status` | string | 100% |
| `source` | string | 61% |
| `fills[].workMode` | string | 9% |
| `fills[].trancheLots` | number | 9% |
| `fills[].chaseMaxMs` | number | 9% |
| `fills[].chaseCrossBufferPct` | number | 9% |
| `plannedFills` | array | 33% |
| `plannedFills[]` | object | 10% |
| `plannedFills[].op` | string | 10% |
| `plannedFills[].deskTag` | string | 10% |
| `plannedFills[].tradingsymbol` | string | 10% |
| `plannedFills[].side` | string | 10% |
| `plannedFills[].qty` | number | 10% |
| `plannedFills[].price` | number | 10% |
| `plannedFills[].ts` | number | 10% |
| `plannedFills[].workMode` | string | 9% |
| `plannedFills[].trancheLots` | number | 9% |
| `plannedFills[].chaseMaxMs` | number | 9% |
| `plannedFills[].chaseCrossBufferPct` | number | 9% |
| `plannedFills[].orderType` | string | 10% |
| `plannedFills[].limitPrice` | number | 10% |
| `via` | string | 19% |
| `routeErrors` | array | 33% |
| `workingOrderIds` | array | 19% |
| `foldedOrders` | array | 9% |
| `completedAt` | number | 33% |
| `skips[]` | object | 16% |
| `skips[].action` | object | 16% |
| `skips[].action.op` | string | 16% |
| `skips[].action.ts` | string | 16% |
| `skips[].action.strike` | number | 16% |
| `skips[].action.type` | string | 16% |
| `skips[].action.side` | string | 16% |
| `skips[].action.qty` | number | 16% |
| `skips[].action.leanId` | string | 7% |
| `skips[].reason` | string | 16% |
| `fills[].leanId` | string | 1% |
| `plannedFills[].leanId` | string | 1% |
| `fills[].corrected` | object | 2% |
| `fills[].corrected.at` | number | 2% |
| `fills[].corrected.fromQty` | number | 2% |
| `fills[].corrected.fromPrice` | number | 2% |
| `fills[].corrected.state` | string | 2% |
| `fills[].foldDone` | boolean | 2% |
| `fills[].corrected.clientOrderId` | string | 0% |
| `flatten` | object | 0% |
| `flatten.legs` | array | 0% |
| `flatten.legs[]` | object | 0% |
| `flatten.legs[].tradingsymbol` | string | 0% |
| `flatten.legs[].positionQty` | number | 0% |
| `flatten.legs[].side` | string | 0% |
| `flatten.legs[].qty` | number | 0% |
| `flatten.legs[].orderType` | string | 0% |
| `flatten.legs[].limitPrice` | number | 0% |
| `flatten.legs[].routed` | boolean | 0% |
| `flatten.legs[].error` | string | 0% |
| `flatten.legs[].degraded` | string | 0% |
| `flatten.unpriceable` | array | 0% |
| `flatten.unresolved` | array | 0% |
| `flatten.truncated` | array | 0% |
| `flatten.malformedFills` | array | 0% |
| `flatten.fillsTruncated` | boolean | 0% |
| `flatten.flat` | boolean | 0% |
| `flatten.emptyWindow` | boolean | 0% |
| `flatten.window` | object | 0% |
| `flatten.window.from` | number | 0% |
| `flatten.window.to` | number | 0% |
| `routeErrors[]` | object | 0% |
| `routeErrors[].fill` | object | 0% |
| `routeErrors[].fill.op` | string | 0% |
| `routeErrors[].fill.deskTag` | string | 0% |
| `routeErrors[].fill.tradingsymbol` | string | 0% |
| `routeErrors[].fill.side` | string | 0% |
| `routeErrors[].fill.qty` | number | 0% |
| `routeErrors[].fill.price` | number | 0% |
| `routeErrors[].fill.ts` | number | 0% |
| `routeErrors[].fill.orderType` | string | 0% |
| `routeErrors[].fill.limitPrice` | number | 0% |
| `routeErrors[].error` | string | 0% |

## desk-declarations

9 rows; sampled 9.

| field | type | presence |
|---|---|---:|
| `tag` | string | 100% |
| `declaredAt` | number | 100% |
| `legs` | array | 100% |
| `legs[]` | object | 67% |
| `legs[].strike` | number | 67% |
| `legs[].type` | string | 67% |
| `legs[].qty` | number | 67% |
| `symbol` | string | 100% |
| `greeks` | object | 33% |
| `greeks.delta` | number | 33% |
| `greeks.gamma` | number | 33% |
| `greeks.theta` | number | 33% |
| `greeks.vega` | number | 33% |
| `greeks.spot` | number | 33% |
| `greeks.dte` | number | 33% |
| `greeks.steeringDelta` | number | 33% |
| `greeks.steeringGamma` | number | 33% |
| `greeksAt` | number | 33% |

## desk-engine-decisions

2,302 rows; sampled 500.

| field | type | presence |
|---|---|---:|
| `decisionId` | string | 100% |
| `actions` | array | 100% |
| `actions[]` | object | 100% |
| `actions[].op` | string | 100% |
| `actions[].instrument` | string | 100% |
| `actions[].side` | string | 86% |
| `actions[].qty` | number | 86% |
| `actions[].workMode` | string | 82% |
| `expiry` | string | 100% |
| `mode` | string | 100% |
| `posts` | number | 100% |
| `reason` | string | 100% |
| `receivedAt` | number | 100% |
| `response` | object | 100% |
| `response.decisionId` | string | 100% |
| `response.replayed` | boolean | 100% |
| `response.status` | string | 100% |
| `response.fills` | array | 100% |
| `response.skips` | array | 100% |
| `response.routeErrors` | array | 100% |
| `symbol` | string | 100% |
| `tag` | string | 100% |
| `trigger` | string | 100% |
| `response.skips[]` | object | 64% |
| `response.skips[].instrument` | string | 64% |
| `response.skips[].reason` | string | 64% |
| `actions[].leanId` | string | 26% |
| `actions[].add` | boolean | 3% |

## desk-fills

4,156 rows; sampled 500.

| field | type | presence |
|---|---|---:|
| `clientOrderId` | string | 100% |
| `baseClientOrderId` | string | 100% |
| `brokerOrderId` | string | 100% |
| `tradingsymbol` | string | 100% |
| `status` | string | 100% |
| `filledQty` | number | 100% |
| `avgPrice` | null | number | 100% |
| `ts` | number | 100% |
| `tag` | string | 100% |
| `mode` | string | 100% |
| `desk_tag` | string | 96% |
| `desk_op` | string | 96% |
| `exchangeToken` | number | 65% |

## desk-freeze-limits

225 rows; sampled 225.

| field | type | presence |
|---|---|---:|
| `symbol` | string | 100% |
| `freezeQty` | number | 100% |
| `lotSize` | number | 1% |
| `source` | string | 1% |
| `syncedAt` | number | 1% |

## desk-gateway-orders

1,621 rows; sampled 500.

| field | type | presence |
|---|---|---:|
| `status` | string | 62% |
| `order_timestamp` | date | 100% |
| `exchange` | string | 100% |
| `tradingsymbol` | string | 100% |
| `instrument_token` | number | 100% |
| `tickSize` | number | 90% |
| `order_type` | string | 100% |
| `limitPrice` | number | 100% |
| `workMode` | string | 87% |
| `trancheLots` | number | 87% |
| `chaseMaxMs` | number | 87% |
| `chaseCrossBufferPct` | number | 87% |
| `transaction_type` | string | 100% |
| `quantity` | number | 100% |
| `filled_quantity` | number | 62% |
| `tag` | string | 100% |
| `underlying` | string | 100% |
| `desk_tag` | string | 100% |
| `desk_op` | string | 100% |
| `price` | number | 62% |
| `clientOrderId` | string | 100% |
| `dataObj` | array | 100% |
| `state` | string | 100% |
| `createdAt` | number | 100% |
| `mode` | string | 87% |
| `claimedAt` | number | 100% |
| `claimedBy` | string | 100% |
| `placeAttempts` | number | 98% |
| `placementStartedAt` | number | 98% |
| `ambiguousTrancheIds` | array | 98% |
| `brokerOrderIds` | array | 100% |
| `expectedQty` | number | 100% |
| `failedTrancheIds` | array | 100% |
| `placedAt` | number | 100% |
| `trancheIds` | array | 100% |
| `avgPrice` | null | number | 100% |
| `filledQty` | number | 100% |
| `resolvedAt` | number | 100% |
| `deskFolded` | boolean | 87% |
| `deskFoldedAt` | number | 87% |
| `markPrice` | number | 38% |
| `leanId` | string | 13% |
| `deskReconciled` | boolean | 13% |
| `deskReconciledAt` | number | 13% |
| `trancheCursor` | number | 14% |
| `tranchePlan` | array | 14% |
| `tranchePlan[]` | object | 14% |
| `tranchePlan[].qty` | number | 14% |
| `trancheArmedAt` | number | 14% |
| `chaseAttempts` | number | 8% |
| `chasedAt` | number | 8% |
| `lastChasePrice` | number | 8% |
| `reason` | string | 2% |
| `pegCrossedAt` | number | 5% |
| `chaseExhaustedAt` | number | 1% |
| `workingAlertedAt` | number | 0% |

## desk-marks

5,946 rows; sampled 500.

| field | type | presence |
|---|---|---:|
| `token` | number | 100% |
| `price` | number | 100% |
| `ts` | number | 100% |
| `ask` | null | number | 86% |
| `bid` | null | number | 86% |
| `bookTs` | null | number | 86% |

## desk-order-events

16,494 rows; sampled 500.

| field | type | presence |
|---|---|---:|
| `clientOrderId` | string | 100% |
| `phase` | string | 100% |
| `ok` | boolean | 100% |
| `tag` | string | 100% |
| `tradingsymbol` | string | 100% |
| `ts` | number | 100% |
| `detail` | object | 95% |
| `detail.lots` | number | 12% |
| `detail.quantity` | number | 11% |
| `detail.orderType` | string | 11% |
| `detail.mode` | string | 92% |
| `error` | string | 16% |
| `detail.op` | string | 18% |
| `detail.deskTag` | string | 21% |
| `detail.decisionId` | string | 21% |
| `detail.tranches` | array | number | 25% |
| `detail.orders` | number | 14% |
| `detail.underlying` | string | 14% |
| `detail.underlyingSource` | string | 14% |
| `side` | string | 13% |
| `filledQty` | number | 50% |
| `avgPrice` | null | number | 47% |
| `status` | string | 58% |
| `detail.source` | string | 14% |
| `detail.book` | string | 11% |
| `detail.side` | string | 1% |
| `detail.reducesExposure` | boolean | 1% |
| `detail.clientOrderId` | string | 1% |
| `detail.expectedQty` | number | 11% |
| `detail.note` | string | 4% |
| `detail.trancheCursor` | number | 3% |
| `brokerOrderId` | string | 10% |
| `detail.workTranche` | string | 4% |
| `detail.tranchePlan` | array | 4% |
| `errorClass` | string | 0% |
| `detail.price` | number | 1% |
| `detail.bid` | number | 1% |
| `detail.ask` | number | 1% |
| `detail.crossBufferPct` | number | 1% |
| `detail.modified` | number | 1% |
| `detail.live` | number | 1% |
| `detail.state` | string | 1% |
| `detail.bookedQty` | number | 1% |
| `detail.from` | number | 0% |
| `detail.instance` | string | 0% |
| `detail.corrections` | array | 0% |
| `detail.corrections[]` | object | 0% |
| `detail.corrections[].tradingsymbol` | string | 0% |
| `detail.corrections[].lots` | number | 0% |
| `detail.requestedAt` | number | 0% |
| `detail.reason` | string | 0% |
| `detail.claimedBy` | array | 0% |
| `detail.broker` | number | 0% |
| `detail.books` | number | 0% |
| `detail.ledger` | number | 0% |

## desk-paper-trade

5,931 rows; sampled 500.

| field | type | presence |
|---|---|---:|
| `status` | string | 100% |
| `order_timestamp` | date | 100% |
| `exchange` | string | 100% |
| `tradingsymbol` | string | 100% |
| `instrument_token` | number | 100% |
| `tickSize` | number | 74% |
| `order_type` | string | 100% |
| `limitPrice` | number | 84% |
| `transaction_type` | string | 100% |
| `quantity` | number | 100% |
| `filled_quantity` | number | 100% |
| `tag` | string | 100% |
| `underlying` | string | 100% |
| `desk_tag` | string | 100% |
| `desk_op` | string | 100% |
| `price` | number | 100% |
| `clientOrderId` | string | 100% |
| `dataObj` | array | 100% |
| `mode` | string | 100% |

## desk-payoff-snapshots

1,471 rows; sampled 500.

| field | type | presence |
|---|---|---:|
| `tag` | string | 100% |
| `mode` | string | 100% |
| `ts` | number | 100% |
| `kind` | string | 100% |
| `payload` | object | 100% |
| `payload.tag` | string | 100% |
| `payload.mode` | string | 100% |
| `payload.symbol` | string | 97% |
| `payload.expiry` | string | 97% |
| `payload.future` | null | number | 97% |
| `payload.spot` | number | 97% |
| `payload.asOf` | number | 100% |
| `payload.view` | null | object | 97% |
| `payload.view.curve` | array | 97% |
| `payload.view.table` | array | 97% |
| `payload.view.midDate` | string | 97% |
| `payload.view.summary` | object | 97% |
| `payload.view.greeks` | object | 97% |
| `payload.view.warnings` | array | 97% |
| `payload.machine` | object | 97% |
| `payload.machine.deltaTolPct` | number | 97% |
| `payload.machine.deltaImbalance` | null | number | 97% |
| `payload.machine.wouldRebalance` | boolean | null | 97% |
| `payload.machine.shiftEnabled` | boolean | null | 97% |
| `payload.machine.marginFrac` | null | number | 97% |
| `payload.machine.targetPnl` | number | 97% |
| `payload.machine.notes` | array | 97% |
| `payload.ivs` | array | 97% |
| `payload.ivs[]` | object | 96% |
| `payload.ivs[].strike` | number | 96% |
| `payload.ivs[].type` | string | 96% |
| `payload.ivs[].iv` | null | number | 96% |
| `payload.ivs[].source` | string | 96% |
| `payload.warnings` | array | 100% |
| `payload.marketClosed` | boolean | 79% |
| `payload.dials` | object | 3% |
| `payload.dials.addDeltaMin` | number | 3% |
| `payload.dials.addDeltaMax` | number | 3% |
| `payload.dials.shiftDeltaMin` | number | 3% |
| `payload.dials.shiftDeltaMax` | number | 3% |
| `payload.dials.hedgeDeltaMax` | number | 3% |
| `payload.dials.hedgeBudgetFrac` | number | 3% |
| `payload.dials.minCreditPerShare` | number | 3% |
| `payload.dials.maxMarginAdd` | null | 3% |
| `payload.dials.maxQuoteAgeMs` | number | 3% |
| `payload.dials.lotSize` | number | 3% |
| `payload.legsPrint` | string | 1% |
| `payload.goals` | array | 3% |
| `payload.goals[]` | object | 2% |
| `payload.goals[].goal` | string | 2% |
| `payload.goals[].plans` | array | 2% |
| `payload.universe` | object | 3% |
| `payload.universe.atomic` | number | 3% |
| `payload.universe.evaluated` | number | 3% |

## desk-pnl-snapshots

484,817 rows; sampled 500.

| field | type | presence |
|---|---|---:|
| `tag` | string | 100% |
| `mode` | string | 100% |
| `ts` | number | 100% |
| `realised` | number | 100% |
| `unrealised` | null | number | 100% |
| `total` | null | number | 100% |

## desk-positions-compare

1 rows; sampled 1.

| field | type | presence |
|---|---|---:|
| `asOf` | number | 100% |
| `brokerAsOf` | number | 100% |
| `comparable` | boolean | 100% |
| `day` | string | 100% |
| `divergent` | array | 100% |
| `intervalMs` | number | 100% |
| `mode` | string | 100% |
| `reason` | string | 100% |
| `symbols` | array | 100% |
| `unattributable` | array | 100% |
| `unmeasurable` | array | 100% |

## desk-repair-applies

2 rows; sampled 2.

| field | type | presence |
|---|---|---:|
| `tag` | string | 100% |
| `mode` | string | 100% |
| `style` | string | 100% |
| `bookPrint` | string | 100% |
| `state` | string | 100% |
| `orders` | array | 100% |
| `orders[]` | object | 100% |
| `orders[].clientOrderId` | string | 100% |
| `orders[].wave` | string | 100% |
| `orders[].planned` | object | 100% |
| `orders[].planned.wave` | string | 100% |
| `orders[].planned.moveIndex` | number | 100% |
| `orders[].planned.side` | string | 100% |
| `orders[].planned.instrument` | object | 100% |
| `orders[].planned.strike` | number | 100% |
| `orders[].planned.type` | string | 100% |
| `orders[].planned.expiry` | string | 100% |
| `orders[].planned.lots` | number | 100% |
| `orders[].planned.reducesExposure` | boolean | 100% |
| `orders[].planned.deskTag` | string | 100% |
| `orders[].status` | string | 100% |
| `createdAt` | number | 100% |
| `updatedAt` | number | 100% |

## desk-safety

1 rows; sampled 1.

| field | type | presence |
|---|---|---:|
| `applied` | string | 100% |
| `appliedAt` | number | 100% |
| `appliedError` | string | 100% |
| `desired` | string | 100% |
| `reason` | string | 100% |
| `setAt` | number | 100% |
| `setBy` | string | 100% |

## desk-sessions

3 rows; sampled 3.

| field | type | presence |
|---|---|---:|
| `token` | string | 100% |
| `username` | string | 100% |
| `createdAt` | number | 100% |
| `expiresAt` | number | 100% |
| `lastSeenAt` | number | 100% |

## desk-strategies

51 rows; sampled 51.

| field | type | presence |
|---|---|---:|
| `kind` | string | 100% |
| `label` | string | 100% |
| `modes` | object | 100% |
| `modes.paper` | object | 100% |
| `modes.paper.enabled` | boolean | 100% |
| `liveLots` | number | 100% |
| `autostartAt` | string | 100% |
| `lastSeenAt` | number | 100% |
| `disabledReason` | string | 100% |
| `updatedAt` | number | 100% |
| `tag` | string | 100% |
| `dailyLimits` | object | 37% |
| `dailyLimits.stop` | number | 37% |
| `modes.live` | object | 4% |
| `modes.live.enabled` | boolean | 4% |
| `dailyLimits.target` | number | 4% |

## desk-strategy-runtime

18 rows; sampled 18.

| field | type | presence |
|---|---|---:|
| `tag` | string | 100% |
| `mode` | string | 100% |
| `host` | string | 100% |
| `key` | string | 100% |
| `lastError` | null | string | 100% |
| `openPositions` | number | 100% |
| `startedAt` | number | 100% |
| `state` | string | 100% |
| `updatedAt` | number | 100% |

## desk-strategy-state

35 rows; sampled 35.

| field | type | presence |
|---|---|---:|
| `key` | string | 100% |
| `tag` | string | 100% |
| `updatedAt` | number | 100% |
| `value` | array | object | 100% |
| `value[]` | object | 11% |
| `value[].tradingsymbol` | string | 11% |
| `value[].instrument` | object | 11% |
| `value[].instrument.tradingsymbol` | string | 11% |
| `value[].instrument.instrumentToken` | number | 11% |
| `value[].instrument.lotSize` | number | 11% |
| `value[].instrument.tickSize` | number | 11% |
| `value[].instrument.exchange` | string | 11% |
| `value[].lots` | number | 11% |
| `value[].lastPrice` | number | 11% |
| `value[].expiry` | string | 11% |
| `value.sessionDay` | string | 34% |
| `value.value` | object | 34% |
| `value.value.day` | object | 23% |
| `value.value.future` | null | object | 23% |
| `value.value.futureEntryTs` | null | 23% |
| `value.value.option` | null | 23% |
| `value.value.optionEntryTs` | null | 23% |
| `value.value.currentSize` | number | 9% |
| `value.value.groups` | array | 9% |
| `value.value.openAtms` | array | 9% |
| `value.value.entered` | boolean | 3% |
| `value.value.pending` | array | 3% |
| `value.value.legs` | array | 3% |

## desk-submissions

20,760 rows; sampled 500.

| field | type | presence |
|---|---|---:|
| `clientOrderId` | string | 100% |
| `tag` | string | 100% |
| `mode` | string | 100% |
| `tradingsymbol` | string | 100% |
| `side` | string | 100% |
| `requestedLots` | number | 100% |
| `lots` | number | 100% |
| `accepted` | boolean | 100% |
| `reason` | string | 100% |
| `orders` | array | 100% |
| `orders[]` | object | 42% |
| `orders[].clientOrderId` | string | 42% |
| `orders[].lots` | number | 42% |
| `orders[].qty` | number | 42% |
| `status` | string | 100% |
| `routeErrors` | array | 100% |
| `createdAt` | number | 100% |
| `freezeMaxLots` | null | number | 100% |
| `plannedOrders` | array | 42% |
| `plannedOrders[]` | object | 42% |
| `plannedOrders[].clientOrderId` | string | 42% |
| `plannedOrders[].lots` | number | 42% |
| `plannedOrders[].qty` | number | 42% |
| `underlying` | string | 42% |
| `price` | number | 42% |
| `op` | string | 42% |
| `orderType` | string | 36% |
| `limitPrice` | number | 36% |
| `completedAt` | number | 42% |

## desk-subscriptions

2 rows; sampled 2.

| field | type | presence |
|---|---|---:|
| `source` | string | 100% |
| `tokens` | array | 100% |
| `updatedAt` | number | 100% |

## desk-supervisor-lease

1 rows; sampled 1.

| field | type | presence |
|---|---|---:|
| `key` | string | 100% |
| `acquiredAt` | number | 100% |
| `expiresAt` | number | 100% |
| `owner` | string | 100% |

## desk-supervisor-state

105 rows; sampled 105.

| field | type | presence |
|---|---|---:|
| `key` | string | 100% |
| `updatedAt` | number | 100% |
| `cumRealized` | number | 100% |
| `cumRealizedBasis` | array | 100% |
| `inFlight` | null | string | 100% |
| `protectedQty` | object | 100% |
| `ruleState` | object | 100% |
| `ruleState.rcCredit` | number | 100% |
| `ruleState.rcEodDay` | string | 100% |
| `ruleState.gkAnchor` | number | 100% |
| `ruleState.gkStreak` | number | 100% |
| `ruleState.scrapBanned` | array | 100% |
| `ruleState.targetStreak` | number | 100% |
| `ruleState.targetLocked` | boolean | 100% |
| `ruleState.rcStack` | array | 100% |
| `ruleState.rcStack[]` | object | 6% |
| `ruleState.rcStack[].strike` | number | 6% |
| `ruleState.rcStack[].optType` | string | 6% |
| `ruleState.rcStack[].lots` | number | 6% |
| `ruleState.lastActionMs` | number | 100% |
| `ruleState.dlDayStarted` | string | 100% |
| `ruleState.dlStopped` | boolean | 100% |
| `ruleState.dlOpenedMs` | number | 93% |
| `ruleState.dlOpenSide` | string | 93% |
| `ruleState.dlAdjustsToday` | number | 93% |
| `ruleState.dlLastAdjustMs` | number | 93% |
| `ruleState.dlLastAdjustRegime` | string | 93% |
| `ruleState.dlRegime` | string | 100% |
| `ruleState.dlRegimeSinceMs` | number | 100% |
| `ruleState.dlBlockedSinceMs` | number | 93% |
| `ruleState.dlDayRealized` | number | 93% |
| `ruleState.pb` | object | 22% |
| `ruleState.pb.dayOpen` | number | 22% |
| `ruleState.pb.dayHigh` | number | 22% |
| `ruleState.pb.dayLow` | number | 22% |
| `ruleState.pb.statsFromMs` | number | 22% |
| `ruleState.pb.statsLastMs` | number | 22% |
| `ruleState.pb.maxGapMs` | number | 22% |
| `ruleState.pb.dayImplied` | number | 22% |
| `ruleState.pb.entries` | number | 22% |
| `ruleState.pb.tradeOpenMs` | number | 22% |
| `ruleState.pb.side` | string | 22% |
| `ruleState.pb.stage` | number | 22% |
| `ruleState.pb.planShorts` | array | 22% |
| `ruleState.pb.planLots` | number | 22% |
| `ruleState.pb.stageMs` | number | 22% |
| `ruleState.pb.stageSpot` | number | 22% |
| `ruleState.pb.stageReadyMs` | number | 22% |
| `ruleState.pb.entrySpot` | number | 22% |
| `ruleState.pb.entryStr` | number | 22% |
| `ruleState.pb.entryExtreme` | number | 22% |
| `ruleState.pb.boxHi` | number | 22% |
| `ruleState.pb.boxLo` | number | 22% |
| `ruleState.pb.basePnl` | number | 22% |
| `ruleState.pb.peakPnl` | number | 22% |
| `ruleState.pb.trailArmed` | boolean | 22% |
| `ruleState.pb.adds` | number | 22% |
| `ruleState.pb.condSinceMs` | number | 22% |
| `ruleState.pb.rupeeSinceMs` | number | 22% |
| `ruleState.pb.exiting` | boolean | 22% |
| `ruleState.pb.exitReason` | string | 22% |
| `ruleState.pb.exitUrgency` | string | 22% |
| `ruleState.pb.exitMs` | number | 22% |
| `ruleState.pb.doneForDay` | boolean | 22% |
| `ruleState.pb.lastExitMs` | number | 22% |
| `ruleState.pb.dayLineSinceMs` | number | 22% |
| `seq` | number | 100% |
| `workingPackage` | null | object | 100% |
| `cumRealizedBasis[]` | object | 92% |
| `cumRealizedBasis[].decisionId` | string | 92% |
| `cumRealizedBasis[].basis` | string | 92% |
| `cumRealizedBasis[].amount` | number | 92% |
| `cumRealizedBasis[].at` | number | 92% |
| `workingPackage.decisionId` | string | 3% |
| `workingPackage.remaining` | array | 3% |
| `workingPackage.remaining[]` | object | 3% |
| `workingPackage.remaining[].op` | string | 3% |
| `workingPackage.remaining[].instrument` | string | 3% |
| `workingPackage.remaining[].workMode` | string | 3% |
| `workingPackage.request` | object | 3% |
| `workingPackage.request.tag` | string | 3% |
| `workingPackage.request.mode` | string | 3% |
| `workingPackage.request.decisionId` | string | 3% |
| `workingPackage.request.symbol` | string | 3% |
| `workingPackage.request.expiry` | string | 3% |
| `workingPackage.request.trigger` | string | 3% |
| `workingPackage.request.reason` | string | 3% |
| `workingPackage.request.actions` | array | 3% |
| `workingPackage.request.work` | object | 3% |
| `workingPackage.basis` | array | 3% |
| `workingPackage.basis[]` | object | 3% |
| `workingPackage.basis[].instrument` | string | 3% |
| `workingPackage.basis[].leanId` | string | 3% |
| `workingPackage.basis[].strike` | number | 3% |
| `workingPackage.basis[].optType` | string | 3% |
| `workingPackage.basis[].side` | string | 3% |
| `workingPackage.basis[].op` | string | 3% |
| `workingPackage.basis[].entry` | number | 3% |
| `workingPackage.basis[].lots` | number | 3% |
| `workingPackage.basis[].lotSize` | number | 3% |
| `workingPackage.basis[].intentQty` | number | 3% |
| `workingPackage.formedAt` | number | 3% |
| `workingPackage.formedSpot` | number | 3% |
| `ruleState.dlLeanId` | string | 7% |
| `ruleState.dlLeanSide` | string | 7% |
| `ruleState.dlLeanOpenedMs` | number | 7% |
| `ruleState.dlLeanPeak` | number | 7% |
| `ruleState.dlLeanRealized` | number | 7% |
| `ruleState.dlLeanPnlAtLastAdd` | number | 7% |
| `ruleState.dlLeanAdds` | number | 7% |
| `ruleState.dlTargetLots` | number | 7% |
| `ruleState.dlFlipsToday` | number | 7% |
| `ruleState.dlFlipsInHour` | number | 7% |
| `ruleState.dlFlipHourStartMs` | number | 7% |
| `ruleState.dlLastFlipMs` | number | 7% |
| `ruleState.dlLastAddMs` | number | 7% |
| `ruleState.dlLastUnwindMs` | number | 7% |

## desk-users

1 rows; sampled 1.

| field | type | presence |
|---|---|---:|
| `username` | string | 100% |
| `passwordHash` | string | 100% |
| `createdAt` | number | 100% |
| `lastLoginAt` | number | 100% |
| `failedAttempts` | number | 100% |
| `lastFailureAt` | null | 100% |
| `lockedUntil` | null | 100% |

## desk-variants

40 rows; sampled 40.

| field | type | presence |
|---|---|---:|
| `key` | string | 100% |
| `decider` | string | 100% |
| `playbook` | string | 100% |
| `defaults` | object | 100% |
| `defaults.delta_pct_band` | number | 40% |
| `defaults.strikes_out` | number | 73% |
| `defaults.delta_band_lots` | number | 43% |
| `defaults.delta_tol_pct` | number | 55% |
| `defaults.recover_frac` | number | 20% |
| `defaults.min_sell_dte` | number | 65% |
| `defaults.target_pnl` | number | 100% |
| `defaults.cooldown_min` | number | 100% |
| `defaults.no_buy` | boolean | 95% |
| `defaults.no_close` | boolean | 68% |
| `defaults.margin_cap` | number | 100% |
| `defaults.z_act` | number | 5% |
| `defaults.z_freeze` | number | 5% |
| `defaults.z_target` | number | 5% |
| `defaults.theta_floor_frac` | number | 5% |
| `defaults.scrap_close_delta` | number | 38% |
| `defaults.min_sell_delta` | number | 20% |
| `defaults.unwind_added_first` | boolean | 20% |
| `defaults.unwind_share` | number | 20% |
| `defaults.tol_ref_dte` | number | 30% |
| `defaults.balance_min_dte` | number | 20% |
| `defaults.unwind_entry_book` | boolean | 20% |
| `defaults.wing_frac` | number | 3% |
| `defaults.wing_steps` | number | 3% |
| `defaults.gamma_shorts_only` | boolean | 3% |
| `defaults.roll_delta` | number | 25% |
| `defaults.close_dte` | number | 35% |
| `defaults.recover_mult` | number | 8% |
| `defaults.recover_tv_cap_mult` | number | 8% |
| `defaults.side_cap_mult` | number | 10% |
| `defaults.eod_flat_min` | number | 5% |
| `defaults.st_period` | number | 3% |
| `defaults.st_mult` | number | 3% |
| `defaults.st_offset_steps` | number | 3% |
| `defaults.reenter_min_dte` | number | 3% |
| `defaults.breach_delta` | number | 8% |
| `defaults.gap_pct` | number | 15% |
| `defaults.gap_settle_filter_min` | number | 8% |
| `defaults.harvest_target_lots` | number | 8% |
| `defaults.harvest_max_lots` | number | 8% |
| `defaults.harvest_otm_steps` | number | 8% |
| `defaults.trend_confirm_marks` | number | 3% |
| `defaults.sell_cooldown_min` | number | 8% |
| `defaults.check_every_min` | number | 5% |
| `defaults.recycle_frac` | number | 5% |
| `defaults.recycle_bank` | boolean | 5% |
| `defaults.recycle_opposite` | boolean | 3% |
| `defaults.wing_width` | number | 15% |
| `defaults.tv_floor` | number | 15% |
| `defaults.reload_min_dte` | number | 13% |
| `defaults.reload_frac` | number | 15% |
| `defaults.add_offset` | number | 13% |
| `defaults.naked_gate_mult` | number | 10% |
| `defaults.naked_gate_min` | number | 10% |
| `defaults.widen_after_rolls` | number | 10% |
| `defaults.widen_strikes_out` | number | 10% |
| `defaults.overshoot_frac` | number | 10% |
| `defaults.dying_ltp_frac` | number | 10% |
| `defaults.gamma_dte_window` | number | 10% |
| `defaults.lock_branch_lots` | number | 18% |
| `defaults.lock_trail_frac` | number | 10% |
| `defaults.lock_executability` | boolean | 10% |
| `defaults.margin_persist_marks` | number | 10% |
| `defaults.loss_shift_mult` | number | 3% |
| `defaults.profit_shift_mult` | number | 3% |
| `defaults.shift_qty_cap_mult` | number | 3% |
| `defaults.min_px_frac` | number | 3% |
| `defaults.max_px_frac` | number | 3% |
| `defaults.trend_skew` | number | 3% |
| `defaults.wing_narrow_after_rolls` | number | 3% |
| `defaults.wing_narrow_width` | number | 3% |
| `defaults.wing_hold_to_expiry` | boolean | 3% |
| `defaults.breach_confirm_marks` | number | 3% |
| `defaults.breach_ban_permanent` | boolean | 3% |
| `defaults.max_breach_cuts` | number | 8% |
| `defaults.whipsaw_stop_sessions` | number | 8% |
| `defaults.max_rolls_same_dir` | number | 3% |
| `defaults.roll_away_side_only` | boolean | 3% |
| `defaults.roll_warmup_ban` | boolean | 3% |
| `defaults.roll_must_reduce_size` | boolean | 3% |
| `defaults.stress_roll_frac` | number | 5% |
| `defaults.hedge_side_gate` | boolean | 3% |
| `defaults.hedge_side_lookback` | number | 3% |
| `defaults.hedge_unwind_min_sessions` | number | 3% |
| `defaults.naked_lot_ceiling_mult` | number | 3% |
| `defaults.gap_block_min` | number | 8% |
| `defaults.target_confirm_marks` | number | 8% |
| `defaults.target_snap_multiple` | number | 8% |
| `defaults.lock_exclude_mark0` | boolean | 8% |
| `defaults.regime_lookback` | number | 8% |
| `defaults.regime_trend_pct` | number | 8% |
| `defaults.regime_sticky_sessions` | number | 8% |
| `defaults.shift_itm_steps` | number | 8% |
| `defaults.shift_land_steps` | number | 8% |
| `defaults.shift_margin_frac` | number | 3% |
| `defaults.hedge_after_shift` | boolean | 3% |
| `defaults.reload_margin_headroom` | number | 3% |
| `defaults.wing_pct` | number | 3% |
| `defaults.min_band_lots` | number | 8% |
| `defaults.recover_max_episodes` | number | 5% |
| `defaults.recover_reachable_sessions` | number | 5% |
| `defaults.roll_size_ratio` | number | 5% |
| `defaults.away_roll_size_ratio` | number | 5% |
| `defaults.full_size_rolls` | number | 5% |
| `defaults.max_package_lots` | number | 5% |
| `defaults.hedge_clip_frac` | number | 5% |
| `defaults.hedge_flip_resolve_episode` | number | 5% |
| `defaults.hedge_dedupe_min` | number | 5% |
| `defaults.session1_roll_chain` | number | 5% |
| `defaults.crash_move_pct` | number | 5% |
| `defaults.breach_cut_min_leg_age` | number | 5% |
| `defaults.min_roll_otm_itm_only` | boolean | 5% |
| `defaults.dte7_naked_block` | number | 5% |
| `defaults.dte7_purpose_gate` | boolean | 5% |
| `defaults.anchor_ema_marks` | number | 3% |
| `defaults.confirm_marks` | number | 3% |
| `defaults.lock_unthrottled` | boolean | 8% |
| `defaults.roll_out_steps` | number | 3% |
| `defaults.defend_min_delta` | number | 3% |
| `defaults.trend_lookback` | number | 5% |
| `defaults.trend_move_pct` | number | 5% |
| `defaults.trend_eff_min` | number | 3% |
| `defaults.storm_path_pct` | number | 3% |
| `defaults.storm_band_mult` | number | 3% |
| `defaults.mode_min_sessions` | number | 5% |
| `defaults.ban_sessions` | number | 5% |
| `defaults.harvest_band_lots` | number | 5% |
| `defaults.harvest_close_dte` | number | 5% |
| `defaults.max_loss` | number | 3% |
| `defaults.stop_confirm_marks` | number | 3% |
| `defaults.shift_strikes` | number | 3% |
| `defaults.min_roll_otm_pct` | number | 3% |

## instrument

10,015 rows; sampled 500.

| field | type | presence |
|---|---|---:|
| `instrument_token` | number | 100% |
| `exchange` | string | 100% |
| `expiry` | string | 100% |
| `instrument_type` | string | 100% |
| `lot_size` | number | 100% |
| `name` | string | 100% |
| `segment` | string | 100% |
| `strike` | number | 100% |
| `tick_size` | number | 100% |
| `tradingsymbol` | string | 100% |
