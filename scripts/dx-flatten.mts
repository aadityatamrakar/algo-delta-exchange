/**
 * EMERGENCY FLATTEN of one Delta account — operator-run. See
 * docs/runbooks/dx-emergency-flatten.md.
 *
 *   node --env-file=.env.local scripts/dx-flatten.mts --rail live            # dry run: read only
 *   node --env-file=.env.local scripts/dx-flatten.mts --rail live --yes      # cancel all, close_all
 *
 * Keys come from the broker store (`desk-brokers` kinds `delta` / `delta-demo`,
 * needs DESK_MONGO_URL and DESK_MASTER_KEY), env as the fallback — the
 * gateway's own loaders, so a production key only goes to production and a
 * testnet key only to testnet.
 */
import { DxRest } from '@algomaker/dx'
import { connectMongo } from '../apps/api/src/mongo.ts'
import { DX_USER_AGENT, loadDxConfig, loadDxDemoConfig, readDeltaBrokerStore } from '../apps/order-gateway/src/dx-config.ts'
import { parseFlattenArgs, runFlatten } from '../apps/watchdog/src/flatten.ts'

const quiet = (): void => {}

async function main(): Promise<void> {
  const args = parseFlattenArgs(process.argv.slice(2))
  const url = process.env['DESK_MONGO_URL']
  if (url === undefined || url === '') throw new Error('DESK_MONGO_URL is required (run with --env-file=.env.local)')
  const mongo = await connectMongo(url)
  try {
    const db = mongo.db as unknown as { collection(name: string): unknown }
    const cfg =
      args.rail === 'live'
        ? await loadDxConfig(() => readDeltaBrokerStore(db, quiet, 'delta'), process.env, quiet)
        : await loadDxDemoConfig(() => readDeltaBrokerStore(db, quiet, 'delta-demo'), process.env, quiet)
    console.log(`Delta ${args.rail.toUpperCase()} account at ${cfg.baseUrl}`)
    const rest = new DxRest({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, apiSecret: cfg.apiSecret, userAgent: `${DX_USER_AGENT} flatten` })
    await runFlatten({ rest, yes: args.yes, print: (l) => console.log(l) })
  } finally {
    await mongo.close()
  }
}

main().catch((err: unknown) => {
  console.error(`dx-flatten: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
