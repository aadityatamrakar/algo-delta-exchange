# SDD ledger — plan: docs/superpowers/plans/2026-08-21-recenter-supervisor-migration.md

Spec: docs/superpowers/specs/2026-08-21-recenter-supervisor-migration-design.md (binding authority)
Tickets (what+deps): .scratch/recenter-migration/issues/ (20 tickets; ticket 01 = plan Tasks 1-3, ticket NN maps per its "Plan:" line)
Integration branch: recenter-migration, forked from master @ 77299c16 (includes the other session's Repair Apply commits from today)
Execution mode: parallel implementer subagents in ISOLATED WORKTREES (Agent isolation:'worktree'), controller merges reviewed branches serially into recenter-migration.

## Pre-flight conflict scan

| Pair / task | Produces vs consumes | Found |
|---|---|---|
| T1 ↔ every task | canonical types/contract | clean — single source, others import |
| T3 marking ↔ T6 corridor | LegView w/ hasGreeks → population sums | clean |
| T5 marking ↔ T8 shed | strikeGreeks(null-not-0.30) → dps | clean |
| T7 shift ↔ T10 decide | phaseShift(inputs,dials,state) signature | clean |
| T8/T9 shed+tiers ↔ T10 decide | phaseShed + tiers composition | clean |
| T11 api ↔ T1 contract | WireAction.qty = CONTRACTS; engine lots | clean — host converts (plan self-review note) |
| T11 api ↔ T18 paper lifecycle | T11 paper=instant fills, T18 flips engine path to WORKING | sequenced (16 blocked by 9+13); no contradiction |
| T13/T17 tranches ↔ T11 rail | trancheLots threaded api→rail→gateway | clean — defined in tranche task |
| T15 supervisor ↔ T11 nudges | SUPERVISOR_NUDGE_PORT_DEFAULT shared via contract.ts | clean |
| T19 web ↔ T3 dials.ts | UI ticket ADDS DIAL_SECTIONS to engine dials.ts | cross-lane file touch — run UI after engine lane merged, or accept small merge |
| Task 8 self | `strikes_out` in shift-path shed | spec flags verify-during-port; implementer must confirm vs playbooks.py and drop/keep with citation |
| Plan vs skill | parallel dispatch forbidden by SDD text | Ruling below |

Ruling: parallel implementers allowed despite SDD's never-parallel rule — the user explicitly requested parallelization; conflict rationale removed via per-agent worktree isolation + controller-serialized merges. Cost if wrong: merge conflicts I resolve by hand.
Ruling: base is 77299c16 (master incl. today's Repair Apply work), not the plan-commit base — building on stale master would guarantee a painful rebase at cutover. Cost if wrong: none foreseeable.

## Progress
Ticket 01 (plan T1-3): dispatched, opus, worktree, BASE 77299c16
Ticket 02 (plan T4):  dispatched, opus, worktree, BASE 77299c16
Ticket 01: implementer DONE_WITH_CONCERNS (b2a0d30d..4d8a551e on worktree-agent-a40b53bb0bd3d4d54)
Ruling: lock_exclude_mark0/lock_executability/target_snap_multiple/lock_branch_lots absent from Dials is NOT a ticket-01 defect — they are added in the orchestrator task (plan T10) where their semantics land; carried into ticket 08 dispatch. Cost if wrong: small schema addition later.
Ruling: presets transliterated from Python primary source (playbooks.py/variants.py) since the exploration-report doc is conversation-only — primary source is strictly better. Cost if wrong: none.
Ticket 02: implementer COMPLETE (f4438ac6 on worktree-agent-ade90e50bb60295af); 12 files/1152 marks/642 non-hold; deterministic. NOTE for tickets 06/07: builders' ctx was PATCHED (gamma, gross_mtm, ctx.playbook) — parity adapter must read ticket-02-report.md. P.PLAYBOOKS is actually P.REGISTRY.
Ticket 02: complete (77299c16..f4438ac6, review clean, merged to recenter-migration)
Ticket 02: minor (deferred): fixtures 8.1MB in-tree — implementer offered trim to ~6.5MB (drop rally-itm-uncapped, big-book-flat-mark, big-book-down-unwind); Ruling: keep full coverage for now, final review triages. Cost if wrong: repo bloat ~2MB.
Ticket 02: minor (deferred): gamma is a normal-kernel approximation, not bs_greeks — add a one-line script note comparing to pricing.py:182.
Ticket 01: review verdict Needs fixes — Important: 8 non-relief presets wrongly inherit delta/gamma_shorts_only true (whole-book steering in Python); Minor: report table said 13 tests, file has 11. Fix round 1/5 dispatched (resumed original implementer).
Ticket 01: reviewer ⚠️ on lock_* dials absent from Dials — already ruled pre-review (goes to ticket 08); no action.
Ticket 01: fix round 1/5 (2 findings claimed addressed — shorts-only leak on 8 presets + report-table counts; commit 1e1b6feb; scoped re-review dispatched)
Ticket 01: fix round 1/5 (2 addressed, 0 open; commit 1e1b6feb; re-review clean)
Ticket 01: complete (77299c16..1e1b6feb, review clean after 1 fix round, merged to recenter-migration)
Wave 2 dispatch: tickets 03 (marking), 09 (api endpoint), 10 (state+lease), 12 (peg chaser) parallel; ticket 11 (chain-view) HELD until 10 merges — both create apps/supervisor scaffold (conflict avoidance).
Tickets 03/09/10/12: dispatched wave 2, opus, worktrees, BASE df634222
Ticket 03: implementer COMPLETE (7bf3f43a..06854cd9). Carry into tickets 04+11 dispatches: LegView.delta UNSIGNED magnitude vs strikeGreeks wing-signed; ChainSnap builder owns spot===midOf(future) in live mode; unpriced legs mtm:0 discriminated via markPrice(view.exit,...).
Ticket 03: complete (df634222..06854cd9, review Approved, merged)
Ticket 03: Ruling on reviewer's Important (Side vs api ExitSide structural inversion, not a diff defect): carried as a MANDATORY note in every dispatch touching both types (04, 11, 14) — derive exit side from position sign, never pass leg.side into api exitQuote. Cost if wrong: a flipped mark caught by parity/dry-run.
Ticket 03: minor (deferred): absent-strike strikeGreeks test lacks the not-0.3 assertion the unsolvable-IV path has.
Ticket 12: implementer COMPLETE (b23907e0..f4e42eb4). Ruling: peg cadence floor (DESK_CHASE_MS 5s vs 1s dwell) resolved via env default DESK_CHASE_MS=1000 added in ticket 20's .env.local.example step — not a code change. Cost if wrong: chattier chaser passes.
Ruling: chaseMaxMs/chaseCrossBufferPct doc-field threading assigned to ticket 13's dispatch (same rail.ts seam as trancheLots). Peg mode inert until then — by design.
Known-red baseline: apps/api/test/service.integration.test.ts:153 fails on BASE df634222 (pre-existing from master; verified by implementer with work stashed). Carry into dispatch contexts; do not attribute to wave tickets. Investigate before final review.
Ticket 10: implementer DONE (99db14bc..4142527c). Carry into ticket 15 dispatch: boot MUST call StateStore.ensureIndexes() + Lease.ensureIndexes(); save===false => reload+re-decide never retry. Pre-existing red test diagnosed as 26JUL time-bomb fixture.
Ticket 09: implementer COMPLETE (390c2d59..e49f3ca4).
Ruling (LOAD-BEARING): switched-off live tag cannot exit (gateStrategy exempts the close, LiveRail's independent allowlist refuses it) — CONTRADICTS spec §9 "never an exit". Standing desk behavior, but the spec is binding: fix assigned to ticket 18 scope (LiveRail honors the exit exemption for exposure-reducing orders on tags with a live book). Must land before first live engine session. Cost if wrong: an exit passes the allowlist that operator intended to freeze — mitigated by close-only semantics.
Note: post-merge npm install required (new workspace dep edge api->desk-engine). Web typecheck must run at integration (worktrees can't).
Ticket 12: complete (df634222..f4e42eb4, review Approved, merged)
Ticket 12: minor (deferred): warnedNoTouch unbounded process memory; peg-cadence env default already ruled to ticket 20.
Ruling: ticket 13 (tranches) dispatches only after BOTH 12 and 09 are merged — both edit the rail.ts doc-building seam; parallel worktrees would guarantee a conflict. Cost if wrong: ~20min serialization.
Ticket 10: review Approved with 1 Important (sequential-only contention tests, no Promise.all race). Fix round 1/5 dispatched (resumed implementer): add real races both files + optional lazy ensureIndexes.
Ticket 09: review Approved w/ 3 Important (dup-instrument collapse; stale gate docstring; reduce-only TOCTOU) + workMode-default inversion + dead token arg. Fix round 1/5 dispatched (resumed implementer).
Carry into ticket 14 dispatch: a FAILED decisionId replays FAILED forever — after a FAILED outcome the host must mint a NEW decisionId (seq++), never re-post the failed one.
Ruling: liveLots not consulted on the decision path = parity with the old path, per spec ("gates evaluate identically"); engine sizing is dial-governed. Noted for launch runbook. Cost if wrong: an oversized engine order not clamped by liveLots — mitigated by margin_cap projection + tranche gating.
Ticket 10: fix round 1/5 (1 Important + 2 minors claimed addressed with mutation-testing proof; commits 0da5e0e4..67a3014c; scoped re-review dispatched)
Ticket 09: fix round 1/5 (5 addressed claimed; commit 234b4622; probe showed IMP-1 worse than review said — 200 DONE w/ 2 fills; scoped re-review dispatched)
Ticket 04: implementer COMPLETE (603ac72e..edfae6d7).
Ruling: √dte shrink applies on EVERY path in the merged engine (Python shift path lacked it) — off in all shipped presets so parity unaffected; new combination is the merge's point. Cost if wrong: a shift-family book with tol_ref_dte>0 behaves un-Python-like — which is what the dial promises.
Ruling: hasGreeks = union of delta+gamma populations (more conservative than Python's per-population sentinel). If parity disagrees, tickets 06/07 surface it. Cost if wrong: extra holds, never extra action.
Ruling: futures legs have no LegView representation — options-only accepted for launch, deferred item.
Carry into 06/07/08 dispatches: IMPORT nearestStrike/otmSellStrike from corridor.ts, never redefine (duplicate-export loud failure by design).
Ticket 10: fix round 1/5 (all addressed; re-review clean)
Ticket 10: complete (df634222..67a3014c, merged; root npm install run to link @algomaker/supervisor)
Ticket 10: minor (deferred): mutation-testing evidence asserted not transcript-pasted (re-reviewer hand-verified plausibility) — process note for future fix reports.
Ticket 09: complete (df634222..234b4622, re-review clean, merged; rail.ts overlap auto-resolved additively; merged-tree verification: typecheck clean, suite green except known 26JUL fixture)
Ticket 04: complete (a0d260e1..edfae6d7, review Approved, merged)
Ticket 04: minor (deferred): strike-ladder geometry housed in corridor.ts (cohesion smell); Task-8 implementer must fold floorCandidates into shedCandidates.
Ticket 13: dispatched (opus, worktree) with trancheLots/chaseMaxMs/chaseCrossBufferPct threading ruling.
Tickets 05+06: dispatching from post-04-merge HEAD.
Ticket 11: implementer DONE (1b881d30..bc2ea5c5). Carry into ticket 15 dispatch: boot must snap() each leased book once (snap IS the chain declaration; pre-snap ticks drop); Quote.asOf times the BASIS (book frame time while pair held) per marks.ts:410 rule.
Ticket 11: complete (ca7b0610..bc2ea5c5, review Approved, merged)
Ticket 11: minor (deferred): #seed retention bounded by warmStart scope not declared chains — ticket 15 must scope desk-marks warm-start rows to managed tokens; header note pending.
Ticket 11: minor (deferred): snap() per-evaluate cost assumption optimistic — revisit at ticket 15/16 cadence wiring.
Ticket 05: implementer COMPLETE (e4d5e852..4971add5). MERGE HAZARD: strike geometry moved corridor.ts -> new ladder.ts; ticket 06 (in flight) imports from corridor.ts — reconcile imports at 06's merge (re-export or fix import), re-verify merged tree.
Ticket 05 concerns for review/later: outermost-strike bias (faithful to Python; liquidity gate is the guard); otmSellStrike non-OTM at chain edge unguarded; spread-vs-mid reading; Corridor lacks effective-tol field for reason strings.
Ticket 06: implementer COMPLETE (3d872f3e..ebc3c4ab); shift-family parity 60/60 shift marks + 516 silent, mutation-proven.
BLOCKER for ticket 07: fixtures physically inconsistent (net.delta != leg-sum on 1080/1152 marks; gamma consistent). Ticket-02 agent resumed to regenerate with consistency + new invariant check. Ticket 07 holds until regen merged.
Carry into ticket 14: "two consecutive fresh broker margin reads" arms the shift — damping lives in the HOST, not the engine (06 confirmed engine has single-read gate).
Ticket 05: review Approved w/ 1 Important (corridor.ts export break vs 06's import, empirically confirmed) — fix round 1/5 dispatched: one-line re-export on 05's branch.
Ticket 05: minor (deferred): otmSellStrike non-OTM at chain edge (inherited Python gap; guard belongs at composer level); Corridor lacks effective-tol field (display-only).
Ticket 06: review Approved (all four named risks independently verified incl. live mutation re-runs). Merge order: 05-fix -> re-review -> merge 05 -> merge 06 -> merged-tree engine suite.
Ticket 06: minor (deferred): dead merged===undefined branch in slot-merge; no merge×partial-protection combo test.
Ticket 02 follow-up: fixtures regenerated for physical consistency (c113d288, merged). 0 mismatches/1152 marks; 60 shift marks byte-identical; 588 non-hold. Ruling: no separate review seat for the regen — parity-shift re-run on merged tree + ticket 07's full-family parity arbitrate. Cost if wrong: 07 fails loudly against a bad oracle and we regenerate again.
Ticket 07: UNBLOCKED pending 05+06 merges.
Ticket 05: fix round 1/5 (1 addressed — re-export line, probe-proven; commits fe8465d3..dd612ac0; scoped re-review dispatched)
OPERATIONAL NOTE: apps/api Mongo integration suite is LOAD-FLAKY (21/47 spurious failures under parallel full-suite runs, 1 when run alone) — final review gate must run api suite serialized/alone. (ticket-05 report §9)
Ticket 13: implementer COMPLETE (cbc5e6d7..80371c3b).
Ruling: mirror-sync PLACED-only fence vs gated orders — no action: tranchePlan is only written when trancheLots present, threaded only by the engine endpoint; mirror flows never set it, so the fence never meets a gated order. Cost if wrong: a mirror-sync false-idle on a hypothetical future gated mirror order — revisit if mirrors ever use the engine path.
Ticket 13: minor (deferred): urgent orders beyond freeze limit place sequentially (brief-literal; one-line reversal available).
Carry into tickets 14/15: supervisor must send DecisionRequest.work {trancheLots, chaseMaxMs, chaseCrossBufferPct} from the book's dials (degrades to gateway defaults if absent).
Ticket 05: fix round 1/5 re-review clean; complete (55519fa5..dd612ac0, merged)
Ticket 06: complete (55519fa5..ebc3c4ab, merged; index.ts union resolution named in merge commit; merged-tree engine suite 0 fail incl. parity-shift vs regenerated fixtures)
Ticket 07: dispatched (opus, worktree, BASE effd7900) with parity-dps-from-recorded-rows directive.
Ticket 13: review Needs fixes — 3 Important (gate-halt missing filledQty/avgPrice = seed-price MTM shape; reconcile-live blind to HALTED; no exit exemption in decideTrancheStep) + minors. Fix round 1/5 dispatched (resumed implementer; minors 4,5,7,8 folded in; minor 6 web STATUS_RANK assigned to ticket 17).
Ruling confirmed by reviewer trace: mirror-sync fence premise verified (only engine endpoint threads trancheLots); add a pinning comment on pendingOrder — folded into ticket 18's api touch list.
Carry into ticket 17 dispatch: STATUS_RANK['HALTED'] entry. Carry into 15: log-at-first-gated-placement nice-to-have (deferred).
Ticket 13: fix round 1/5 (3 Important + 4 minors claimed addressed, revert-proven; commits 38fac3ba..d8c19236; scoped re-review dispatched)
Ticket 13: fix round 1/5 re-review clean (spurious-alert residual noted non-blocking); complete (353175d7..d8c19236, merged)
Ticket 13: minor (deferred): no focused queue-level CAS-race unit test for markHalted's fenced form (indirect coverage exists).
Tickets 16+17: dispatching (opus, worktrees).
Ticket 07: implementer COMPLETE (b11df3e2..2567d3f6). FULL-FAMILY PARITY GREEN: 1152/1152 marks, 0 mismatches, 31 mutations (25 parity-caught, 5 unit-caught, 3 equivalent).
Ruling: EOD sweep wins over min_band_lots when both set (contradiction Python never faced; a floor blocking the flatten-into-close sweep defeats the sweep). Operator sees this in final rulings. Cost if wrong: an EOD flatten on a book whose floor was meant to hold it.
Carry into ticket 14 (LOAD-BEARING): the HOST maintains RuleState.rcStack from fills (push engine-opened legs on routed adjusts) — engine reads it for LIFO unwind but never writes it; parity cannot catch a host that forgets.
Ticket 07: review Approved w/ 2 Important (recycle bypasses candidacy gate in live pricing — live-arming prerequisite; EOD×band-floor ruling unpinned by test) + minors. Fix round 1/5 dispatched.
Ticket 07: fix round 1/5 (2 Important + 4 minors addressed, mutation-checked; commits a91b936f..bad5526c; scoped re-review dispatched)
Ticket 17: implementer DONE (f8c38841..eb6cafd3). Deferred minors: protect CAS retry path untested (route lacks the hook); refuseSlice journals halt with no status so the feed row reads REJECTED (gateway cosmetic — fold into final wave if cheap).
Ticket 16: implementer COMPLETE (3a20cb60..f6b02cc6). Also settled 13's mirror-sync pendingOrder pin (live-only clause).
Ruling (D-1): LIVE keeps optimistic-fold + reconcile-live (proven, test-covered); fold-on-event unification for live = post-migration cleanup, spec functionally satisfied. Cost if wrong: none new — identical to today's live behavior.
Carry into ticket 18: (a) OrderEvent.mode + stream route so paper journal frames stop landing on the live tab; (b) paper Trades tab reads engine paper fills (desk-fills mode:paper); (c) mirror-sync pendingOrder pinning comment (done by 16? verify at 18).
Ticket 16 minors (deferred): D-4 partial-refusal FAILED-while-working (live parity); D-5 duplicate FILL journal row in one crash window.
Ticket 07: fix round 1/5 re-review clean; complete (effd7900..bad5526c, merged). PARITY GATE STANDS: 1152/1152.
Ticket 07: minor (deferred): recycle pinning test doesn't exercise price-sensitivity of the ?? midOf fallback (room-bound dominates in fixture); one-sided gate short-circuits before staleness check (maker-quote-only state, safe).
Ticket 08: dispatching (opus, worktree).
Ticket 17: complete (2f3d0ebd..eb6cafd3, review Approved, merged)
Fold into ticket 18 (explicit fix items): (a) refuseSlice journals status:'HALTED' (one line — halted-after-partial renders REJECTED today); (b) book-build stops writing dials.lot_size once the Python reader dies (kills the permanent F-29 banner).
Ticket 17: minor (deferred): protect CAS forced-race test before the route pattern is copied; panel draft seeded-once overwrite hazard (pre-existing class); no vitest for preset-copy selector.
Ticket 16: review Needs fixes — CRITICAL C-1 (multi-order package strands WORKING when a zero-fill leg folds first; reviewer-reproduced) + I-1 paper zombie on restart + I-2 dup-open weaker on paper + I-3 report understated D-2 (durable Orders-page live tab affected). Fix round 1/5 dispatched (M-1, M-3 folded; M-2/M-4 deferred).
CORRECTION to ticket 18 carry: paper journal frames hit the LIVE ORDERS TAB (durable, detail.mode missing), not just the socket — 18's fix must stamp detail.mode/OrderEvent.mode end to end.
Ticket 16: fix round 1/5 (C-1 + second stranding + 3 Important + M-1/M-3 addressed; commits 534a0e6d..e29dca37; new dials DESK_PAPER_ORPHAN_MS/DESK_PAPER_SWEEP_MS; scoped re-review dispatched)
Ticket 16: fix round 1/5 re-review clean; complete (2f3d0ebd..e29dca37, merged)
Ticket 16: minor (deferred): zero-trade publish-before-claim duplicate-frame window (D-5 class); workingContracts docstring overstates logging; M-1 stored-via fix lacks a dedicated regression test.
Ticket 16: fix round 1/5 re-review clean; complete (2f3d0ebd..e29dca37, merged at e40ffba7 + one-line test gate fix; engine.ts conflict resolved as union — 17's gated signature + 16's workingContracts; merged-tree typecheck clean, engine route suites green)
Ticket 16: minor (deferred): zero-trade publish-before-claim duplicate-frame window; workingContracts docstring overstates logging; M-1 stored-via regression test absent.
Ticket 08: implementer COMPLETE (72273238..52de11d4). PHASE-1 EXIT GATE GREEN: 362/362, parity 1152/1152 through decide(), 73 ported tests/217 assertions.
Ruling: crash tier UNWIRED (no regime producer; TRIGGERS lacks crash; Python's no_close neutered it on all 12 presets; wiring breaks 72 parity marks) — documented, on the operator rulings list. Cost if wrong: no crash-delta defense the Python engine also didn't actually have.
Ruling: margin guard wired DESPITE no_close (spec §5/§8 mandate) — deliberate behavior change vs Python, operator must know. Cost if wrong: a margin trim Python would not have made — bounded by 0.95×cap hysteresis.
Ruling: expiry settle at the FINAL mark of expiry day (Python is_final_mark), not at open — plan phrasing corrected by parity truth. Cost if wrong: none; matches Python.
Ruling: lock_branch_lots partial (gamma-first ordering only), lock_executability narrowed — schema-scoped ports, documented.
Ticket 08: review Approved w/ 3 Important (creditCommit doc invariant false on drop path; margin guard broker-trigger/model-relief no pre-check — always cuts ≥1 leg; unprotectedLots third copy in tiers.ts) + minors. Fix round 1/5 dispatched (minors 4,5,6,7,9 folded; 8 stays documented).
Ticket 08: fix round 1/5 (3 Important + 5 minors addressed; commits c6b73a19..3f423234; parity 1152/0 re-verified; scoped re-review dispatched)
Ticket 08: fix round 1/5 re-review clean (no clobber residue; pre-check direction verified); complete (8e1ede40..3f423234, merged). ENGINE COMPLETE.
Ticket 08: minor (deferred): RecycleCommit lots===0 division-by-zero shape if a producer ever emits it (pre-existing, no producer does).
Ticket 14: dispatching (opus, worktree) with full carry list.
Ticket 14: implementer COMPLETE (7 commits, head 782a51a1). INTEGRATION RED found: DIAL_SECTIONS missing 08's four lock_* dials (partition test fails on branch — 08 and 17 branched blind to each other). Micro-fix dispatched. Carry into 15: guard preemption of a WORKING package needs the cancel wiring (14's deliberate gap); wiring checklist in ticket-14-report §8.
Integration fix merged (3ff69f29): DIAL_SECTIONS carries the four lock_* dials; branch dials suite green again.
Ticket 14: review Needs fixes — 2 Important (damped pass loses lock disarm/anchor bookkeeping — markState split required; live-rail fill price is a desk-api mark while report claims never — honesty fix + provenance stamp). Fix round 1/5 dispatched (minors 3,4,5,6,7,8 folded).
Ruling: live cumRealized stays optimistic-DONE per the earlier live-fold ruling; provenance stamped; broker-truth true-up = NAMED CARRY to ticket 19/launch. Cost if wrong: supervisor P&L display drift on live until true-up — caught by the invariant sweep alert.
Ticket 14: fix round 1/5 (2 Important + 6 minors; markState = "mark's state without the package's deltas" (ShedResult.markState=counted); commits d59191ec..cf19fccf; scoped re-review dispatched)
Carry into ticket 15 (HARD): the 1s inFlight poll MUST be wired or a working package hangs (evaluate no longer re-posts). Engine-owner follow-up: gated()'s degrade-to-hold keeps the recycle deposit for closes that never happened (pre-existing, flagged).
Ticket 14: fix round 1 re-review — IMP-2 + minors resolved; IMP-1 partially: NEW regression found+reproduced (refused lock flatten permanently sets targetLocked via markState leak on the guard branch — risk mgmt disabled on an open book). Fix round 2/5 dispatched (resumed implementer): targetLocked gets the scrapBanned treatment; refusalGuidance tests; eviction log.
Ticket 14: fix round 2/5 (targetLocked scrapBanned-treatment both sites + SECOND flag found (rcEodDay stamp) + refusalGuidance tests + eviction WARN; commits 82604d3a..7e05127b; scoped re-review dispatched with the streak-dip-disarm trace as the key check)
Ticket 14: fix round 2/5 re-review clean (full RuleState audit — no third leak); complete (0970bdc6..7e05127b, merged)
Ticket 14: minor (deferred): shed.ts markState assignment inert on the pure-hold branch (documented by re-reviewer).
Ticket 15: dispatching (opus, worktree) — the last build ticket.
Ticket 15: dispatched (opus, worktree, BASE 9d1f499a) with the 9-item hard-requirements list + ticket-14 §8 checklist binding.
Ticket 15: implementer COMPLETE (7 commits, head b14203aa; BOOTED end-to-end locally, SIGTERM inert).
Named pre-live carries (ticket 19/20 checklist + operator rulings): (a) live-rail preemption — live decisions settle DONE optimistically while gateway orders keep working; the host cannot target cancels without order ids; wire before first live drill. (b) broker-truth cumRealized true-up (14's carry, still open).
SECURITY NOTE for operator: .env.local on the box holds leaked plaintext passwords (observed by implementer) — rotate/seal at ticket 20.
Ticket 15: minor (deferred): runtime.meta not refreshed with the 15-min instrument rebuild (matters at expiry roll).
Ticket 15: review Needs fixes — 3 Important (stop gates loops not the wire — 2 post-SIGTERM windows; live-rail promise in operator-facing ERROR; partial-cancel latch) + minors. Fix round 1/5 dispatched (minors 1,2,3,5,8 folded; worktree-boundary .env edit named).
Ticket 15: fix round 1/5 (3 Important + 5 minors, 9 mutations caught; commits 8947e0fa..620dde4c; scoped re-review dispatched)
Ticket 15: fix round 1/5 re-review clean; complete (9d1f499a..620dde4c, merged). BUILD PHASE COMPLETE (16/16 build tickets).
Ticket 15: minor (deferred): cancel-retry has no backoff (ERROR per mark while a broker refuses — log-noise consideration pre-live); in-flight cancel completes across SIGTERM (correct); ensureIndexes batched behind one halted() check.
Ruling: the two pre-live code carries (live-rail preemption wiring; broker-truth cumRealized true-up) are NOT weekend scope — ticket 19 documents them as explicit LIVE-FLIP BLOCKERS in the rehearsal checklist; they surface in the final rulings for the operator to schedule before any live session. Paper rehearsal is unaffected. Cost if wrong: none — the live switch stays untouched until the operator flips it.
Tickets 18+19: dispatching in parallel (opus, worktrees).
Ticket 18: implementer COMPLETE (11 commits, head 80353d58). KNOWN-RED ERA OVER (fix was the missing model pass, not the fixture date). 3570/3570 twice.
Ticket 18 notes: roll would half-execute through the exemption (no RollAction producer remains — documented); book-create.tsx GET /v1/desk/variants kept (unreachable route, out of scope); fix-2 extended to the push side per "end-to-end".
Ticket 18: review Approved w/ 2 Important hardening (package-blind exemption — op-token tightening; test fake doesn't pin its query/mode) + 5 minors. Fix round 1/5 dispatched.
Ticket 18: fix round 1/5 (2 Important + 5 minors; commits b4096042..6322b24e; scoped re-review dispatched)
Ticket 18: fix round 1/5 re-review clean (all four exit paths traced through the tightened gate); complete (b24ea159..6322b24e, merged). Full suite 3574/3574 — the known-red era is over.
Ticket 19: implementer COMPLETE (14 commits). Drills 4/4 vs real spawned bin; six scenarios end-to-end incl. lock at 3rd consecutive mark. Concern: phase S unrehearsable on simulate (shift gate wants fresh broker margin) — runbook must carry the workaround.
Ticket 19: review Approved w/ 1 Important (progress path rides Date.now not a frame counter — determinism claim false) + 1 minor (bus ready() JSDoc). Fix round 1/5 dispatched.
Ticket 19: fix round 1/5 re-review clean; complete (b24ea159..e9a74b14, merged). 19/20 done.
FINAL WHOLE-BRANCH REVIEW: dispatching (opus) over 77299c16..HEAD with the ledger's deferred/parked lines for triage. Ticket 20 (deploy+prod cutover) HELD until final review clean AND operator confirms the prod steps.
FINAL REVIEW verdict: NOT READY — C-1 (gateway allowlist lacks the exit exemption; false-fold regression vs master) + I-1 (registry nudge never sent) + I-2 (protection-reversal docs) + I-3 (triple-product test) + M-1..M-6. Deferred-minors triage: ALL RIDE (two already resolved in-branch). Gate enumeration: 17 gates, two deliberately widened (derived predicates), none weakened — C-1 is the un-widened 13th.
Ruling (C-1 scope): the gateway admits desk_op close AND resize (matching exactly what the rail's #exits can pass — a rail-passed resize is by construction shrinking; admitting only 'close' would recreate the false-fold for resizes). Cost if wrong: a growing resize would need to pass BOTH the rail (which refuses it) and this gate — two independent derivations would both have to fail.
Final fix wave dispatched (ONE fixer, opus, worktree): C-1 + I-1..I-3 + M-1..M-6.
Final fix wave: COMPLETE (9 commits, 3b6cf041..7e487aff; 3587/0; C-1 admits close+resize per ruling; I-3 mutation-checked). Scoped re-review dispatched.
Final fix wave: re-review clean (one residual parked). Ruling: rail.ts's missing reciprocal mirror-comment (one-way trip-wire) is REAL but comment-only — parked to the follow-up list rather than a second fix wave (SDD: no second wave). Cost if wrong: a future #exits edit lacks an in-file pointer to gateway gate 2 — mitigated by the gateway side naming the pairing and the C-1 tests failing on divergence.
MERGED. Branch is the deploy candidate. Workspace retained until ticket 20 (prod cutover) completes — deviation from delete-on-clean, for the live cutover's sake.
Ticket 20: COMPLETE (2026-08-22 ~11:12 IST). (a) master ff-merged to d15b697f + pushed. (b) deploy-remote: attempt 1 blocked by box lockfile churn (npm-version metadata; discarded after inspection); attempt 2 deployed 77299c16->d15b697f, health OK. INCIDENT: pm2 startOrRestart name-collided our desk-supervisor entry with the Python one (old bash script + new node interpreter = crash loop); resolved by deleting the polluted entry + fresh --only start. (c) both Python supervisors pm2-deleted (describes captured), ecosystem.config.js retired in sensibull-desk (commit b228fa19, pushed, pulled on box), pm2 save run. (d) data/desk tar-archived (~/desk-state-archive-2026-08-22.tgz, 575KB/40 entries, verified) then removed. (e) DESK_SUPERVISOR_PORT=8793 + DESK_CHASE_MS=1000 appended to box .env.local before the deploy restart. Final state: 5 desk apps online, supervisor lease held, 0 restarts, err log empty, no Python supervisor processes.
CUTOVER COMPLETE. The desk runs on the TypeScript supervisor.
