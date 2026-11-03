# algomaker cleanup & risk audit — 2026-07-25

Repo: `/Users/aaditya/Documents/dev/algomaker` (branch `master`, clean tree at audit time).
Method: evidence-based grep across all tracked files (`git ls-files`, excluding `node_modules`/`.git`), cross-referenced against `dump.pm2` (97 production processes on `algospot` box), `package.json`, `gulpfile.js`, `server/middleware.json`, and `.eslintignore`. Read-only — no files were modified, moved, or deleted.

---

## 1. Deletion plan

Sizes are on-disk (`du -sh`). "Referenced by" only counts **live code paths**, i.e. required/read by something — it excludes comments and unrelated substring matches (e.g. `app.models.client` is a LoopBack model name, not the `client/` directory, and is *not* counted as a reference).

### TIER 1 — zero-risk (no reference anywhere, not in the 97-process pm2 list)

| path | size | tracked files | referenced by | verdict | risk if deleted |
|---|---|---|---|---|---|
| `client_pd/` | 21.3 MB | 142 | none | delete | none |
| `client_ob/` | 20.2 MB | 132 | none | delete | none |
| `client_am/` | 12.5 MB | 104 | none | delete | none |
| `build_am/` | 6.8 MB | 87 | none | delete | none |
| `build_ob/` | 5.1 MB | 61 | none | delete | none |
| `build_pd/` | 10.8 MB | 98 | none | delete | none |
| `models/` | 0 | 0 | none (empty dir, not even tracked) | delete | none |
| `memphis/` | 0 | 0 | none (empty dir, untracked) | delete | none |
| `greeks/` | 0 | 0 | none (empty dir, untracked) | delete | none |
| `logs/` | 0 | 0 | none (empty dir, untracked) | delete | none |
| `server/standle/` | 0 | 0 | none (empty dir, untracked) | delete | none |
| `a.out` | 16 KB | untracked | none — stray compiled binary (`.gitignore` already excludes `*.out`) | delete from disk | none |
| `pay.html` | 4 KB | tracked | none | delete | none |
| `download.js` | 4 KB | tracked | none | delete | none |
| `downloadTrades.js` | 4 KB | tracked | none | delete | none |
| `updateDB.js` | 4 KB | tracked | none | delete | none |
| `clearPositional.js` | 8 KB | tracked | none | delete | none |

**Subtotal reclaimed (working tree): ≈ 76.7 MB** from the six `client_am/ob/pd` + `build_am/ob/pd` dirs, plus negligible KB from root scripts and empty dirs.

### TIER 2 — near-certain, but verify first (referenced only by other already-dead code, or by a still-runnable command)

| path | size | tracked files | referenced by | verdict | risk if deleted |
|---|---|---|---|---|---|
| `client/` | 21.3 MB | 142 | `server/tools/daily_report.js:80` and `server/monks/daily_report.js:80` both do `fs.readFileSync(__dirname + '/../../client/email.html')` | delete, but **first confirm neither script is cron'd outside pm2** | **Low** — neither script appears in the 97-process `dump.pm2` list, so they are not currently running under pm2. But pm2 doesn't capture host crontab entries, so a naive check could miss a cron-triggered invocation. `email.html` exists identically in `client_wc/`, so repointing the two scripts to `client_wc` first costs nothing and removes the risk entirely. |
| `build/` | 6.3 MB | 85 | (a) `package.json` script `"sync": "aws s3 sync build s3://cdn.algomaker.in --acl public-read"`; (b) `server/datafeed/market_watch.js:195-196` writes `build/data/marketwatch.json` and uploads it to `cdn.algomaker.in` | delete, but **fix/retire the `sync` script and `market_watch.js` first** | **Medium** — `market_watch.js` is not in the pm2 process list (not currently running), but `npm run sync` is a real, one-command, human-runnable script that still targets the stale `build/` folder, not `build_wc/`. If someone runs `npm run sync` after `build/` is deleted, it will either error or (worse, if re-created empty) sync nothing useful to the production CDN. This is the one place where "we only use build_wc" is **not yet reflected in tooling** — see Critical Findings #1. |
| `calc.js` | 12 KB | tracked | only by `dash.html` (which itself has no callers) | delete | none — `dash.html` is also dead (see below) |
| `dash.html` | 20 KB | tracked | only self-referenced by `calc.js:20` (`fs.readFile('./dash.html', ...)`); no server route serves it | delete | none |
| `clearReports.js` | 4 KB | tracked | none in-repo | delete | **Unverifiable from repo alone** — could theoretically be cron'd on the production box; repo search can't rule that out. Ask owner before deleting. |
| `filter-stocks.js` | 4 KB | tracked | reads `stock_bse.json` (kept) | delete | none — script itself not in pm2 |
| `instruments-sme-tokens.json` | 332 KB | tracked | `server/tools/volume_check.js`, `server/tools/volume_check_nse.js` (neither in pm2 list) | keep (data, not code — low value to delete) | none either way |
| `stock_bse.json` | 484 KB | tracked | `filter-stocks.js`, `server/tools/bse-tracker.js` (neither in pm2 list) | keep | none either way |

### TIER 3 — needs owner decision (secrets, ambiguous value, or operational judgment call)

| path | size | tracked files | referenced by | verdict | risk if deleted |
|---|---|---|---|---|---|
| `test.js` | 8 KB | tracked | none (see Critical Findings #2 — file is an **unresolved git merge conflict**, would throw `SyntaxError` if run) | delete file **and** treat as a secrets incident (see §3) | none functionally; git-history purge still needed |
| `xts_test.js` | 8 KB | tracked | none | delete file **and** treat as a secrets incident (see §3) | none functionally; git-history purge still needed |
| `totp.js` | 4 KB | tracked | none | delete file **and rotate all 8 TOTP seeds** (see §3) | none functionally; the seeds must be rotated regardless of whether the file is deleted |
| `dump.pm2` | 676 KB | tracked | none in code; it's an operational snapshot, useful as a reference (this audit used it) | keep, but move out of repo root into an `ops/`/`docs/` folder, or better, keep it *outside* git entirely (it's a point-in-time process dump, not source) | low — no secrets found in its `env` blocks, but it does disclose full prod file-system paths and the entire process topology |
| `todo` | 4 KB | tracked | none (personal strategy notes) | keep or move to `docs/`; not a cleanup target | none |
| `order.log` (1.1 MB), `instruments.csv` (6.9 MB) | — | **untracked** already (`.gitignore` covers `*.log`, `*.csv`) | n/a | disk hygiene only — safe to delete from disk any time, zero git impact | none |

---

## 2. Critical findings — what breaks under a naive cleanup

1. **`server/middleware.json` already points at `build_wc`** (`"files": {"loopback#static": {"params": "$!../build_wc"}}`) — this is good news, **not** a critical risk. The static root is correctly `build_wc`, not `build`. `server/middleware.development.json` has no static-root override. So the specific failure mode the task asked me to check for (static root pointing at the wrong dir) **does not exist**. This is the one place a naive assumption would have been wrong in the *dangerous* direction, and it turns out to be safe.

2. **`package.json`'s `sync` script still targets `build/`, not `build_wc/`.** `"sync": "aws s3 sync build s3://cdn.algomaker.in --acl public-read"`. This is the actual trap: someone (or some external automation not visible in this repo) could still run `npm run sync` and expect it to push the live CDN assets. It currently pushes whatever is sitting in the stale `build/` directory — already wrong today, but deleting `build/` outright would turn "silently stale" into "hard error / empty sync." Fix the script to point at `build_wc` (or delete the script) *before* deleting `build/`.

3. **`test.js` at repo root contains unresolved `<<<<<<< Updated upstream` / `=======` / `>>>>>>> Stashed changes` git conflict markers.** This means the file cannot execute as valid JavaScript (`init()` would throw a `SyntaxError` immediately) — hard confirmation it is not live code, but its presence is itself a hygiene problem: a broken merge was committed and never cleaned up. It also embeds five broker `appKey`/`secretKey` pairs and one bearer JWT (see §3).

4. **Several directories outside the scope of this audit are also apparently dead**, discovered incidentally while checking references: `server/monks/` (last commit 2022-07-06) and `server/datafeed/` do not appear anywhere in the 97-process `dump.pm2` list, and `server/monks/daily_report.js` is a near-duplicate of `server/tools/daily_report.js`. Not in scope for this task's deletion plan, but worth a follow-up audit — the "we only use X" pattern likely extends past `client*`/`build*`.

5. **`.eslintignore` excludes `/server/` itself** (along with `/client/`, `/client_ob/`, `/client_wc/`). This means `npm run lint` (`eslint .`) never actually lints the live backend code (`server/slive`, `server/smp`, `server/boot`, etc.) — it only lints whatever's left, which given the other ignores is close to nothing useful. Not a deletion risk, but explains why `posttest`'s lint gate provides near-zero real coverage today.

---

## 3. Secrets report (redacted)

All values below are redacted to first 4 characters + length. **Do not treat this list as exhaustive** — it is what a pattern grep over tracked files surfaced; a dedicated secrets scanner (trufflehog/gitleaks) run over full git history is recommended before declaring the repo clean.

| # | file | line(s) | kind | value (redacted) | live-looking? | in git history too? |
|---|---|---|---|---|---|---|
| 1 | `server/datasources.json` | 10-11 | MongoDB user/password | user `smp_admin`, pass `admi…(12)` | Ambiguous — `host`/`url` fields are blank strings in this file, so it may be overridden by an env var at runtime. Cannot confirm from repo alone. | Yes, first added 2020-11-30, 4 commits touching it, still at HEAD |
| 2 | `server/datasources ob.json` | 7,9 | **Full MongoDB Atlas SRV connection string with embedded password** | `mongodb+srv://<user>:<redacted 16 chars>@<cluster-algo>.mongodb.net/algo` | **Yes — this is a complete, directly-usable credential**, not a placeholder | Yes, added 2021-05-30, still at HEAD (1 commit — never modified since) |
| 3 | `server/datasources am.json` | 7,9 | Full MongoDB Atlas SRV connection string | `mongodb+srv://<user>:<redacted 16 chars>@<cluster-algo>.mongodb.net/algo` | **Yes** | Yes, added 2020-11-30, still at HEAD |
| 4 | `server/datasources smp.json` | 7,9 | Full MongoDB Atlas SRV connection string | `mongodb+srv://<user>:<redacted 16 chars>@<cluster-algo>.mongodb.net/algo` | **Yes** | Yes, added 2021-05-30, still at HEAD |
| 5 | `README.md` | 5-13 | Broker (Jainam) API credential block: `appKey`, `secretKey`, `clientCode` | appKey `9018…(22)`, secretKey `Yqgk…(10)`, clientCode `PRO288` | **Yes — looks like a real, specific broker terminal credential**, not sample data | Yes, added 2020-11-30, still at HEAD |
| 6 | `totp.js` | 3-10 | **8 TOTP/2FA seed secrets** (base32), one per trading account, plus one commented plaintext password | e.g. `6GJZ…(32)`, `7V74…(32)` × 8 total; password `rams…(11)` | **Yes — these regenerate valid 2FA codes indefinitely** until the authenticator app/account is re-enrolled | Yes, added 2025-02-12, still at HEAD |
| 7 | `test.js` | 15-16, 19-20, 23-24, 27-28, 38-39 | **5 broker `appKey`/`secretKey` pairs**, embedded in an unresolved git-merge-conflict file | e.g. appKey `487b…(22)` / secretKey `Kdiw…(10)`; 4 more pairs | **Yes**, plus one commented bearer JWT on line 31 (JWT `exp` claim decodes to 2023 — likely expired) | Yes, added 2025-06-03 (per `git log`), still at HEAD |
| 8 | `xts_test.js` | 11, 15 | 2 bearer JWTs (XTS session tokens) | JWT `eyJh…`, both with `iat`/`exp` epoch values decoding to **2022** | Likely expired (short-lived session tokens ~24h TTL judging by `iat`/`exp` deltas), but the pattern of committing live session tokens is itself the problem | Yes, added 2022-06-02, still at HEAD |
| 9 | `server/boot/tradelab_auth.js` | 26-27 | Hardcoded broker OAuth `clientId`/`clientSecret`, loaded automatically at app boot (LoopBack auto-boots everything in `server/boot/`) | clientId `ARHAM-AW0198`, clientSecret `Yyam…(64)` | **Yes — and this one is in the actively-running boot path** (unlike the others, which sit in dead/orphaned scripts) | Yes, added 2022-03-22, 19 commits touching it, still at HEAD |
| 10 | `server/userdata/*.json` (`VV0124`, `XV7910`, `YO8965`, `ZV5170`) | — | Zerodha Kite session cookies (`kf_session`, `__cfduid`) | e.g. `x4uU…(32)` | Cookies dated Nov 2020–Feb 2021 — **almost certainly expired**, but note: `.gitignore` has `userdata/*` today, yet these 4 files remain tracked because they were committed *before* that ignore rule existed. `.gitignore` does not retroactively untrack. | Yes, added 2021-01-04, still at HEAD |
| 11 | `common/models/client.js` | 217 | Hardcoded weak password reset: `user.updateAttribute('password', String(1212), ...)` | literal `1212` | Code smell / potential unintended backdoor-reset path rather than a leaked external credential — flag for review, not rotation | Yes, added 2020-11-30, 38 commits touching this file, still at HEAD |

**No secrets were found in `dump.pm2`'s `env` blocks** (checked all 97 process definitions for keys matching `SECRET|PASSWORD|TOKEN|API_?KEY|PRIVATE` — zero hits). Env vars appear not to be how this app manages credentials; it reads them from the committed JSON/JS files above instead, which is the actual root cause.

### Remediation, in priority order

1. **Rotate first, delete second**, for everything marked "yes" above — deleting the file (or even scrubbing git history) does not invalidate a credential that a third party may have already copied. Priority order by blast radius:
   - `server/datasources ob.json` / `am.json` / `smp.json` — rotate the three MongoDB Atlas passwords (Atlas dashboard → Database Access → edit user), update whatever actually consumes them, *then* remove from the repo.
   - `server/boot/tradelab_auth.js` — rotate the Tradelab/Arham OAuth client secret; this one is in the live boot path.
   - `totp.js` — re-enroll 2FA on all 8 broker accounts (deleting the seed does not desync an already-registered authenticator; the broker side must be reset).
   - README.md's Jainam `appKey`/`secretKey`, and the 5 more pairs in `test.js` — rotate via each broker's API-key console.
   - `server/datasources.json` (`smp_admin`) — confirm whether `host`/`url` being blank means this is actually unused; rotate regardless since the password is exposed either way.
2. **Purge from git history**, not just current HEAD, for anything rotated — `git filter-repo` (preferred over BFG for accuracy) on `server/datasources*.json`, `README.md`, `totp.js`, `test.js`, `xts_test.js`, `server/boot/tradelab_auth.js`, `server/userdata/*.json`, `common/models/client.js`. This requires force-pushing and re-cloning on every machine/deploy target that has this repo — coordinate before doing it, and only after rotation (order matters: rotate, *then* purge, so a stale mirror of the repo can't be used to exploit an old credential during the gap).
3. Add `server/datasources*.json`, `server/userdata/*`, `totp.js` to `.gitignore` going forward and replace with `*.json.example` templates + real values injected via environment/secret-manager at deploy time. This is the actual fix for root cause — the current pattern is "config as code," which is why 4+ real DB passwords ended up in git in the first place.
4. Delete `test.js` and `xts_test.js` outright (Tier 3 above) — they are not live code, they are debug scratch files that happen to carry real credentials.

---

## 4. Repo hygiene

**Sizes**: total working tree `861 MB`; `.git` directory `74 MB`; `node_modules` `414 MB` (untracked); `data/` `223 MB` (untracked); `historical/` `3.8 MB` (untracked, and `.gitignore`'s `historical/*` only excludes *contents*, not the directory itself, so it stays trackable-empty). The **tracked** portion of the working tree — the actual git payload — is roughly `861 − 414 − 223 = ~224 MB`, of which the eight `client*`/`build*` directories audited here account for **≈130 MB** (all nine including `client_wc`+`build_wc`), i.e. more than half of everything actually committed to this repo is legacy front-end/build output.

**`build_wc` is tracked alongside `client_wc`** (confirmed: `git ls-files client_wc | wc -l` → 142, `build_wc` exists and is 5.3 MB on disk) — meaning gulp-generated, minified/obfuscated build artifacts are versioned in git rather than produced by CI at deploy time. This is standard for this era of LoopBack/gulp app but is worth flagging as an overhaul target: a modern pipeline would build `build_wc` in CI and never commit it, which would also remove the temptation to leave `build`, `build_am`, `build_ob`, `build_pd` lying around as forgotten sibling artifacts in the first place — this is arguably *how* the 4 dead build dirs accumulated.

**Largest tracked files** (`git ls-files | xargs du -k | sort -rn`, top entries, KB):

| size (KB) | file |
|---|---|
| 2100 | `client/css/adminlte/adminlte.min.css.map` (+ identical copies in `client_wc`, `client_pd`, `client_ob`) |
| 1540 | `build_am/assets/vendor.min.css` |
| 1512 | `client_am/css/adminlte/adminlte.min.css` |
| 1492 | `client/public/2.png` (+ 4 duplicate copies across `client_wc/_pd/_ob/_am`) |
| 1480 | `client/public/1.png` (+ 4 duplicates) |
| 1440 | `client/css/adminlte/adminlte.css.map` (+ 3 duplicates) |
| 988 | `build/assets/vendor.min.js` (+ `build_pd` duplicate) |
| 920 | `client_wc/js/services/lb-services.js` |
| 888 | `client_ob/js/services/lb-services.js` |
| 880 | `client/css/fontawesome/webfonts/fa-solid-900.svg` (+ 4 duplicates incl. `build/webfonts/...`) |

The pattern is consistent throughout: the same handful of vendor assets (AdminLTE, FontAwesome, PNG logos, minified vendor bundles) are duplicated near-identically across all five `client*` trees and four `build*` trees. This is the single clearest piece of evidence that these were forked copies of one app rather than independently-maintained products — reinforcing that deleting the four unused ones is safe (they're not divergent codebases, they're stale forks).

**`.gitignore`'s blanket `*.csv` / `*.log` rules matter for the stated goal of committing a CSV documentation sheet.** As written, `*.csv` is a bare pattern with no path qualifier, so it matches **any** CSV anywhere in the tree, including a future `docs/strategy-catalog.csv` or similar deliverable the owner mentioned wanting to commit. Recommend narrowing to something like `/instruments.csv` and `/historical/**/*.csv` (or whatever the actual data-dump paths are) so a documentation CSV placed anywhere else in the repo isn't silently dropped by `git add`. Same caution applies less urgently to `*.log`.

---

## 5. Tooling gaps

| gap | evidence | recommended modern replacement |
|---|---|---|
| No lockfile | No `package-lock.json` or `yarn.lock` at HEAD; `package-lock.json` *did* exist historically and was deleted in commit `eb7b8500` (2025-05-02) | Regenerate `package-lock.json` (or migrate to `pnpm-lock.yaml`) and commit it — non-reproducible installs are a real risk given `dependencies` pin ranges like `^` on packages last touched years ago |
| No CI config | No `.github/workflows/`, no other CI config file found anywhere in the repo | GitHub Actions (or equivalent) running `npm ci && npm test && npm run lint` on PRs at minimum |
| No Dockerfile | Not found | A `Dockerfile` pinning the actual Node runtime version would also resolve the version-mismatch gap below |
| Node version mismatch | `package.json` declares `"engines": {"node": ">=6"}`; production historically ran `14.17.0`; local dev environment is `v24.11.0`. No `.nvmrc` anywhere. | Add `.nvmrc` (or `"engines"` pinned realistically, e.g. `>=18 <21` matching whatever LTS the overhaul targets) so local/prod/CI can't silently drift further |
| Test script missing despite tests existing | `server/test/*.test.js` has 4 files (`orb-scalp-logic`, `orb-fut-logic`, `atr-band-logic`, `fill-price`), but `package.json` `scripts` has no `"test"` entry at all — only `lint`, `start`, `sync`, `refresh`, `posttest` (which runs lint, not tests) | Add `"test": "node --test server/test/"` (repo already uses the `node:test` runner per project conventions) and wire it into CI |
| Linter effectively inert | `devDependencies` has `eslint@^3.17.1` (EOL, pre-flat-config, from ~2017) + `eslint-config-loopback@^8.0.0`; and critically **`.eslintignore` excludes `/server/`** — the one directory with all the live trading logic — so `npm run lint` never actually checks it | Modern ESLint (v9 flat config) with a config that *includes* `server/` (perhaps excluding only `server/slive/*` if that's intentionally loose), or adopt Biome for a single fast lint+format tool |
| No formatter enforcement | `.prettierrc` exists but nothing in `package.json` scripts or CI ever invokes prettier — it's decorative | Add a `"format:check"` script and a pre-commit hook (husky + lint-staged, or a single Biome invocation) so the config file actually does something |
| No pre-commit secret scanning | Given the 11-item secrets list above, none of the "committed 2020-2025" credentials were caught by anything | `gitleaks` or `trufflehog` as a pre-commit hook and/or CI gate — would have caught every finding in §3 before merge |

---

## 6. Exact TIER 1 deletion commands (review only — NOT executed)

```bash
# Six dead client/build directories with zero live references
git rm -r client_pd client_ob client_am build_am build_ob build_pd

# Empty, untracked runtime-scratch directories (no git effect, but clean the tree)
rmdir models memphis greeks logs server/standle

# Stray untracked compiled binary
rm -f a.out

# Root-level orphan scripts with zero references anywhere in the repo
git rm pay.html download.js downloadTrades.js updateDB.js clearPositional.js

git commit -m "Remove unused client_am/ob/pd and build_am/ob/pd forks, dead root scripts, empty scratch dirs

Verified via full-repo grep that none of client_am, client_ob, client_pd,
build_am, build_ob, build_pd are referenced by gulpfile.js, server/middleware*.json,
server/boot/*, package.json scripts, or any of the 97 processes in the
production dump.pm2 snapshot. Only client_wc/build_wc remain in active use."
```

**Deferred to TIER 2/3 — do not run yet, pending the fixes noted in §2 and §3:**
```bash
# Only after repointing/removing package.json's "sync" script and
# server/datafeed/market_watch.js's build/-path writes:
git rm -r build

# Only after repointing server/tools/daily_report.js and server/monks/daily_report.js
# to read from client_wc/email.html instead:
git rm -r client

# Only after the secrets in §3 are rotated:
git rm test.js xts_test.js totp.js
```
