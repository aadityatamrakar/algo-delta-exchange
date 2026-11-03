/**
 * The ONLY file that touches the Mongo driver directly.
 *
 * Driver 3.7.3 is an EXACT PIN, and the reason it was chosen is gone: the tree
 * used to resolve it through `loopback-connector-mongodb`, and no LoopBack
 * server remains here — nothing in this repo depends on the driver except this
 * file, which declares it in `apps/api/package.json` (audit F-53: the comment
 * cited a constraint that had been removed, and the workspace that owns the
 * adapter did not declare the package it requires).
 *
 * WHAT SURVIVES THE CONSTRAINT: 3.7.3 is verified working against MongoDB 8.2,
 * which is what production runs — the driver is old, not incompatible — and the
 * pin stays exact because an upgrade to 4.x/6.x is a real change of behaviour
 * (a different connection-option surface, a different cursor API, and the
 * `useUnifiedTopology` note below stops applying) rather than a version bump.
 * It is now a DECISION with an expiry date instead of an inherited fact: when
 * the driver moves, this file and its `Database` port are the only two things
 * that have to change.
 *
 * It ships no bundled types, so the import is cast once, here, to the narrow
 * `Database` port. Everything downstream is fully typed against that port and
 * has no idea which driver is underneath.
 */

import { createRequire } from 'node:module'
import type { Collection, Database } from './store.ts'

const require = createRequire(import.meta.url)

interface RawClient {
  db(name?: string): unknown
  close(): Promise<void>
}

interface RawMongo {
  MongoClient: {
    connect(url: string, opts: Record<string, unknown>): Promise<RawClient>
  }
}

export interface MongoHandle {
  readonly db: Database
  close(): Promise<void>
}

/**
 * Connect and return the narrow port.
 *
 * `useUnifiedTopology` is required on 3.7 — without it the driver prints a
 * deprecation warning and uses the legacy monitoring engine, which does not
 * handle replica-set discovery the way change streams need.
 */
export async function connectMongo(
  url: string,
  opts: { serverSelectionTimeoutMS?: number } = {},
): Promise<MongoHandle> {
  const mongo = require('mongodb') as RawMongo
  const client = await mongo.MongoClient.connect(url, {
    useUnifiedTopology: true,
    serverSelectionTimeoutMS: opts.serverSelectionTimeoutMS ?? 5000,
  })
  const rawDb = client.db() as { collection(name: string): unknown }
  const db: Database = {
    collection<T>(name: string): Collection<T> {
      return rawDb.collection(name) as Collection<T>
    },
  }
  return {
    db,
    close: () => client.close(),
  }
}
