import {
  Document,
  isCollection,
  isMap,
  isNode,
  isScalar,
  isSeq,
  Pair,
  parseDocument,
  Scalar,
  YAMLMap,
} from 'yaml'
import { newId } from './ids.js'

export interface Parsed {
  data: Record<string, unknown>
  /** The text between the `---` lines exactly as written, or null when the file has none. */
  yamlText: string | null
  body: string
}

/** The file has frontmatter, but it can't be patched without rewriting text Hearth didn't write. */
export class FrontmatterError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FrontmatterError'
  }
}

interface Block {
  yamlFrom: number
  yamlTo: number
  bodyFrom: number
  eol: string
}

const DELIMITER = /^---[ \t]*\r?$/

/** Locates a frontmatter block: a `---` first line (after an optional BOM) and the next `---` line. */
export function findFrontmatter(text: string): Block | null {
  const start = bomLength(text)
  const firstNl = text.indexOf('\n', start)
  if (firstNl === -1 || !DELIMITER.test(text.slice(start, firstNl))) return null
  const eol = text[firstNl - 1] === '\r' ? '\r\n' : '\n'
  const yamlFrom = firstNl + 1
  let pos = yamlFrom
  while (pos < text.length) {
    const nl = text.indexOf('\n', pos)
    const end = nl === -1 ? text.length : nl
    if (DELIMITER.test(text.slice(pos, end))) {
      return { yamlFrom, yamlTo: pos, bodyFrom: nl === -1 ? text.length : nl + 1, eol }
    }
    pos = end + 1
  }
  return null
}

/** Never throws on bad YAML: invalid or non-mapping frontmatter parses as `data: {}`. */
export function parseFrontmatter(text: string): Parsed {
  const block = findFrontmatter(text)
  if (!block) return { data: {}, yamlText: null, body: text.slice(bomLength(text)) }
  const yamlText = text.slice(block.yamlFrom, block.yamlTo)
  const doc = parseDocument(yamlText)
  const valid = doc.errors.length === 0 && isMap(doc.contents)
  return {
    data: valid ? (doc.toJS() as Record<string, unknown>) : {},
    yamlText,
    body: text.slice(block.bodyFrom),
  }
}

/**
 * Sets (or, with `undefined`, deletes) top-level frontmatter keys by editing only those keys'
 * lines. Everything else, including comments, quoting, key order, line endings, and the body,
 * keeps its exact text. A patch that changes nothing returns `text` unchanged.
 *
 * Throws FrontmatterError when existing frontmatter is invalid YAML, not a mapping, or a flow
 * mapping (`{ a: 1 }`), since patching those would mean rewriting the whole block.
 */
export function patchFrontmatter(text: string, patch: Record<string, unknown | undefined>): string {
  const block = findFrontmatter(text)
  if (!block) {
    const added = Object.entries(patch).filter(([, value]) => value !== undefined)
    if (added.length === 0) return text
    const bom = bomLength(text)
    const eol = detectEol(text)
    const yaml = serializePairs(added, { indent: '', eol, seqIndented: true })
    return `${text.slice(0, bom)}---${eol}${yaml}---${eol}${text.slice(bom)}`
  }
  const yamlText = text.slice(block.yamlFrom, block.yamlTo)
  const next = patchYaml(yamlText, patch, block.eol)
  if (next === yamlText) return text
  return text.slice(0, block.yamlFrom) + next + text.slice(block.yamlTo)
}

/** Adds a ULID `id` unless the frontmatter already has a non-empty string `id`. */
export function ensureId(text: string): { text: string; id: string; added: boolean } {
  const { data } = parseFrontmatter(text)
  if (typeof data.id === 'string' && data.id !== '') return { text, id: data.id, added: false }
  const id = newId()
  return { text: patchFrontmatter(text, { id }), id, added: true }
}

interface Edit {
  from: number
  to: number
  text: string
}

function patchYaml(yaml: string, patch: Record<string, unknown>, eol: string): string {
  const doc = parseDocument(yaml)
  const [error] = doc.errors
  if (error) throw new FrontmatterError(`Frontmatter is not valid YAML: ${error.message}`)
  const contents = doc.contents
  if (contents !== null && !isMap(contents)) {
    throw new FrontmatterError('Frontmatter is not a YAML mapping')
  }
  if (contents?.flow) {
    throw new FrontmatterError('Flow-style frontmatter cannot be patched in place')
  }

  const items = contents?.items ?? []
  const data = (doc.toJS() ?? {}) as Record<string, unknown>
  const edits: Edit[] = []
  const added: Array<[string, unknown]> = []

  for (const [key, value] of Object.entries(patch)) {
    const pair = items.find((p) => isScalar(p.key) && String(p.key.value) === key)
    if (!pair || !isScalar(pair.key)) {
      if (value !== undefined) added.push([key, value])
      continue
    }
    if (value !== undefined && sameValue(data[key], value)) continue
    const keyStart = pair.key.range?.[0] ?? 0
    const span = pairSpan(yaml, pair.key, pair.value)
    const replacement =
      value === undefined
        ? ''
        : serializeReplacement(pair.key, value, pair.value, {
            indent: yaml.slice(span.from, keyStart),
            eol,
            seqIndented: seqIndented(yaml, keyStart, pair.value),
          })
    edits.push({ from: span.from, to: span.to, text: replacement })
  }

  if (edits.length === 0 && added.length === 0) return yaml

  edits.sort((a, b) => a.from - b.from)
  let out = ''
  let cursor = 0
  for (const edit of edits) {
    out += yaml.slice(cursor, edit.from) + edit.text
    cursor = edit.to
  }
  out += yaml.slice(cursor)
  if (added.length > 0) {
    const first = items[0]?.key
    const firstStart = isNode(first) ? (first.range?.[0] ?? 0) : 0
    const indent = first ? yaml.slice(lineStart(yaml, firstStart), firstStart) : ''
    out += serializePairs(added, { indent, eol, seqIndented: true })
  }
  return out
}

/** The whole lines a top-level pair occupies, from its key line through its value's last line. */
function pairSpan(yaml: string, key: Scalar, value: unknown): { from: number; to: number } {
  const keyStart = key.range?.[0] ?? 0
  const keyEnd = key.range?.[1] ?? keyStart
  // range[1] is where the value itself ends; comment lines after it belong to whatever follows.
  const valueEnd = isNode(value) ? (value.range?.[1] ?? keyEnd) : keyEnd
  const last = Math.max(keyEnd, valueEnd) - 1
  const nl = yaml.indexOf('\n', last)
  return { from: lineStart(yaml, keyStart), to: nl === -1 ? yaml.length : nl + 1 }
}

interface Style {
  indent: string
  eol: string
  seqIndented: boolean
}

function serializeReplacement(key: Scalar, value: unknown, old: unknown, style: Style): string {
  const doc = new Document()
  const node = doc.createNode(value)
  // Keep the look of the value being replaced: its quotes, inline comment, and flow style.
  if (isScalar(old) && isScalar(node)) {
    if (
      typeof node.value === 'string' &&
      (old.type === 'QUOTE_DOUBLE' || old.type === 'QUOTE_SINGLE')
    ) {
      node.type = old.type
    }
    if (old.comment) node.comment = old.comment
  }
  if (isCollection(old) && isCollection(node) && old.flow) node.flow = true
  const keyNode = new Scalar(key.value)
  if (key.type) keyNode.type = key.type
  return render(doc, [new Pair(keyNode, node)], style)
}

function serializePairs(entries: Array<[string, unknown]>, style: Style): string {
  const doc = new Document()
  return render(
    doc,
    entries.map(([key, value]) => new Pair(new Scalar(key), doc.createNode(value))),
    style,
  )
}

function render(doc: Document, pairs: Pair[], style: Style): string {
  const map = new YAMLMap()
  map.items.push(...pairs)
  doc.contents = map
  let out = doc.toString({
    lineWidth: 0,
    flowCollectionPadding: false,
    indentSeq: style.seqIndented,
  })
  if (style.indent) out = out.replace(/^(?=.)/gm, style.indent)
  return style.eol === '\n' ? out : out.replace(/\n/g, style.eol)
}

/** Whether a block sequence value is indented under its key (`  - a`) or flush with it (`- a`). */
function seqIndented(yaml: string, keyStart: number, value: unknown): boolean {
  if (!isSeq(value) || value.flow) return true
  const seqStart = value.range?.[0] ?? 0
  return seqStart - lineStart(yaml, seqStart) > keyStart - lineStart(yaml, keyStart)
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => sameValue(x, b[i]))
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a)
    return (
      keys.length === Object.keys(b).length &&
      keys.every((k) => Object.hasOwn(b, k) && sameValue(a[k], b[k]))
    )
  }
  return false
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

function lineStart(text: string, pos: number): number {
  return text.lastIndexOf('\n', pos - 1) + 1
}

function bomLength(text: string): number {
  return text.startsWith('﻿') ? 1 : 0
}

function detectEol(text: string): string {
  const nl = text.indexOf('\n')
  return nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n'
}
