---
name: otm-selector-returns-zero
description: "lib/otmSelector.js returns 0 everywhere BY DESIGN — the desk trades ATM (owner-confirmed 2026-07-25); the weekday scaffolding is dead code. SD_2 Thursday crash is a separate, legacy-only bug"
metadata:
  type: project
---

> **RESOLVED 2026-07-25 — owner confirmed: "otmSelector 0 is intentional, we trade ATM mostly."**
> The zero returns are correct behaviour, not a bug. Do NOT re-raise this as a defect, and do not
> "restore" the weekday offsets. The remaining action is cleanup: the weekday `if/else`
> scaffolding is dead code, and in the new system the offset becomes an explicit config value
> (`offset: 0`) rather than a function call. The Thursday crash below is a *separate* and still-real
> bug, but it only affects legacy files outside the active set.

`server/lib/otmSelector.js` is required by **104 of 156** `server/slive` files. Verified
call-site distribution:

| Call | Sites | Returns |
|---|---|---|
| `otmSelector()` → defaults to `'Lion'` | 71 | `0` **always** |
| `otmSelector('Cheetah')` | 15 | `0` **always** |
| `otmSelector('Lion_SNX')` | 1 | `0` **always** |
| `otmSelector('SD_2')` | 6 | array — **except Thursday** |

## Finding 1 — 87 of 93 sites resolve to 0, so "OTM" sellers sell ATM — INTENTIONAL
Every weekday branch in `otmSelector.js:4-33` returns `0`, including the `else return 0`
fallbacks. Strategies named as OTM strangle sellers are in practice selling **at-the-money**.

**Owner-confirmed as intended (2026-07-25): the desk trades ATM.** The family names
(`bull-s`, `eagle-s`, "strangle") describe the structure's lineage, not its current strike
selection — a naming artefact, not a defect.

All 6 non-modern strategies in the ACTIVE set are affected and all are behaving correctly:
`bull-s-1`, `bull-snx-1`, `eagle-s-1`, `lion-s25-2` call `otmSelector()` (defaults to `'Lion'`);
`cheetah-b1-1`, `cheetah-b1-snx` call `otmSelector('Cheetah')`. Verified `0` for Mon–Fri.

**Migration action:** delete the dead weekday scaffolding; do not port it. The offset stays a
config *axis* (the `ce-d2*`/`pe-d2*` spread scanner genuinely varies it, and future strategies may)
but defaults to `0` = ATM. Making it explicit config removes a shared helper that silently governed
104 files.

## Finding 2 — verified crash on Thursdays
`otmSelector.js:34-45` (tag `SD_2`) branches on days 1, 2, 3, 3 (**duplicated**), 5. **Day 4 —
Thursday — is missing**, so it falls through and returns `undefined`. Reproduced:

```
SD_2 on Thursday  -> undefined
SD_2 on Wednesday -> [5,3,4,18,-5,-10]
```

Consumers dereference immediately (`server/slive/ce-d2-0020.js:64-65`):

```js
day_config = otmSelector('SD_2');
current_spread = day_config[5];   // TypeError: Cannot read properties of undefined
```

Affects 6 files: `ce-d2-0020`, `ce-d2-extra`, `ce-d2p-extra`, `pe-d2-0020`, `pe-d2p-extra`,
`pe-d2-extra` — the credit-spread scanner family. Thursday is weekly index expiry.

**Impact is low:** all 6 are bus-routed (no `placeAllAccount`) and none have `autostart: true`.
`SD_3` has the same duplicated-day-3 / missing-day-4 shape but has zero call sites.

## How to apply
One shared helper silently changes behaviour across 104 files — a concrete example of why
[[strategy-sprawl-and-config-axes]] matters. Fix the Thursday branch before trusting any
`ce-d2*`/`pe-d2*` result, and settle the intent question before porting offsets into new config.
