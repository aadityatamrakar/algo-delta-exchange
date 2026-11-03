/**
 * Mongo for the traders suites: one database per suite, never the desk's.
 * Each suite wipes its collections between tests and node:test runs files in
 * parallel processes, so two suites must never share a database.
 */

import { connectMongo, type MongoHandle } from '../../api/src/mongo.ts'
import { TradersDb, TRADERS_COLLECTIONS } from '../src/db.ts'

export function suiteUrl(suite: string): string {
  // TRADERS_TEST_LANE keeps worktrees that test at the same time out of each other's databases.
  const lane = process.env['TRADERS_TEST_LANE']
  const name = lane === undefined || lane === '' ? suite : `${lane}_${suite}`
  const url = process.env['DESK_TEST_MONGO'] ?? `mongodb://127.0.0.1:27017/algomaker_dx_traders_test_${name}`
  // Only a disposable algomaker_dx_* database: never the live desk's, never this clone's desk database (algomaker_dx),
  // and never the live repo's own test databases (algomaker_traders_test_*), which its suites wipe as they run.
  if (!new URL(url).pathname.replace(/^\//, '').startsWith('algomaker_dx_')) throw new Error('never the desk database: traders tests use algomaker_dx_traders_test_<suite>')
  return url
}

/** A connected handle and its TradersDb; null when no Mongo answers. */
export async function connectSuite(suite: string): Promise<{ handle: MongoHandle; db: TradersDb } | null> {
  const url = suiteUrl(suite)
  try {
    const handle = await connectMongo(url, { serverSelectionTimeoutMS: 1500 })
    await handle.db.collection('traders-users').countDocuments({}) // force the connection to be real
    return { handle, db: new TradersDb(handle.db) }
  } catch {
    return null
  }
}

export async function wipe(handle: MongoHandle, extra: readonly string[] = []): Promise<void> {
  for (const name of [...TRADERS_COLLECTIONS, ...extra]) await handle.db.collection(name).deleteMany({})
}
