/**
 * The traders process: env -> Mongo (retrying) -> bus (not awaited) -> app ->
 * listen on loopback. Caddy is the only thing that reaches the port.
 * Started by pm2 through bin/desk-traders.mjs; nothing here places an order.
 */

import { connectWithRetry, installCrashGuards } from '@algomaker/core'
import { connectMongo } from '../../api/src/mongo.ts'
import { aiConfigFromEnv } from './agent/config.ts'
import { createApp } from './app.ts'
import { configFromEnv } from './config.ts'
import { TradersDb } from './db.ts'
import { openBus } from './market/bus.ts'

const log = (msg: string, ctx?: Record<string, unknown>): void => {
  console.log(`[traders] ${msg}`, ...(ctx === undefined ? [] : [JSON.stringify(ctx)]))
}

export async function main(): Promise<void> {
  installCrashGuards({ process, log })
  const config = configFromEnv()
  if (config.origins.length === 0) {
    log('WARNING: TRADERS_ORIGINS is empty — no browser page is allowed to write, so no browser will be able to save anything (log in, add a leg)')
  }

  // A retrying boot must still be stoppable, or `pm2 stop` waits out pm2's kill timeout.
  const bail = (signal: string) => (): void => { log(`${signal} received while still booting — exiting`); process.exit(0) }
  const bailTerm = bail('SIGTERM')
  const bailInt = bail('SIGINT')
  process.on('SIGTERM', bailTerm)
  process.on('SIGINT', bailInt)
  const mongo = await connectWithRetry(() => connectMongo(config.mongoUrl), { log, what: 'Mongo' })
  process.off('SIGTERM', bailTerm)
  process.off('SIGINT', bailInt)

  // the assistant: off unless TRADERS_AI_ENABLED=1 with a key; asked for and still off, one line says why (never the key)
  const ai = aiConfigFromEnv()
  if (ai.enabled) log('assistant on', { provider: ai.provider, model: ai.model, dailyUsd: ai.dailyUsd, traderDailyUsd: ai.traderDailyUsd })
  else if ((process.env['TRADERS_AI_ENABLED'] ?? '').trim() === '1') log(`assistant off: ${ai.reason ?? 'not configured'}`)

  const bus = openBus(config.busUrl, log) // reconnects by itself; the app does not wait for it
  const app = await createApp({ db: new TradersDb(mongo.db), bus, config, now: Date.now, log, assistant: { config: ai } })
  await app.start()
  await new Promise<void>((resolve, reject) => {
    app.server.once('error', reject)
    app.server.listen(config.port, '127.0.0.1', resolve)
  })
  log('listening', { port: config.port, origins: config.origins.length })

  let closing = false
  const shutdown = (signal: string): void => {
    if (closing) return
    closing = true
    log(`${signal} received — shutting down`)
    void (async () => {
      await app.stop()
      await new Promise<void>((r) => app.server.close(() => r()))
      await bus.close()
      await mongo.close()
      process.exit(0)
    })().catch((err: unknown) => { log('shutdown failed', { error: String(err) }); process.exit(1) })
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}
