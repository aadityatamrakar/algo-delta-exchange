/**
 * A scanner, not a DOM: a real SPAN file is tens of MB, and building a tree of it
 * would cost more than the numbers read out of it. Elements only — attributes,
 * comments, `<?…?>` and `<!…>` are skipped. Text is reported on close, trimmed
 * and entity-decoded, and is the element's own text (not its children's).
 */
export class SpanParseError extends Error {}

export interface XmlHandler {
  open(name: string, at: number): void
  close(name: string, text: string, end: number): void
}

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decode(s: string): string {
  return s.includes('&') ? s.replace(/&(amp|lt|gt|quot|apos);/g, (_, e: string) => ENTITIES[e]!) : s
}

/** Index of the `>` that ends the tag starting at `from`, skipping quoted attribute values. */
function tagEnd(xml: string, from: number): number {
  let quote = ''
  for (let i = from; i < xml.length; i++) {
    const c = xml[i]!
    if (quote) { if (c === quote) quote = '' } else if (c === '"' || c === "'") quote = c
    else if (c === '>') return i
  }
  return -1
}

function skipTo(xml: string, token: string, from: number): number {
  const i = xml.indexOf(token, from)
  if (i < 0) throw new SpanParseError(`unterminated '${token}' construct at offset ${from}`)
  return i + token.length
}

export function scanXml(xml: string, h: XmlHandler): void {
  const names: string[] = []
  const texts: string[] = []
  let pos = 0
  while (pos < xml.length) {
    const lt = xml.indexOf('<', pos)
    const stop = lt < 0 ? xml.length : lt
    if (stop > pos && names.length > 0) texts[texts.length - 1] += xml.slice(pos, stop)
    if (lt < 0) break
    if (xml.startsWith('<?', lt)) { pos = skipTo(xml, '?>', lt + 2); continue }
    if (xml.startsWith('<!--', lt)) { pos = skipTo(xml, '-->', lt + 4); continue }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9)
      if (end < 0) throw new SpanParseError(`unterminated CDATA at offset ${lt}`)
      if (names.length > 0) texts[texts.length - 1] += xml.slice(lt + 9, end)
      pos = end + 3
      continue
    }
    if (xml.startsWith('<!', lt)) { pos = skipTo(xml, '>', lt + 2); continue }
    const gt = tagEnd(xml, lt + 1)
    if (gt < 0) throw new SpanParseError(`unterminated tag at offset ${lt}`)
    const end = gt + 1
    if (xml[lt + 1] === '/') {
      const name = xml.slice(lt + 2, gt).trim()
      const top = names.pop()
      if (top !== name) throw new SpanParseError(`unbalanced </${name}> at offset ${lt}` + (top === undefined ? '' : ` (open <${top}>)`))
      h.close(name, decode(texts.pop()!.trim()), end)
    } else {
      const selfClosing = xml[gt - 1] === '/'
      const body = xml.slice(lt + 1, selfClosing ? gt - 1 : gt)
      const m = /^[^\s/]+/.exec(body)
      if (!m) throw new SpanParseError(`empty tag name at offset ${lt}`)
      const name = m[0]
      h.open(name, lt)
      if (selfClosing) h.close(name, '', end)
      else { names.push(name); texts.push('') }
    }
    pos = end
  }
  if (names.length > 0) throw new SpanParseError(`unclosed <${names[names.length - 1]}> at end of input`)
}
