// Papers (docs/PLAN-links-pdfs.md R4, R5): an arXiv, bioRxiv or medRxiv paper's details from the
// site's own API, and its text from arXiv's web version or bioRxiv's JATS full text. The parsing
// is pure; fetching goes through the saved links' safe fetcher.

import {
  MAX_ABSTRACT,
  MAX_AUTHORS,
  MAX_LINK_BODY,
  oneLine,
  type PaperRef,
  paperPageUrl,
  paperPdfUrl,
} from '@hotsauce/format'
import { DOMParser } from 'linkedom'
import { LinkFetchError, type PageFetcher } from './fetch.js'

export interface PaperDetails {
  title: string
  authors: string[]
  abstract: string
  /** YYYY-MM-DD, or ''. */
  published: string
  doi: string
  version: number | null
  /** The paper's own page, versioned. */
  pageUrl: string
  /** Where its PDF is; bioRxiv and medRxiv only answer a browser there. */
  pdfUrl: string
  /** arXiv's web version to read, when it may have one. */
  htmlUrl: string | null
  /** bioRxiv and medRxiv: the full text as JATS XML. */
  jatsUrl: string | null
}

/** The paper's details from its site's API; throws `LinkFetchError` when it can't be found. */
export async function paperDetails(ref: PaperRef, fetch: PageFetcher): Promise<PaperDetails> {
  if (ref.server === 'arxiv') {
    const api = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(ref.id)}`
    const found = parseArxivAtom((await fetch(api, 'data')).text)
    if (!found) throw new LinkFetchError('arXiv doesn’t know that paper')
    const version = ref.version ?? found.version
    const at = { ...ref, version }
    return {
      ...found,
      version,
      pageUrl: paperPageUrl(at),
      pdfUrl: paperPdfUrl(at),
      htmlUrl: `https://arxiv.org/html/${ref.id}${version ? `v${version}` : ''}`,
      jatsUrl: null,
    }
  }
  const api = `https://api.biorxiv.org/details/${ref.server}/${ref.id}`
  const found = parseRxivDetails((await fetch(api, 'data')).text, ref.version)
  if (!found) throw new LinkFetchError(`${label(ref)} doesn’t know that paper`)
  const at = { ...ref, version: found.version }
  return {
    ...found,
    pageUrl: paperPageUrl(at),
    pdfUrl: paperPdfUrl(at),
    htmlUrl: null,
    jatsUrl: found.jatsUrl,
  }
}

function label(ref: PaperRef): string {
  return ref.server === 'biorxiv' ? 'bioRxiv' : 'medRxiv'
}

type Found = Pick<PaperDetails, 'title' | 'authors' | 'abstract' | 'published' | 'doi' | 'version'>

function parseXml(xml: string): Document | null {
  try {
    // linkedom never loads external entities or DTDs.
    return new DOMParser().parseFromString(xml, 'text/xml') as unknown as Document
  } catch {
    return null
  }
}

/** An element's name without its namespace prefix (`mml:math` → `math`). */
function local(el: Element): string {
  return (el.localName || el.tagName).toLowerCase().split(':').pop() ?? ''
}

/** Elements by local name, whatever their namespace prefix (`arxiv:doi`, `doi`). */
function byName(root: ParentNode, name: string): Element[] {
  return Array.from(root.querySelectorAll('*')).filter((e) => local(e) === name)
}

/** The arXiv API's Atom answer: the first entry's details, or null when there is none. */
export function parseArxivAtom(xml: string): Found | null {
  const doc = parseXml(xml)
  const entry = doc ? byName(doc, 'entry')[0] : undefined
  if (!entry) return null
  const text = (name: string) => oneLine(byName(entry, name)[0]?.textContent ?? '')
  const id = text('id')
  const title = text('title')
  // An unknown id comes back as an entry titled "Error".
  if (!title || /\/api\/errors/.test(id) || title === 'Error') return null
  const version = /v(\d+)$/.exec(id)?.[1]
  return {
    title: title.slice(0, 300),
    authors: byName(entry, 'author')
      .map((a) => oneLine(byName(a, 'name')[0]?.textContent ?? ''))
      .filter(Boolean)
      .slice(0, MAX_AUTHORS),
    abstract: text('summary').slice(0, MAX_ABSTRACT),
    published: text('published').slice(0, 10),
    doi: text('doi') || `10.48550/arXiv.${id.replace(/^.*\/abs\//, '').replace(/v\d+$/, '')}`,
    version: version ? Number(version) : null,
  }
}

/** api.biorxiv.org's details answer: the version asked for, else the newest. */
export function parseRxivDetails(
  json: string,
  version: number | null,
): (Found & { jatsUrl: string | null }) | null {
  let data: { collection?: unknown }
  try {
    data = JSON.parse(json) as { collection?: unknown }
  } catch {
    return null
  }
  const rows = Array.isArray(data.collection)
    ? (data.collection as Array<Record<string, unknown>>)
    : []
  if (rows.length === 0) return null
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  const row =
    (version !== null ? rows.find((r) => Number(r.version) === version) : undefined) ??
    rows.reduce((a, b) => (Number(b.version) > Number(a.version) ? b : a))
  const jats = str(row.jatsxml)
  return {
    title: oneLine(str(row.title)).slice(0, 300),
    authors: str(row.authors)
      .split(';')
      .map((a) => oneLine(a))
      .filter(Boolean)
      .map(flipName)
      .slice(0, MAX_AUTHORS),
    abstract: oneLine(str(row.abstract)).slice(0, MAX_ABSTRACT),
    published: /^\d{4}-\d{2}-\d{2}$/.test(str(row.date)) ? str(row.date) : '',
    doi: str(row.doi),
    version: Number.isInteger(Number(row.version)) ? Number(row.version) : null,
    // Only the site's own address; anything else in the answer is ignored.
    jatsUrl: /^https:\/\/www\.(bio|med)rxiv\.org\//.test(jats) ? jats : null,
  }
}

/** "Gordon, D. E." → "D. E. Gordon". */
function flipName(name: string): string {
  const m = /^([^,]+),\s*(.+)$/.exec(name)
  return m?.[1] && m[2] ? `${m[2]} ${m[1]}` : name
}

/**
 * A JATS article's body as Markdown (pure): section titles as headings, paragraphs, lists, and
 * figure and table captions as text. The front matter (the abstract is shown separately) and the
 * references are left out.
 */
export function jatsToMarkdown(xml: string): string {
  const doc = parseXml(xml)
  const body = doc ? byName(doc, 'body')[0] : undefined
  if (!body) return ''
  const blocks: string[] = []
  const walk = (el: Element, depth: number) => {
    for (const child of Array.from(el.children)) {
      const name = local(child)
      if (name === 'sec' || name === 'app' || name === 'boxed-text') {
        const title = Array.from(child.children).find((c) => local(c) === 'title')
        const heading = title ? inline(title) : ''
        if (heading) blocks.push(`${'#'.repeat(Math.min(depth + 2, 4))} ${heading}`)
        walk(child, depth + 1)
      } else if (name === 'p') {
        const text = inline(child)
        if (text) blocks.push(escapeStart(text))
      } else if (name === 'list') {
        const ordered = child.getAttribute('list-type') === 'order'
        const items = Array.from(child.children)
          .filter((c) => local(c) === 'list-item')
          .map((c, i) => `${ordered ? `${i + 1}.` : '-'} ${inline(c)}`)
          .filter((line) => line.trim().length > 2)
        if (items.length > 0) blocks.push(items.join('\n'))
      } else if (name === 'fig' || name === 'table-wrap') {
        const labelEl = Array.from(child.children).find((c) => local(c) === 'label')
        const caption = Array.from(child.children).find((c) => local(c) === 'caption')
        const text = [labelEl ? inline(labelEl) : '', caption ? inline(caption) : '']
          .filter(Boolean)
          .join(' ')
        if (text) blocks.push(`*${text}*`)
      } else if (name === 'disp-quote') {
        const text = inline(child)
        if (text) blocks.push(`> ${text}`)
      } else if (name !== 'title' && name !== 'label' && name !== 'ref-list') {
        walk(child, depth)
      }
    }
  }
  walk(body, 0)
  let out = ''
  for (const block of blocks) {
    const next = out ? `${out}\n\n${block}` : block
    if (next.length > MAX_LINK_BODY) break
    out = next
  }
  return out
}

/** An element's words on one line, Markdown's own characters escaped; formulas left out. */
function inline(el: Element): string {
  const parts: string[] = []
  const visit = (node: Node) => {
    if (node.nodeType === 3) {
      parts.push(node.textContent ?? '')
      return
    }
    if (node.nodeType !== 1) return
    const name = local(node as Element)
    // Formulas come as MathML, which reads as noise in plain text.
    if (name === 'math' || name === 'tex-math' || name === 'alternatives') return
    for (const child of Array.from(node.childNodes)) visit(child)
  }
  for (const child of Array.from(el.childNodes)) visit(child)
  return oneLine(parts.join('')).replace(/([\\`*_[\]<>|~])/g, '\\$1')
}

function escapeStart(text: string): string {
  return text.replace(/^(\d+)([.)]\s)/, '$1\\$2').replace(/^(#{1,6}\s|[-+*]\s|={3,}|-{3,})/, '\\$1')
}
