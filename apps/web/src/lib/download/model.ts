// A Doc's Markdown as a small tree both writers read (docs/PLAN-doc-download.md). Parsing once
// here keeps the Word and PDF files in step: each writer only decides how a block looks.

import { parseFrontmatter } from '@hotsauce/format'
import type {
  BlockContent,
  DefinitionContent,
  List,
  ListItem,
  PhrasingContent,
  Root,
  RootContent,
  TableCell,
} from 'mdast'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { remarkCallouts } from '../remarkCallouts'

export interface TextRun {
  t: 'text'
  text: string
  bold?: boolean
  italic?: boolean
  strike?: boolean
  code?: boolean
  href?: string
}
export type Inline = TextRun | { t: 'image'; src: string; alt: string } | { t: 'break' }

export interface ListEntry {
  /** null: not a task item. */
  checked: boolean | null
  blocks: Block[]
}

export type Align = 'left' | 'center' | 'right' | null

export type Block =
  | { t: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; inlines: Inline[] }
  | { t: 'para'; inlines: Inline[] }
  | { t: 'list'; ordered: boolean; start: number; items: ListEntry[] }
  | { t: 'quote'; blocks: Block[] }
  | { t: 'code'; text: string }
  | { t: 'table'; align: Align[]; rows: Inline[][][] }
  | { t: 'rule' }
  /** A live `tasks` block: its query, filled in at download time. */
  | { t: 'tasks'; source: string }

export interface DocModel {
  title: string
  blocks: Block[]
}

type Marks = Omit<TextRun, 't' | 'text'>

/** Links as the doc writes them, made absolute (a doc link points at the doc in Hotsauce). */
export type LinkResolver = (href: string) => string

function inlines(nodes: PhrasingContent[], marks: Marks, link: LinkResolver): Inline[] {
  const out: Inline[] = []
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        // A soft line break in the Markdown is a space; hard breaks are their own nodes.
        out.push({ t: 'text', text: node.value.replace(/\s*\n\s*/g, ' '), ...marks })
        break
      case 'strong':
        out.push(...inlines(node.children, { ...marks, bold: true }, link))
        break
      case 'emphasis':
        out.push(...inlines(node.children, { ...marks, italic: true }, link))
        break
      case 'delete':
        out.push(...inlines(node.children, { ...marks, strike: true }, link))
        break
      case 'inlineCode':
        out.push({ t: 'text', text: node.value, ...marks, code: true })
        break
      case 'link':
        out.push(...inlines(node.children, { ...marks, href: link(node.url) }, link))
        break
      case 'image':
        out.push({ t: 'image', src: node.url, alt: node.alt ?? '' })
        break
      case 'break':
        out.push({ t: 'break' })
        break
      case 'imageReference':
        // `![alt][ref]`: the alt text stands in (definitions aren't followed).
        if (node.alt) out.push({ t: 'text', text: `[${node.alt}]`, ...marks, italic: true })
        break
      case 'html':
        // Raw HTML isn't rendered by the reading view either; keep its text out.
        break
      default:
        if ('children' in node)
          out.push(...inlines(node.children as PhrasingContent[], marks, link))
        else if ('value' in node) out.push({ t: 'text', text: String(node.value), ...marks })
    }
  }
  return out
}

function listItem(item: ListItem, link: LinkResolver): ListEntry {
  return {
    checked: typeof item.checked === 'boolean' ? item.checked : null,
    blocks: blocks(item.children, link),
  }
}

function list(node: List, link: LinkResolver): Block {
  return {
    t: 'list',
    ordered: node.ordered === true,
    start: node.start ?? 1,
    items: node.children.map((item) => listItem(item, link)),
  }
}

function cell(node: TableCell, link: LinkResolver): Inline[] {
  return inlines(node.children, {}, link)
}

function blocks(
  nodes: (RootContent | BlockContent | DefinitionContent)[],
  link: LinkResolver,
): Block[] {
  const out: Block[] = []
  for (const node of nodes) {
    switch (node.type) {
      case 'heading':
        out.push({ t: 'heading', level: node.depth, inlines: inlines(node.children, {}, link) })
        break
      case 'paragraph':
        out.push({ t: 'para', inlines: inlines(node.children, {}, link) })
        break
      case 'list':
        out.push(list(node, link))
        break
      case 'blockquote':
        out.push({ t: 'quote', blocks: blocks(node.children, link) })
        break
      case 'code':
        if (node.lang === 'tasks') out.push({ t: 'tasks', source: node.value })
        else out.push({ t: 'code', text: node.value })
        break
      case 'table':
        out.push({
          t: 'table',
          align: node.align ?? [],
          rows: node.children.map((row) => row.children.map((c) => cell(c, link))),
        })
        break
      case 'thematicBreak':
        out.push({ t: 'rule' })
        break
      default:
        break
    }
  }
  return out
}

/** Plain text of some inlines (a heading's words, a table cell's text). */
export function plainText(runs: Inline[]): string {
  return runs.map((r) => (r.t === 'text' ? r.text : r.t === 'break' ? ' ' : r.alt)).join('')
}

/** Every image a doc shows, in order, so they can be fetched before a writer runs. */
export function imageSources(model: DocModel): string[] {
  const found = new Set<string>()
  const fromInlines = (runs: Inline[]) => {
    for (const r of runs) if (r.t === 'image') found.add(r.src)
  }
  const walk = (list: Block[]) => {
    for (const b of list) {
      if (b.t === 'heading' || b.t === 'para') fromInlines(b.inlines)
      else if (b.t === 'quote') walk(b.blocks)
      else if (b.t === 'list') for (const i of b.items) walk(i.blocks)
      else if (b.t === 'table') for (const row of b.rows) for (const c of row) fromInlines(c)
    }
  }
  walk(model.blocks)
  return [...found]
}

/** Every `tasks` block's query. */
export function taskSources(model: DocModel): string[] {
  const found = new Set<string>()
  const walk = (list: Block[]) => {
    for (const b of list) {
      if (b.t === 'tasks') found.add(b.source)
      else if (b.t === 'quote') walk(b.blocks)
      else if (b.t === 'list') for (const i of b.items) walk(i.blocks)
    }
  }
  walk(model.blocks)
  return [...found]
}

/** The doc's text without its frontmatter, as a tree. `title` names the file. */
export function docModel(markdown: string, title: string, link: LinkResolver): DocModel {
  const body = parseFrontmatter(markdown).body
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkCallouts, { asQuote: true })
  const tree = processor.runSync(processor.parse(body)) as Root
  return { title, blocks: blocks(tree.children, link) }
}
