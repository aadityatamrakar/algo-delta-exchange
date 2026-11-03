# Golden SPAN cases

Real broker portfolios, used to prove our margin is within 1 % of the broker's (spec Q6, Phase 0).
`test/golden.test.ts` discovers the folders below; with none it reports one skipped test.

## The rules for a case (Q6)

- 3 to 5 real books, each with the broker's margin given as SPAN and exposure separately.
- A known day and time: the folder name is `<YYYY-MM-DD>-<HHMM>` (IST) of the broker screen.
- Taken outside expiry week (expiry-day margin rules differ).
- Client codes scrubbed: no client id, name or account number in any file.

## Folder layout

```
<YYYY-MM-DD>-<HHMM>/
  span.spn    the NSE SPAN file of that day, cut down with trimSpanXml to the books' symbols
  ael.csv     that day's exposure-margin file
  case.json   { "taken": "<ISO+05:30>", "broker": "<name>",
                "books": [{ "name": "…", "positions": SpanPosition[], "brokerSpan": number, "brokerExposure": number }] }
```

`positions` use the `SpanPosition` shape of `src/margin.ts` (signed units, expiry `YYYY-MM-DD`).
A book passes when `|ours.total − (brokerSpan + brokerExposure)| ≤ 1 %` of the broker total; the failure message prints ours and the broker's span and exposure separately.
