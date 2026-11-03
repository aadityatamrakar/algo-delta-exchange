/**
 * Operator CLI for the bridge.
 *
 *   node apps/api/src/cli.ts sync                 refresh the instrument master
 *   node apps/api/src/cli.ts seed --file <path> [--replace]  seed a book from a JSON file
 *   node apps/api/src/cli.ts positions <TAG> [--mode paper]
 *   node apps/api/src/cli.ts diff <TAG>
 *   node apps/api/src/cli.ts fold-paper --lookback-hours <n> [--dry-run | --apply]
 *   node apps/api/src/cli.ts migrate-check
 *   node apps/api/src/cli.ts migrate-book --symbol BHEL --tag <TAG> [--mode paper] [--expiry YYYY-MM-DD]
 *   node apps/api/src/cli.ts migrate-declaration --symbol BHEL --tag <TAG>
 *   node apps/api/src/cli.ts backfill-series [--dry-run]
 *
 * These are the things a human does around the desk, not things the desk does
 * itself. Kept out of the HTTP surface so that an operator action can never be
 * triggered by a misdirected client request.
 *
 * THIS CLI DOES NOT CALL `ensureIndexes`, and that is deliberate. The new unique
 * indexes on `{tag, mode}` / `{tag}` cannot be built while untagged documents
 * remain (Mongo indexes a missing field as `null`, so two of them collide), so
 * a tool that built them on connect would be unusable against precisely the
 * database it exists to repair. Run `migrate-check`, migrate everything it
 * names, and only then restart the API — which does call `ensureIndexes`.
 */

import { readFile } from 'node:fs/promises'
import { OptionMaster } from '@algomaker/instruments'
import { bookGreeks, type PositionLeg } from '@algomaker/greeks'
import { connectMongo } from './mongo.ts'
import { COLLECTIONS, DeskStore } from './store.ts'
import { seedBook } from './seed.ts'
import { validateSeedRequest } from './validate.ts'
import { backfillSeriesFromAudit, migrateBookToTag, migrateDeclarationToTag, migrationCheck } from './migrate.ts'
import { StaticMarks } from './marks.ts'
import { runSync, loadStoredInstruments } from '../../marketdata/src/sync-runner.ts'
import type { DeskMode } from './contract.ts'
import { createPaperFillFolder, listFoldable } from './paper-fold.ts'

/** One `fold-paper` run handles at most this many documents. */
const FOLD_PAPER_LIMIT = 500

const MONGO = process.env['DESK_MONGO_URL'] ?? 'mongodb://127.0.0.1:27017/algomaker_dx'

/** Underlyings the sync keeps. Adding a stock is a change to this line. */
const UNIVERSE = (process.env['DESK_UNIVERSE'] ?? 'NIFTY,BANKNIFTY,SENSEX,BHEL')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s !== '')

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const has = (flag: string): boolean => process.argv.includes(flag)

async function main(): Promise<void> {
  const cmd = process.argv[2]
  const mongo = await connectMongo(MONGO)
  const store = new DeskStore(mongo.db)

  try {
    switch (cmd) {
      case 'sync': {
        const plan = await runSync({
          collection: mongo.db.collection('instrument'),
          universe: { names: UNIVERSE },
          // Never delete a contract an open book still references.
          referencedTokens: async () => {
            const tokens = new Set<number>()
            for (const mode of ['paper', 'live'] as const) {
              for (const b of await store.allBooks(mode)) {
                for (const l of b.legs) {
                  if (l.instrument.instrumentToken !== undefined) {
                    tokens.add(l.instrument.instrumentToken)
                  }
                }
              }
            }
            return tokens
          },
          log: (m, c) => console.log(m, c ?? ''),
        })
        console.log(JSON.stringify(plan.counts, null, 2))
        break
      }

      /**
       * Generic seed, replacing the hardcoded `seed-bhel` command (retired
       * alongside `BHEL_SEED` — see `seed.ts`).
       *
       * Validated at least as strictly as the HTTP `/v1/desk/seed` path
       * (`validateSeedRequest`) — a file is still an untrusted boundary, and
       * this is the one command that can invent a position out of nothing.
       */
      case 'seed': {
        const file = arg('--file')
        if (file === undefined) {
          console.error('usage: seed --file <path-to-seed.json> [--replace]')
          process.exitCode = 2
          break
        }
        const parsed = validateSeedRequest(JSON.parse(await readFile(file, 'utf8')))
        if (!parsed.ok) {
          console.error(parsed.error)
          process.exitCode = 2
          break
        }
        const master = new OptionMaster(await loadStoredInstruments(mongo.db.collection('instrument')))
        const res = await seedBook(parsed.value, {
          store,
          master,
          nowMs: Date.now(),
          replace: has('--replace'),
        })
        for (const l of res.booked) {
          console.log(
            `  ${l.side === 'Sell' ? 'SHORT' : 'LONG '} ${String(l.qty).padStart(7)} ` +
              `${l.instrument.tradingsymbol.padEnd(20)} @ ${l.entryPrice}`,
          )
        }
        if (res.unresolved.length > 0) {
          console.log('UNRESOLVED:', JSON.stringify(res.unresolved, null, 2))
          process.exitCode = 1
        }
        console.log(`booked ${res.booked.length} legs into ${parsed.value.symbol} (${parsed.value.mode})`)
        break
      }

      case 'positions': {
        const tag = process.argv[3]
        if (tag === undefined) throw new Error('usage: positions <TAG>')
        const mode = (arg('--mode') ?? 'paper') as DeskMode
        const spot = Number(arg('--spot') ?? NaN)
        // Books are keyed by tag, not symbol — read the whole document so the
        // underlying (needed for the spot lookup below) comes from the store
        // rather than being guessed from the tag string.
        const doc = await store.bookDoc(tag, mode)
        const legs = doc?.legs ?? []
        const symbol = doc?.symbol ?? ''
        console.log(`${tag} (${mode}): ${legs.length} legs${symbol === '' ? '' : ` on ${symbol}`}`)

        // Marks: the entry price unless --spot given, in which case the caller
        // is doing a what-if and prices are stale by definition.
        const marks = new StaticMarks(
          Object.fromEntries(legs.map((l) => [l.instrument.tradingsymbol, l.entryPrice])),
          { [symbol]: Number.isNaN(spot) ? 0 : spot },
        )
        const priced: PositionLeg[] = []
        for (const l of legs) {
          const mk = marks.price(l.instrument)
          const sp = marks.spot(symbol)
          if (mk === null || sp === null || sp === 0) continue
          priced.push({
            tradingsymbol: l.instrument.tradingsymbol,
            underlying: l.underlying,
            strike: l.strike,
            type: l.type,
            expiry: l.expiry,
            qty: l.qty,
            spot: sp,
            markPrice: mk,
          })
        }
        const g = bookGreeks(priced, Date.now())
        for (const lg of g.legs) {
          console.log(
            `  ${lg.tradingsymbol.padEnd(20)} qty=${String(lg.qty).padStart(7)} ` +
              `iv=${((lg.iv ?? 0) * 100).toFixed(1).padStart(5)}% ` +
              `delta=${lg.delta.toFixed(3).padStart(7)} posDelta=${lg.positionDelta.toFixed(0).padStart(8)}`,
          )
        }
        console.log(
          `\n  NET delta=${g.netDelta.toFixed(0)} gamma=${g.netGamma.toFixed(1)} ` +
            `vega=${g.netVega.toFixed(0)} theta=${g.netTheta.toFixed(0)}/day`,
        )
        if (g.unpriced.length > 0) console.log(`  UNPRICED (excluded): ${g.unpriced.join(', ')}`)
        break
      }

      case 'migrate-book': {
        const symbol = arg('--symbol')
        const tag = arg('--tag')
        const mode = (arg('--mode') ?? 'paper') as DeskMode
        if (symbol === undefined || tag === undefined) {
          console.error('usage: migrate-book --symbol BHEL --tag BHEL-2026-08-25-hold-recycle-r [--mode paper] [--expiry YYYY-MM-DD]')
          process.exitCode = 2
          break
        }
        const expiry = arg('--expiry')
        // `mongo.db` — `main()` already holds the handle above. `DeskStore`
        // exposes no public `db` accessor; do not add one for this.
        const result = await migrateBookToTag(
          mongo.db,
          expiry === undefined ? { symbol, mode, tag } : { symbol, mode, tag, expiry },
        )
        console.log(JSON.stringify(result, null, 2))
        if (!result.migrated) process.exitCode = 1
        break
      }

      case 'migrate-declaration': {
        const symbol = arg('--symbol')
        const tag = arg('--tag')
        if (symbol === undefined || tag === undefined) {
          console.error('usage: migrate-declaration --symbol BHEL --tag BHEL-2026-08-25-hold-recycle-r')
          process.exitCode = 2
          break
        }
        const result = await migrateDeclarationToTag(mongo.db, { symbol, tag })
        console.log(JSON.stringify(result, null, 2))
        if (!result.migrated) process.exitCode = 1
        break
      }

      /**
       * READ-ONLY. What must be migrated before the API is restarted.
       *
       * Exit 1 when anything is outstanding, so a deploy script can gate the
       * restart on it rather than on someone reading the output.
       */
      case 'migrate-check': {
        const check = await migrationCheck(mongo.db)
        for (const b of check.books) {
          console.log(
            `UNTAGGED BOOK        ${b.symbol}/${b.mode} (${b.legs} legs)  ->  ` +
              `migrate-book --symbol ${b.symbol} --tag <TAG> --mode ${b.mode}`,
          )
        }
        for (const d of check.declarations) {
          console.log(
            `UNTAGGED DECLARATION ${d.symbol} (${d.legs} legs)  ->  ` +
              `migrate-declaration --symbol ${d.symbol} --tag <TAG>`,
          )
        }
        console.log(
          check.clear
            ? 'nothing untagged — the new code can boot (ensureIndexes will build the unique tag indexes)'
            : `${check.books.length} book(s) and ${check.declarations.length} declaration(s) MUST be ` +
              'migrated before the API is restarted; the unique tag index cannot build over them',
        )
        if (!check.clear) process.exitCode = 1
        break
      }

      /**
       * The book-series backfill desk-api runs at every boot, by hand — for a
       * rehearsal against a copy of the data, or to see what it would label.
       * Idempotent; `--dry-run` writes nothing.
       *
       * Builds the one index the write relies on — the unique `{tag, mode}` on
       * `desk-book-series` (`recordSeries` is insert-only through it) — and
       * nothing else: the rest of `ensureIndexes` stays the API boot's, for
       * the reason in this file's header.
       */
      case 'backfill-series': {
        const dryRun = has('--dry-run')
        if (!dryRun) {
          await mongo.db.collection(COLLECTIONS.bookSeries).createIndex({ tag: 1, mode: 1 }, { unique: true })
        }
        const result = await backfillSeriesFromAudit(mongo.db, { dryRun })
        for (const r of result.recorded) {
          console.log(`${dryRun ? 'WOULD LABEL' : 'LABELLED   '} ${r.tag} (${r.mode}) -> ${r.series}  [${r.source}]`)
        }
        for (const u of result.unresolved) console.log(`UNLABELLED  ${u.tag} (${u.mode})`)
        console.log(
          `${result.recorded.length} ${dryRun ? 'would be labelled' : 'labelled'}, ` +
            `${result.already} already labelled, ${result.unresolved.length} left unlabelled`,
        )
        break
      }

      case 'diff': {
        const tag = process.argv[3]
        if (tag === undefined) throw new Error('usage: diff <TAG>')
        const ours = await store.loadBook(tag, (arg('--mode') ?? 'paper') as DeskMode)
        const declared = await store.loadDeclaration(tag)
        console.log(JSON.stringify({ ours: ours.length, declared: declared?.legs.length ?? null }, null, 2))
        break
      }

      case 'fold-paper': {
        /**
         * ONE paper fold pass over a WIDER window than desk-api's own 2 h one,
         * for orders the gateway closed long after they were created while no
         * fold was looking (2026-10-04: the SENSEX 10-01 hedge closes and
         * TCS-…:738, REJECTED by the restart sweep). DRY RUN BY DEFAULT: it
         * lists what it would fold and writes nothing. `--apply` folds.
         *
         * RUN IT AFTER `settle-expired` on any book whose leg has expired. Folding
         * settles the decision the supervisor is holding in flight, and the very
         * next pass then decides again — a close on a contract that no longer
         * trades, if the leg is still in the book.
         */
        const hours = Number(arg('--lookback-hours'))
        if (!(hours > 0)) {
          console.error('usage: fold-paper --lookback-hours <n> [--dry-run | --apply]')
          process.exitCode = 1
          break
        }
        const lookbackMs = hours * 3_600_000
        const now = Date.now()
        const docs = await listFoldable(store, now, lookbackMs, FOLD_PAPER_LIMIT)
        for (const d of docs) {
          console.log(
            [
              String(d['clientOrderId'] ?? ''),
              String(d['state'] ?? ''),
              `filled ${String(d['filledQty'] ?? 0)}`,
              `avg ${String(d['avgPrice'] ?? 'null')}`,
              String(d['tradingsymbol'] ?? ''),
              `resolved ${typeof d['resolvedAt'] === 'number' ? new Date(d['resolvedAt']).toISOString() : '?'}`,
            ].join('  '),
          )
        }
        if (!has('--apply') || has('--dry-run')) {
          console.log(`${String(docs.length)} unfolded terminal paper order(s) — dry run, nothing written. Re-run with --apply.`)
          break
        }
        const master = new OptionMaster(await loadStoredInstruments(mongo.db.collection('instrument')))
        const pass = await createPaperFillFolder(
          {
            store,
            master: () => master,
            now: () => now,
            log: (msg, detail) => console.log(msg, detail === undefined ? '' : JSON.stringify(detail)),
          },
          { lookbackMs, batchSize: FOLD_PAPER_LIMIT },
        ).run()
        console.log(JSON.stringify(pass))
        break
      }

      default:
        console.log(
          'commands: sync | seed --file <path> [--replace] | positions <TAG> [--spot N] | diff <TAG> | ' +
            'fold-paper --lookback-hours <n> [--dry-run | --apply] | ' +
            'migrate-check | ' +
            'migrate-book --symbol <SYM> --tag <TAG> [--mode paper] [--expiry YYYY-MM-DD] | ' +
            'migrate-declaration --symbol <SYM> --tag <TAG> | backfill-series [--dry-run]',
        )
    }
  } finally {
    await mongo.close()
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
