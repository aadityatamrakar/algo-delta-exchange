/**
 * The desk playbooks (spec 2026-11-01 P1–P3): the loader on the repo's files and on strings, the read_playbook tool,
 * the prompt's new sections and the tools' order. No Mongo.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parsePlaybook, parsePlaybooks, PLAYBOOK_NAMES, PLAYBOOKS, playbookIndex } from '../src/agent/playbooks.ts'
import { PROMPT_VERSION, SYSTEM_PROMPT } from '../src/agent/prompt.ts'
import { LegAliases, Redactor } from '../src/agent/redact.ts'
import type { ToolCtx } from '../src/agent/tools/ctx.ts'
import { AGENT_TOOLS } from '../src/agent/tools/index.ts'
import { PlanCache } from '../src/agent/tools/plans.ts'
import { readPlaybook } from '../src/agent/tools/playbook.ts'

const STEMS = readdirSync(fileURLToPath(new URL('../src/agent/playbooks/', import.meta.url))).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).sort()
const EIGHT = ['adjust', 'book-review', 'breakeven', 'desk-record', 'expiry-week', 'move-check', 'new-entry', 'vol-read']

const file = (o: { name?: string; title?: string; useWhen?: string; extra?: string; body?: string } = {}): string =>
  `---\nname: ${o.name ?? 'move-check'}\ntitle: ${o.title ?? 'How much has it moved'}\nuse-when: ${o.useWhen ?? '"why is X moving"'}\n${o.extra ?? ''}---\n\n${o.body ?? '# Body\n\nSteps.'}\n`

test('all eight playbooks load: names are the file stems, sorted, each with a title, a use-when line and a body', () => {
  assert.deepEqual(STEMS, EIGHT)
  assert.deepEqual(PLAYBOOKS.map((p) => p.name), EIGHT)
  assert.deepEqual([...PLAYBOOK_NAMES], EIGHT)
  for (const p of PLAYBOOKS) {
    assert.ok(p.title.length > 0 && p.useWhen.length > 0, p.name)
    assert.ok(p.body.startsWith('# '), `${p.name}: the body starts at its heading, the frontmatter is not in it`)
    assert.equal(p.body.includes('use-when:'), false, p.name)
  }
  assert.equal(PLAYBOOKS.find((p) => p.name === 'book-review')?.title, 'Book review')
})

test('the parser: the three keys, the body after the frontmatter, CRLF, other keys ignored', () => {
  const p = parsePlaybook('move-check', file({ extra: 'tags: ignored\n' }))
  assert.deepEqual(p, { name: 'move-check', title: 'How much has it moved', useWhen: '"why is X moving"', body: '# Body\n\nSteps.' })
  assert.deepEqual(parsePlaybook('move-check', file().replace(/\n/g, '\r\n')), { ...p })
  assert.equal(parsePlaybook('a', file({ name: 'a', useWhen: 'x: y, a colon inside the value' })).useWhen, 'x: y, a colon inside the value')
})

test('malformed frontmatter throws, naming the file', () => {
  const bad: readonly [string, string, RegExp][] = [
    ['no frontmatter', '# Just a body\n', /move-check\.md: no frontmatter/],
    ['not closed', '---\nname: move-check\ntitle: t\nuse-when: u\n# Body\n', /no closing ---/],
    ['missing title', '---\nname: move-check\nuse-when: u\n---\nbody\n', /title is missing/],
    ['empty use-when', '---\nname: move-check\ntitle: t\nuse-when:   \n---\nbody\n', /use-when is missing/],
    ['a key twice', '---\nname: move-check\ntitle: t\ntitle: t2\nuse-when: u\n---\nbody\n', /title is given twice/],
    ['not key: value', '---\nname: move-check\ntitle t\nuse-when: u\n---\nbody\n', /not a "key: value" line/],
    ['name not the stem', file({ name: 'moves' }), /name "moves" is not the file's stem/],
    ['name not kebab-case', file({ name: 'Move_Check' }), /not kebab-case/],
  ]
  for (const [why, text, re] of bad) assert.throws(() => parsePlaybook('move-check', text), re, why)
  assert.throws(() => parsePlaybooks([{ stem: 'a', text: file({ name: 'a' }) }, { stem: 'a', text: file({ name: 'a' }) }]), /the name is used twice/)
  assert.deepEqual(parsePlaybooks([{ stem: 'b', text: file({ name: 'b' }) }, { stem: 'a', text: file({ name: 'a' }) }]).map((p) => p.name), ['a', 'b'])
})

test('the prompt: the desk\'s way, the playbook index (one line each, in name order), the answer format — in that place, byte-stable', () => {
  assert.equal(PROMPT_VERSION, 'desk-ai-2026-11-01.1')
  const at = (s: string): number => {
    const i = SYSTEM_PROMPT.indexOf(`\n${s}\n`)
    assert.ok(i >= 0, s)
    return i
  }
  const order = ['What you are', 'The desk\'s way', 'Desk playbooks', 'Style', 'Answer format', 'Asked about a book', 'Recommending', 'Data quality'].map(at)
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'the sections in the spec\'s order')
  assert.ok(SYSTEM_PROMPT.includes(`\n${playbookIndex()}\n`))
  for (const p of PLAYBOOKS) assert.ok(SYSTEM_PROMPT.includes(`\n- ${p.name}: ${p.useWhen}\n`), p.name)
  assert.match(SYSTEM_PROMPT, /call read_playbook for it \(at most two a turn\); its steps and answer shape take precedence over the general style/)
  assert.match(SYSTEM_PROMPT, /a 7%\+ move from entry, or 8\+ adjustment days/)
  assert.match(SYSTEM_PROMPT, /So the first check on any book is the tested side\./)
  assert.match(SYSTEM_PROMPT, /- First line: the answer in one bold sentence with its key figure\./)
  assert.match(SYSTEM_PROMPT, /each opened by a `### ` heading of one to three words/)
  assert.match(SYSTEM_PROMPT, /Never a header-less table\./)
  assert.match(SYSTEM_PROMPT, /goes last, once, on a line starting with `> `\./)
  assert.equal(/\d{4}-\d{2}-\d{2}|\d{1,2}:\d{2}/.test(SYSTEM_PROMPT), false, 'no date or time, from the playbooks either')
  const desksWay = SYSTEM_PROMPT.slice(at('The desk\'s way'), at('Desk playbooks')).trim().split('\n')
  assert.equal(desksWay.length, 5, 'a heading and four lines')
})

const NOW = Date.parse('2026-10-19T10:00:00+05:30')
const ctx = {
  trader: 'ravi', deps: { now: () => NOW, quotes: { feedAlive: () => true } } as never, aliases: new LegAliases(), plans: new PlanCache(),
  redactor: new Redactor({ trader: 'ravi', legs: [] }), counters: { toolCalls: 0, searches: 0 }, allowClose: false, userText: '', presets: [],
  view: null, stock: null, nextCardId: () => 'K1',
} satisfies ToolCtx

test('read_playbook: a closed list of names, the body with the R9 envelope, a label and summary from the title', async () => {
  assert.equal(readPlaybook.input.safeParse({ name: 'adjust' }).success, true)
  assert.equal(readPlaybook.input.safeParse({ name: 'nope' }).success, false, 'not a search: only the listed names')
  assert.equal(readPlaybook.input.safeParse({ name: '../prompt' }).success, false)
  assert.equal(readPlaybook.input.safeParse({ name: 'adjust', extra: 1 }).success, false, 'strict')
  assert.equal(readPlaybook.label({ name: 'book-review' }), 'reading the Book review playbook')
  const out = await readPlaybook.run(ctx, { name: 'desk-record' })
  const want = PLAYBOOKS.find((p) => p.name === 'desk-record')
  assert.ok(want)
  assert.deepEqual([out.result['name'], out.result['title'], out.result['body']], [want.name, want.title, want.body])
  for (const k of ['asOf', 'closed', 'feedAlive', 'stale', 'warnings']) assert.ok(k in out.result, k)
  assert.equal(out.result['asOf'], NOW)
  assert.equal(out.summary, want.title)
})

test('the tools: get_track_record right after get_events, read_playbook last', () => {
  const names = AGENT_TOOLS.map((t) => t.name)
  assert.equal(names[names.indexOf('get_events') + 1], 'get_track_record')
  assert.equal(names.at(-1), 'read_playbook')
  assert.equal(new Set(names).size, names.length)
})
