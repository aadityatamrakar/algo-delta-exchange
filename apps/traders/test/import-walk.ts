/**
 * Which files does a set of entry points load at RUNTIME?
 *
 * Node strips types, so `import type` and `export type` vanish and load
 * nothing; every other import is a module load. No comment stripping on
 * purpose: a commented-out import is a loud false positive, never a miss.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

const STATIC_RE = /(?:^|[\n;])\s*(?:import|export)\s+(?!type\s)(?:[^'";]*?\sfrom\s*)?['"]([^'"\n]+)['"]/g
const DYNAMIC_RE = /(?:\bimport|\brequire)\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g

export const BANNED_FOR_TRADERS: readonly RegExp[] = [
  /^apps\/api\/src\/submit/,
  /^apps\/api\/src\/repair-apply/,
  /^apps\/order-gateway\//,
  /^packages\/order-bus\//,
  /^packages\/brokers\//,
]

const rel = (abs: string): string => relative(ROOT, abs).split('\\').join('/')

function packageEntry(spec: string): string {
  const m = /^@algomaker\/([^/]+)(?:\/(.+))?$/.exec(spec)
  if (m === null) throw new Error(`unresolved import ${spec}`)
  const pkgDir = join(ROOT, 'packages', m[1] as string)
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { exports?: Record<string, unknown> | string }
  const sub = m[2] === undefined ? '.' : `./${m[2]}`
  const exp = typeof pkg.exports === 'string' ? { '.': pkg.exports } : (pkg.exports ?? {})
  const hit = exp[sub]
  const target = typeof hit === 'string' ? hit : (hit as { import?: string; default?: string } | undefined)?.import ?? (hit as { default?: string } | undefined)?.default
  if (typeof target !== 'string') throw new Error(`unresolved import ${spec}`)
  return join(pkgDir, target)
}

export function walkRuntimeImports(entries: readonly string[]): { files: Set<string>; externals: Set<string> } {
  const files = new Set<string>()
  const externals = new Set<string>()
  const queue = entries.map((e) => resolve(ROOT, e))
  while (queue.length > 0) {
    const abs = queue.pop() as string
    const r = rel(abs)
    if (files.has(r)) continue
    files.add(r)
    if (abs.endsWith('.css')) continue
    const src = readFileSync(abs, 'utf8')
    const specs = new Set<string>()
    STATIC_RE.lastIndex = 0
    for (let m = STATIC_RE.exec(src); m !== null; m = STATIC_RE.exec(src)) specs.add(m[1] as string)
    // `require('x')` also turns up in prose (packages/strategy-kit/src/ports.ts
    // describes the legacy `require('../server.js')` in a JSDoc line), so the
    // call forms skip lines that are plainly comment text. Static imports need
    // no such rule: they must open a line, which a ` * ` comment line never does.
    for (const line of src.split('\n')) {
      if (/^\s*(?:\*|\/\/|\/\*)/.test(line)) continue
      DYNAMIC_RE.lastIndex = 0
      for (let m = DYNAMIC_RE.exec(line); m !== null; m = DYNAMIC_RE.exec(line)) specs.add(m[1] as string)
    }
    for (const spec of specs) {
      if (spec.startsWith('node:')) continue
      if (spec.startsWith('.') || spec.startsWith('/')) {
        const target = resolve(dirname(abs), spec)
        if (!existsSync(target) || !statSync(target).isFile()) throw new Error(`unresolved import ${spec} in ${r}`)
        queue.push(target)
      } else if (spec.startsWith('@algomaker/')) {
        queue.push(packageEntry(spec))
      } else {
        externals.add(spec)
      }
    }
  }
  return { files, externals }
}

/** Every .ts/.tsx under `dir` (repo-relative or absolute), as repo-relative paths. */
export function listSources(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.tsx?$/.test(name)) out.push(rel(p))
    }
  }
  walk(resolve(ROOT, dir))
  return out
}
