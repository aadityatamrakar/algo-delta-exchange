/**
 * THE DELTA CLONE STAYS OFF THE LIVE NSE DESK.
 *
 * This checkout (/opt/algomaker-delta) shares a box with the live NSE desk
 * (/opt/algomaker): the same mongod on 127.0.0.1:27017, the same pm2 daemon,
 * the same host for cookies. The live desk owns database `algomaker`, ports
 * 8790-8799 and the pm2 namespace `desk` with apps `desk-*`; this clone owns
 * `algomaker_dx` (tests: `algomaker_dx_*`), ports 8890-8899 (vite 5184/5185),
 * the dashboard's static server on 5000 (`DESK_WEB_PORT`),
 * the namespaces `dx` / `dxtraders` with apps `dx-*`, and the cookies
 * `dx_desk_session` / `dx_traders_session`.
 *
 * Commits are cherry-picked over from the NSE repo, and each one can bring a
 * live default back with it. This test fails when one does. It is deliberately
 * narrow: it matches only the shapes those defaults take (a port after `:`, a
 * quote, `=`, `?` or `port`; the db URL; a pm2 name or namespace where pm2
 * reads one), so prices, collection names (`desk-books`) and launcher paths
 * (`bin/desk-api.mjs`) pass.
 *
 * NOT SCANNED, on purpose: node_modules; archive/ (the legacy reference
 * implementation the golden suites run unmodified); docs/, context/, memory/,
 * .superpowers/ and *.md (prose about the NSE desk, not code anything runs);
 * fixtures (recorded market data, where 879x is a price); package-lock.json
 * (registry URLs and hashes); binary files.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))

const SKIP_DIRS = ['node_modules/', 'archive/', 'docs/', 'context/', 'memory/', '.superpowers/', '.git/']
const BINARY = /\.(png|jpe?g|gif|ico|webp|zip|exe|spn|woff2?|ttf|eot|pdf)$/i

function skipped(path: string): boolean {
  if (SKIP_DIRS.some((d) => path.startsWith(d) || path.includes(`/${d}`))) return true
  if (path.includes('/fixtures/') || path.startsWith('fixtures/')) return true
  if (path.endsWith('.md') || path === 'package-lock.json') return true
  return BINARY.test(path)
}

/** The tracked files; a plain walk when git is not there, so the guard never silently scans nothing. */
function sourceFiles(): string[] {
  let all: string[]
  try {
    all = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split('\0')
      .filter((f) => f !== '')
  } catch {
    all = []
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name)
        const rel = relative(ROOT, full)
        if (skipped(`${rel}/`) && statSync(full).isDirectory()) continue
        if (statSync(full).isDirectory()) walk(full)
        else all.push(rel)
      }
    }
    walk(ROOT)
  }
  return all.filter((f) => !skipped(f))
}

const APPS = '(?:api|gateway|marketdata|runner|supervisor|traders)'
const PM2_VERB = '(?:start|stop|restart|reload|delete|logs|flush|describe|startOrRestart)'

/** Each rule is run over the whole file, so a call split across lines (`app(\n  'desk-gateway',`) is still seen. */
const RULES: readonly { readonly what: string; readonly re: RegExp }[] = [
  { what: 'a live desk port (8790-8799)', re: /(?::|['"`]|[=?|]\s*|\bport\s*[:=]?\s*)879\d(?!\d|\.\d)/gi },
  { what: 'the live desk database (27017/algomaker)', re: /27017\/algomaker(?!_dx)/g },
  { what: 'the live desk database by name', re: /(?:getSiblingDB|\.db)\(\s*['"`]algomaker(?!_dx)[\w-]*['"`]/g },
  { what: "the live pm2 namespace 'desk'", re: /\bnamespace\s*:\s*['"`]desk['"`]/g },
  { what: 'the live pm2 namespace on a pm2 command line', re: new RegExp(`\\bpm2\\)?\\s+${PM2_VERB}\\s+(?:--?\\S+\\s+)*desk(?![-\\w.])`, 'gi') },
  { what: 'a live pm2 app name', re: new RegExp(`\\b(?:name|app)\\s*(?::|\\(|===?)\\s*['"\`]desk-${APPS}\\b`, 'g') },
  { what: 'a live pm2 app name on a pm2 command line', re: new RegExp(`\\bpm2\\)?\\s+${PM2_VERB}\\s+(?:--?\\S+\\s+)*desk-${APPS}\\b`, 'gi') },
  { what: 'a live pm2 app name after --only', re: new RegExp(`--only\\s+desk-${APPS}\\b`, 'g') },
  { what: 'a filter on the live pm2 app prefix', re: /startsWith\(\s*['"`]desk-['"`]\s*\)/g },
  { what: 'a live pm2 log file', re: new RegExp(`logs/desk-${APPS}(?:-span|-vol)?-(?:out|err)\\.log`, 'g') },
  { what: 'a live session cookie name', re: /\bSESSION_COOKIE\s*=\s*['"`](?:desk|traders)_session['"`]/g },
]

/** A live port number built at run time, so this file never holds the literal it hunts for. */
const live = (tail: number): string => String(8700 + tail)

/**
 * Known, reviewed exceptions: [file, the exact matched text, why]. Each needs its reason.
 */
const ALLOW: readonly (readonly [string, string, string])[] = [
  // The test-side guard that REPLACES a live-desk DESK_SUPERVISOR_PORT has to name the live range to test for it.
  ['apps/api/test/require-mongo.ts', `= ${live(90)}`, 'the live-port range check in isLiveDeskPort()'],
  ['apps/api/test/require-mongo.ts', `= ${live(99)}`, 'the live-port range check in isLiveDeskPort()'],
]

function lineOf(text: string, index: number): number {
  let n = 1
  for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) n += 1
  return n
}

test('no tracked source file carries a live NSE desk port, database, pm2 name or cookie', () => {
  const files = sourceFiles()
  assert.ok(files.length > 500, `scanned only ${String(files.length)} files — the file list is wrong, not the tree clean`)
  const hits: string[] = []
  for (const file of files) {
    let text: string
    try {
      text = readFileSync(join(ROOT, file), 'utf8')
    } catch {
      continue
    }
    if (text.includes('\0')) continue
    for (const { what, re } of RULES) {
      for (const m of text.matchAll(re)) {
        if (ALLOW.some(([f, s]) => f === file && m[0] === s)) continue
        hits.push(`${file}:${String(lineOf(text, m.index ?? 0))}  ${what}: ${JSON.stringify(m[0])}`)
      }
    }
  }
  assert.deepEqual(hits, [], `live desk defaults in the Delta clone:\n${hits.join('\n')}`)
})

test('every allowlisted exception still exists, so the list cannot rot into a blanket pass', () => {
  for (const [file, s, why] of ALLOW) {
    assert.ok(readFileSync(join(ROOT, file), 'utf8').includes(s), `${file} no longer contains ${JSON.stringify(s)} (${why})`)
  }
})

test('the rules catch what they are for', () => {
  const caught = (s: string): boolean => RULES.some(({ re }) => new RegExp(re.source, re.flags).test(s))
  for (const bad of [
    `const URL = 'http://127.0.0.1:${live(90)}'`,
    `DESK_PORT: '${live(93)}'`,
    `Number(process.env.PORT ?? ${live(92)})`,
    `{ log, fetch, port: ${live(99)} }`,
    "'mongodb://127.0.0.1:27017/" + "algomaker'",
    "'mongodb://127.0.0.1:27017/" + "algomaker_bridge_test'",
    "db.getSiblingDB('" + "algomaker')",
    "namespace: '" + "desk',",
    "app('" + "desk-api', 'bin/desk-bridge.mjs'",
    "app(\n      '" + 'desk-gateway' + "',",
    "name: '" + "desk-traders',",
    '$(PM2) stop ' + 'desk',
    'npx pm2 logs ' + 'desk-api --lines 40',
    '--only ' + 'desk-runner',
    "p.name?.startsWith('" + "desk-')",
    "out_file: 'logs/" + "desk-traders-out.log'",
    "SESSION_COOKIE = '" + "desk_session'",
  ]) assert.ok(caught(bad), bad)
  for (const fine of [
    "'mongodb://127.0.0.1:27017/algomaker_dx'",
    "'mongodb://127.0.0.1:27017/algomaker_dx_bridge_test'",
    "DESK_PORT: '8890'",
    // The dx dashboard's static server, on the operator's choice of port.
    "DESK_WEB_PORT: '5000'",
    'http://127.0.0.1:5000',
    'timeValue: 8750',
    'price = 8790.5',
    "const COLLECTION = 'desk-books'",
    "script: 'bin/desk-marketdata.mjs'",
    'pm2 start ecosystem.desk.config.cjs',
    "id: 'dx-api'",
    "namespace: 'dx',",
  ]) assert.ok(!caught(fine), fine)
})

test('the pm2 file loads with dx names, dx namespaces and no live default in any env', () => {
  const require = createRequire(import.meta.url)
  for (const file of ['ecosystem.desk.config.cjs']) {
    const eco = require(join(ROOT, file)) as { apps: { name: string; namespace: string; out_file?: string; env?: Record<string, string> }[] }
    assert.ok(eco.apps.length > 0, file)
    for (const app of eco.apps) {
      assert.match(app.name, /^dx-/, `${file}: ${app.name}`)
      assert.ok(!['desk', 'traders'].includes(app.namespace), `${file}: ${app.name} is in the live namespace ${app.namespace}`)
      assert.match(app.namespace, /^dx/, `${file}: ${app.name}`)
      if (app.out_file !== undefined) assert.match(app.out_file, /^logs\/dx-/, `${file}: ${app.name}`)
      for (const [k, v] of Object.entries(app.env ?? {})) {
        assert.doesNotMatch(String(v), /(?::|^)879\d(?!\d)/, `${file}: ${app.name} ${k}`)
        assert.doesNotMatch(String(v), /27017\/algomaker(?!_dx)/, `${file}: ${app.name} ${k}`)
      }
    }
  }
})
