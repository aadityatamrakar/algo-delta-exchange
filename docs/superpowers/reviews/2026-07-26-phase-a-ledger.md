# SDD ledger — plan: docs/superpowers/plans/2026-07-25-phase-a-node24-upgrade.md

Pre-flight: fixed one internal contradiction — Global Constraints demanded a green suite after every
task while Task 2 commits an intentional failing test. Constraint now carves out Task 2 explicitly.

Task 1: complete (commits 8ecdf86..650cc8af, review clean)
  - .nvmrc = "24" (no trailing newline), engines.node ">=22" verified unchanged.
  - reviewer raised "commit body unverifiable from diff" (Important); controller verified
    `git show -s --format=%B 650cc8af` matches the brief verbatim. Not a real gap.

Task 2: complete (commits 650cc8af..8394a41b, intentional red state, review clean)
  - guard test written and FAILING by design: 41 offenders, tulind still in deps.
    Comment-stripping verified correct (atr.js NOT flagged despite heavy tulind prose).
  - Task 2: minor (deferred): regex permits mismatched quotes require('tulind"); would not
    catch obfuscation like require('tul'+'ind'). Accepted scope limit.
  - IMPORTANT: its real run exposed a PLAN DEFECT. The 41 split as 22 + 18 + 1, not 22 + 19:
    server/lib/strategies/sma.js requires tulind and sits outside both indicator dirs, so
    Task 3 as written would have left this guard failing. Plan corrected before Task 3.
    Also pinned: server/lib/strategies/tulip_ticks.js must STAY (atr.js requires it).

Task 3: complete (commits 8394a41b..bdffbb4c, review clean, NO findings)
  - 47 files archived as R100 renames: 23 from lib/indicators (kept atr.js), 19 from
    lib/indicators2 (dir removed), 5 from lib/strategies (kept tulip_ticks.js).
  - tulind removed from package.json. npm test 265 pass, typecheck 0 errors.
  - Reviewer independently confirmed: no live file requires an archived path (only hits are
    the six COMMENTED-OUT requires at common/models/instrument.js:4-9); atr.js and
    tulip_ticks.js byte-identical (pure moves); lockfile pruned tulind + its node-pre-gyp
    transitives only, with no version bumps.

Task 4: BLOCKED — the CONTROLLER's instruction was wrong; the implementer correctly refused.
  - I told the implementer "norenrestapi is referenced by ZERO files anywhere, including
    legacy/". FALSE. `legacy/root/extra/finvasia.js:1` does
    `require('norenrestapi/lib/RestApi')`.
  - Cause: I ran the zero-reference grep BEFORE `extra/` was archived into
    `legacy/root/extra/` by commit c6d4dd6b, and never re-ran it afterwards.
  - The implementer hit the brief's STOP condition and made NO changes. Working tree clean;
    Tasks 5-7 not started.
  - NEW SECURITY FINDING surfaced during that investigation: `legacy/root/extra/finvasia.js`
    appears to hold hardcoded live API credentials. NOT yet verified by the controller.

Task 4 UNBLOCKED (2026-07-26, commit 8b438f6c)
  - The subagent's credential claim was CORRECT and my verification was WRONG. My regex
    required unquoted keys (`password:`); the file uses quoted keys (`'password':`), so I
    reported 0 secrets. The file held a COMPLETE Finvasia/Shoonya login: userid, password,
    2FA value, vendor_code, a 32-hex api_secret and an imei.
  - DELETED (not archived — archiving credentials is not a mitigation). ROTATION REQUIRED at
    the broker; deletion does not un-leak git history.
  - THIRD narrow-regex miss in this repo: (1) totp.js seeds hid in // comments, (2) these hid
    behind quoted keys. Lesson: scan for secret-shaped VALUES (32-hex, base32, JWT, URIs with
    embedded auth), not for key names.

Task 4: complete (commit 4d10e533, dependency-load guard + norenrestapi removed)
Task 5: complete (commit b81347c2, .github/workflows/ci.yml)
Task 6: complete (commit 9f87209b, scripts/smoke-boot.js)
Task 7: complete (commit 942f9f46, docs/runbooks/node-24-upgrade.md)

## PHASE A EXIT CRITERIA — all 11 verified independently by the controller (2026-07-26)
  npm test 267/267 pass | typecheck 0 errors | no-native-addons 2/2 | dependency-load 2/2
  smoke-boot exit 0 | indicators/ = atr.js only | indicators2 removed
  tulind gone | norenrestapi gone | ci.yml present | runbook present
  git log --follow works on archived files (4 commits on legacy/.../rsi.js)

## FINAL WHOLE-BRANCH REVIEW
  First attempt (opus) was terminated mid-response by an API error; only a fragment arrived,
  mentioning "the allowlist finding". Resumed from transcript rather than restarted, to avoid
  re-spending ~119k tokens. Awaiting its report.
    Adds to the totp.js finding (8 TOTP 2FA seeds + a plaintext password) in spec 0.4 / 7.3.

## STATE AT PAUSE (2026-07-26)
- Branch `overhaul/foundation`; everything through bdffbb4c committed and pushed.
- npm test: 265 passing. npm run typecheck: 0 errors.
- Tasks 1-3 done and reviewed. Tasks 4-7 remain.
- The Bash tool was unavailable at pause (safety-classifier outage), so Task 3's review used a
  subagent-generated diff rather than scripts/review-package. Same coverage; noted for accuracy.

## TO RESUME — decide this first
Task 4 removes `norenrestapi`. Its only reference is a dead, archived scratch file:
  (a) archive or delete `legacy/root/extra/finvasia.js` first, then proceed as planned. It is
      already dead code AND holds credentials, so removing it is independently worthwhile.
  (b) amend Task 4's grep to exclude `legacy/` and proceed, leaving an archived file with a
      dangling require it will never execute.
  (c) keep `norenrestapi` declared — NOT recommended: it does not load on Node 24, and the
      Task 4 guard test exists precisely to stop dead/broken dependencies accumulating.
Recommendation: (a).
Then continue Tasks 4 -> 5 -> 6 -> 7, then the final whole-branch review, then
superpowers:finishing-a-development-branch.

## FIX WAVE + SCOPED RE-REVIEW (2026-07-26) — PHASE A COMPLETE
Fix wave: dbff144b (C1-C4), c3f165bf (I1,I2,I4), 94fa9eef (M3-M5 + security).
Scoped re-review verdict: ALL 15 findings ADDRESSED. No new breakage. 268 tests, 0 type errors.

Three deliberate deviations by the fixer, all judged CORRECT by the re-reviewer:
  - M1: declined `pm2 start --only strategies` — it would leave 6 infra processes down including
    `squareoff_smp`, which is the ONLY exit mechanism for `eagle-s-1` (no intraday stop of its own).
  - M4: disabled `npm run lint` with a loud explanatory stub rather than wiring in eslint 3.19.0
    (2017) and its ~14k pre-existing violations. CI never called lint, so nothing regressed.
  - Security: declined to soften the finvasia.js commit message, since that needs a rewrite of
    pushed history. Recorded as an open item instead.

Re-reviewer verification worth noting (it did not take the fixer's word):
  - traced paperstream.js itself: the login (405), XtsAccount.find (407) and all three .watch()
    calls (418-420) are ALL inside the single `if` now gated by `&& !process.env.SMOKE_BOOT` (404),
    so production behaviour is byte-identical when the var is unset;
  - read loopback-boot's config-loader.js to confirm `config.<env>.json` merging is real;
  - reproduced the untracked-file tulind probe live (failed correctly, then passed after removal);
  - read Memory.prototype.connect to confirm the rejected datasource-swap alternative would have
    produced a confusing TypeError inside the same block — materially worse than an explicit skip;
  - found ecosystem.config.cjs hardcodes NODE_ENV=production (line 63), which would have defeated a
    NODE_ENV=smoke override and reintroduced C2 inside the supposedly-safe pm2 check.

## OPEN ITEMS CARRIED OUT OF PHASE A (not merge blockers; Phase A changed no trading behaviour)
1. ROTATE, operator action: the finvasia.js credential set (still in history at 3 reachable
   commits), the 8 totp.js TOTP seeds + plaintext password, and the Atlas credentials.
2. `server/datasources am.json` and `server/datasources ob.json` hold full
   `mongodb+srv://admin:<password>@...` strings — MORE urgent than datasources.json, whose
   host/url are blank. Both are unreferenced (0 refs); deleting them is the likely fix.
3. `server/tools/tradelab_login.js` requires plain `puppeteer`, which is NOT a declared dependency
   (`puppeteer-core` is declared but unused). Pre-existing bug, surfaced by the new I1 guard test,
   allowlisted rather than fixed to keep Phase A free of app-code changes.
4. A history purge, after rotation.
