/**
 * The desk playbooks (spec 2026-11-01 P1): the open-source skill-router
 * pattern (LLMQuant, Agent Skills) inside our own tool loop. A short index —
 * one line per playbook — is always in the system prompt; the body is read on
 * demand with `read_playbook`, so the prompt stays small and the steps for a
 * book review, an adjustment or an entry are the desk's own, written from its
 * trade record (playbooks/desk-record.md).
 *
 * WHY read once at module load, sorted by name: the index sits in the cached
 * prompt prefix every trader shares, so it must be byte-stable — the same
 * files give the same bytes, in the same order, on every start. A playbook
 * that does not parse stops the app at start, never a turn.
 *
 * The app runs from source (`node src/main.ts`), so the folder next to this
 * file is there on the box.
 */

import { readdirSync, readFileSync } from 'node:fs'

export interface Playbook {
  /** Kebab-case, equal to the file's stem: what `read_playbook` takes. */
  readonly name: string
  readonly title: string
  /** One line: the questions it answers. Goes into the prompt's index. */
  readonly useWhen: string
  /** The markdown after the frontmatter. */
  readonly body: string
}

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/
const KEYS = ['name', 'title', 'use-when'] as const

/**
 * One playbook file: a `---` frontmatter of `name`, `title` and `use-when` (one line each, `key: value`), then the
 * body. Throws, naming the file, on no frontmatter, a line that is not `key: value`, a key given twice, a missing or
 * empty key, or a name that is not kebab-case or not the stem. Other keys are ignored.
 */
export function parsePlaybook(stem: string, text: string): Playbook {
  const bad = (why: string): Error => new Error(`playbook ${stem}.md: ${why}`)
  const src = text.replace(/\r\n/g, '\n')
  if (!src.startsWith('---\n')) throw bad('no frontmatter (the file must start with a --- line)')
  const end = src.indexOf('\n---', 3)
  if (end < 0 || (src[end + 4] !== undefined && src[end + 4] !== '\n')) throw bad('the frontmatter has no closing --- line')
  const fields = new Map<string, string>()
  for (const line of src.slice(4, end).split('\n')) {
    if (line.trim() === '') continue
    const m = /^([a-z][a-z-]*):(.*)$/.exec(line)
    if (m === null) throw bad(`not a "key: value" line in the frontmatter: ${line}`)
    const [, key = '', value = ''] = m
    if (fields.has(key)) throw bad(`${key} is given twice`)
    fields.set(key, value.trim())
  }
  for (const k of KEYS) if ((fields.get(k) ?? '') === '') throw bad(`${k} is missing`)
  const name = fields.get('name') ?? ''
  if (!KEBAB.test(name)) throw bad(`name "${name}" is not kebab-case`)
  if (name !== stem) throw bad(`name "${name}" is not the file's stem`)
  return { name, title: fields.get('title') ?? '', useWhen: fields.get('use-when') ?? '', body: src.slice(end + 4).trim() }
}

/** Every file parsed, sorted by name (the prompt's order); a name given twice throws. */
export function parsePlaybooks(files: readonly { readonly stem: string; readonly text: string }[]): readonly Playbook[] {
  const out = files.map((f) => parsePlaybook(f.stem, f.text)).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (let i = 1; i < out.length; i++) if (out[i]?.name === out[i - 1]?.name) throw new Error(`playbook ${out[i]?.name ?? ''}: the name is used twice`)
  return out
}

/** The `.md` files of a folder, parsed. */
export function loadPlaybooks(dir: URL): readonly Playbook[] {
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => ({ stem: e.name.slice(0, -'.md'.length), text: readFileSync(new URL(e.name, dir), 'utf8') }))
  if (files.length === 0) throw new Error('no playbooks in agent/playbooks/')
  return parsePlaybooks(files)
}

export const PLAYBOOKS: readonly Playbook[] = loadPlaybooks(new URL('./playbooks/', import.meta.url))

/** The names, as `z.enum` takes them (never empty: loading throws first). */
export const PLAYBOOK_NAMES = PLAYBOOKS.map((p) => p.name) as [string, ...string[]]

/** The prompt's index: one `- name: use-when` line per playbook, in name order. */
export const playbookIndex = (books: readonly Playbook[] = PLAYBOOKS): string => books.map((p) => `- ${p.name}: ${p.useWhen}`).join('\n')

export function playbookOf(name: string): Playbook | null {
  return PLAYBOOKS.find((p) => p.name === name) ?? null
}
