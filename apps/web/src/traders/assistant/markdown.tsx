/**
 * The assistant's answer text as a little markdown: paragraphs, **bold**, *italics*, `code`, fenced code, bullet and
 * numbered lists, `#` headings (drawn as small section labels), `> ` callouts and simple pipe tables. Nothing else.
 *
 * Shaped for the answers the prompt asks for (spec 2026-11-01 P3): a bold one-sentence headline — drawn a step
 * larger as the answer's lead — then up to three `### ` sections of bullets or one table, then at most one `> `
 * caveat. Older answers read well too: a table with an empty header row (the model's old `| | |` key–value habit)
 * is drawn as a label → value list, never as an empty header row.
 *
 * It builds React elements and puts the model's words in them as TEXT, so whatever the text holds — `<script>`, an
 * `<img onerror>`, an entity — is shown as the characters it is and never parsed as HTML. No links, no images, no
 * raw HTML pass-through: an answer cannot make the page fetch or run anything.
 */

import { memo, useMemo, type ReactElement, type ReactNode } from 'react'

type Block =
  /** `lead`: the answer's first paragraph, wholly bold — its headline. */
  | { readonly kind: 'p'; readonly lines: readonly string[]; readonly lead?: true }
  | { readonly kind: 'h'; readonly text: string }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'ul' | 'ol'; readonly items: readonly string[] }
  | { readonly kind: 'table'; readonly head: readonly string[]; readonly align: readonly ('start' | 'end')[]; readonly rows: readonly (readonly string[])[] }
  /** `warn`: a caveat that opens with "Indicative" — drawn with the warning tint. */
  | { readonly kind: 'quote'; readonly lines: readonly string[]; readonly warn: boolean }

const FENCE = /^\s*```/
const BULLET = /^\s*[-*+]\s+(.*)$/
const NUMBERED = /^\s*\d{1,3}[.)]\s+(.*)$/
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/
const QUOTE = /^\s{0,3}>\s?(.*)$/
const TABLE_ROW = /^\s*\|.*\|\s*$/
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/
// The whole paragraph one bold run (a closing stop may sit outside it); "**a** b **c**" is not.
const WHOLLY_BOLD = /^(\*\*|__)(?=\S)(?:(?!\1)[\s\S])*?\S\1[.:!?]?$/
// A bold run still open at the end of the text: a headline mid-stream.
const OPEN_BOLD = /^([^*]*)\*\*(?=[^\s*])([^*]+)$/
const INDICATIVE = /^[*_\s]*indicative\b/i

function cells(row: string): string[] {
  const t = row.trim().replace(/^\|/, '').replace(/\|$/, '')
  return t.split('|').map((c) => c.trim())
}

/** The text cut into blocks; anything that is not a string is no text. Pure, exported for the tests. */
export function blocks(text: unknown): Block[] {
  if (typeof text !== 'string' || text === '') return []
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const out: Block[] = []
  let para: string[] = []
  const flush = (): void => { if (para.length > 0) { out.push({ kind: 'p', lines: para }); para = [] } }
  for (let i = 0; i < lines.length;) {
    const l = lines[i] as string
    if (FENCE.test(l)) {
      flush()
      const body: string[] = []
      i++
      while (i < lines.length && !FENCE.test(lines[i] as string)) body.push(lines[i++] as string)
      i++   // the closing fence (or the end)
      out.push({ kind: 'code', text: body.join('\n') })
      continue
    }
    if (TABLE_ROW.test(l) && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1] as string)) {
      flush()
      const head = cells(l)
      const align = cells(lines[i + 1] as string).map((c) => (c.endsWith(':') && !c.startsWith(':') ? 'end' as const : 'start' as const))
      i += 2
      const rows: string[][] = []
      while (i < lines.length && TABLE_ROW.test(lines[i] as string)) rows.push(cells(lines[i++] as string))
      out.push({ kind: 'table', head, align, rows })
      continue
    }
    const list = BULLET.test(l) ? 'ul' : NUMBERED.test(l) ? 'ol' : null
    if (list !== null) {
      flush()
      const re = list === 'ul' ? BULLET : NUMBERED
      const items: string[] = []
      while (i < lines.length) {
        const m = re.exec(lines[i] as string)
        if (m === null) break
        items.push(m[1] as string)
        i++
      }
      out.push({ kind: list, items })
      continue
    }
    const h = HEADING.exec(l)
    if (h !== null) { flush(); out.push({ kind: 'h', text: h[1] as string }); i++; continue }
    if (QUOTE.test(l)) {
      flush()
      const body: string[] = []
      while (i < lines.length) {
        const m = QUOTE.exec(lines[i] as string)
        if (m === null) break
        body.push((m[1] as string).trim())
        i++
      }
      const said = body.filter((x) => x !== '')
      if (said.length > 0) out.push({ kind: 'quote', lines: said, warn: INDICATIVE.test(said[0] as string) })
      continue
    }
    if (l.trim() === '') { flush(); i++; continue }
    para.push(l.trim())
    i++
  }
  flush()
  const first = out[0]
  const head = first?.kind === 'p' ? first.lines.join(' ') : ''
  // A headline still streaming (its closer not yet come, nothing after it) is the lead already, so it does not jump.
  if (first?.kind === 'p' && (WHOLLY_BOLD.test(head) || (out.length === 1 && OPEN_BOLD.test(head) && head.startsWith('**')))) {
    out[0] = { ...first, lead: true }
  }
  return out
}

// `code`, **bold** / __bold__, *italic* / _italic_ (an underscore inside a word, as in snake_case, is left alone).
const INLINE = /`([^`\n]+)`|\*\*(?=\S)([\s\S]*?\S)\*\*|__(?=\S)([\s\S]*?\S)__|\*(?=[^\s*])([^*\n]*?[^\s*])\*|(?<![\p{L}\p{N}])_(?=[^\s_])([^_\n]*?[^\s_])_(?![\p{L}\p{N}])/u

/** Inline marks as elements; everything else stays text (React escapes it). */
export function inline(text: string, key = 'i'): ReactNode[] {
  const out: ReactNode[] = []
  let rest = text
  let n = 0
  for (;;) {
    const m = INLINE.exec(rest)
    if (m === null) break
    if (m.index > 0) out.push(rest.slice(0, m.index))
    const k = `${key}.${n++}`
    if (m[1] !== undefined) out.push(<code key={k}>{m[1]}</code>)
    else if (m[2] !== undefined || m[3] !== undefined) out.push(<strong key={k}>{inline((m[2] ?? m[3]) as string, k)}</strong>)
    else out.push(<em key={k}>{inline((m[4] ?? m[5]) as string, k)}</em>)
    rest = rest.slice(m.index + m[0].length)
  }
  // A ** whose closer has not come yet (the answer is still streaming its bold headline): the rest of the line is
  // bold now, instead of showing the asterisks until the closer arrives.
  const open = OPEN_BOLD.exec(rest)
  if (open !== null) {
    if (open[1] !== '') out.push(open[1] as string)
    out.push(<strong key={`${key}.${n}`}>{open[2]}</strong>)
    return out
  }
  if (rest !== '') out.push(rest)
  return out
}

const NUMERIC = /^[−\-+]?[₹]?\s?[\d,.]+\s?(%|k|K|L|Cr|pts?|bps?|lots?|sh|x)?$/
/** A cell's figure without its marks, for the alignment test. */
const bare = (cell: string): string => cell.replace(/\*\*|__|`/g, '').trim()
/** No figure at all: an empty cell or a dash does not make a column text. */
const BLANK = /^(|—|–|-|n\/a)$/i
const numeric = (values: readonly string[]): boolean => {
  const said = values.map(bare).filter((v) => !BLANK.test(v))
  return said.length > 0 && said.every((v) => NUMERIC.test(v))
}

/** Lines of one paragraph or callout, a line break between them. */
const joined = (lines: readonly string[], k: string): ReactNode[] =>
  lines.flatMap((l, j) => (j === 0 ? inline(l, `${k}.${j}`) : [<br key={`${k}.br${j}`} />, ...inline(l, `${k}.${j}`)]))

function Table(props: { readonly b: Extract<Block, { kind: 'table' }>; readonly k: string }): ReactElement {
  const { b, k } = props
  const headless = b.head.every((h) => h === '')
  // A header row names the columns; a cell past them is dropped. With no names, the widest row decides.
  const width = headless ? Math.max(b.head.length, ...b.rows.map((r) => r.length)) : b.head.length
  // An empty header row is the old `| | |` key–value habit: label → value, not a table under a blank header.
  if (headless && width <= 2) {
    const figures = numeric(b.rows.map((r) => r[1] ?? ''))
    return (
      <dl className="traders-md-kv" data-numeric={figures ? 'true' : undefined}>
        {b.rows.flatMap((r, j) => [
          <dt key={`${j}k`}>{inline(r[0] ?? '', `${k}.${j}.0`)}</dt>,
          <dd key={`${j}v`}>{inline(r[1] ?? '', `${k}.${j}.1`)}</dd>,
        ])}
      </dl>
    )
  }
  const cols = Array.from({ length: width }, (_, c) => c)
  // A column is right-aligned when the rule says so or every figure in it is a number — header and cells alike.
  const align = cols.map((c) => (b.align[c] === 'end' || numeric(b.rows.map((r) => r[c] ?? '')) ? 'end' as const : 'start' as const))
  // An empty corner cell names the first column as the rows' labels.
  const rowHeads = !headless && b.head[0] === '' && width > 1
  return (
    <div className="traders-md-table">
      <table>
        {headless ? null : <thead><tr>{cols.map((c) => <th key={c} scope="col" data-align={align[c]}>{inline(b.head[c] ?? '', `${k}.h${c}`)}</th>)}</tr></thead>}
        <tbody>
          {b.rows.map((r, j) => (
            <tr key={j}>{cols.map((c) => {
              const cell = inline(r[c] ?? '', `${k}.${j}.${c}`)
              return c === 0 && rowHeads ? <th key={c} scope="row">{cell}</th> : <td key={c} data-align={align[c]}>{cell}</td>
            })}</tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Memoised, and parsed once per text: a streaming answer re-parses only its own text, never the conversation's. */
export const Markdown = memo(function Markdown(props: { readonly text: string }): ReactElement {
  const parsed = useMemo(() => blocks(props.text), [props.text])
  return (
    <div className="traders-md">
      {parsed.map((b, i) => {
        const k = `b${i}`
        switch (b.kind) {
          case 'p':
            return <p key={k} className={b.lead === true ? 'traders-md-lead' : undefined}>{joined(b.lines, k)}</p>
          case 'h':
            return <h4 key={k} className="traders-md-h">{inline(b.text, k)}</h4>
          case 'code':
            return <pre key={k}><code>{b.text}</code></pre>
          case 'ul':
            return <ul key={k}>{b.items.map((it, j) => <li key={j}>{inline(it, `${k}.${j}`)}</li>)}</ul>
          case 'ol':
            return <ol key={k}>{b.items.map((it, j) => <li key={j}>{inline(it, `${k}.${j}`)}</li>)}</ol>
          case 'quote':
            return <blockquote key={k} className="traders-md-quote" data-tone={b.warn ? 'warn' : undefined}>{joined(b.lines, k)}</blockquote>
          case 'table':
            return <Table key={k} b={b} k={k} />
        }
      })}
    </div>
  )
})
