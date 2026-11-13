// A saved link's readable copy (ARCHITECTURE §23.2): Mozilla Readability picks the article out of
// the page, Turndown writes it as Markdown. Words, headings, lists, quotes, code, tables and
// links; pictures become links to the original.

import { MAX_LINK_BODY, oneLine, siteOf, wordCount } from '@hearth/format'
import { gfm } from '@joplin/turndown-plugin-gfm'
import { Readability } from '@mozilla/readability'
import { parseHTML } from 'linkedom'
import TurndownService from 'turndown'

export interface ReadablePage {
  title: string
  site: string
  description: string
  markdown: string
  words: number
}

/** Readability gives up (an empty copy) on pages with more elements than this. */
const MAX_ELEMENTS = 30_000
const MAX_TITLE = 300
const MAX_DESCRIPTION = 600

/** The readable copy of a fetched page. Never throws: a page it can't read gives an empty copy. */
export function readPage(text: string, url: string, contentType: string): ReadablePage {
  if (contentType === 'text/plain') {
    const markdown = text.replace(/\r\n?/g, '\n').trim().slice(0, MAX_LINK_BODY)
    return { title: '', site: siteOf(url), description: '', markdown, words: wordCount(markdown) }
  }
  try {
    return readHtml(text, url)
  } catch {
    return { title: '', site: siteOf(url), description: '', markdown: '', words: 0 }
  }
}

function readHtml(text: string, url: string): ReadablePage {
  const { document } = parseHTML(text) as unknown as { document: Document }
  const meta = (names: string[]): string => {
    for (const name of names) {
      const el = document.querySelector(`meta[property="${name}"], meta[name="${name}"]`)
      const content = el?.getAttribute('content')
      if (content?.trim()) return oneLine(content)
    }
    return ''
  }
  const metaTitle =
    meta(['og:title', 'twitter:title']) ||
    oneLine(document.querySelector('title')?.textContent ?? '')
  const site = meta(['og:site_name', 'application-name']) || siteOf(url)
  const description = meta(['og:description', 'twitter:description', 'description'])

  let article: ReturnType<Readability<string>['parse']> = null
  try {
    article = new Readability(document, {
      charThreshold: 200,
      maxElemsToParse: MAX_ELEMENTS,
    }).parse()
  } catch {
    article = null
  }
  const markdown = article?.content ? toMarkdown(article.content, url) : ''
  return {
    title: (metaTitle || oneLine(article?.title ?? '')).slice(0, MAX_TITLE),
    site: site.slice(0, MAX_TITLE),
    description: (description || oneLine(article?.excerpt ?? '')).slice(0, MAX_DESCRIPTION),
    markdown,
    words: wordCount(markdown),
  }
}

function absolute(href: string, base: string): string | null {
  try {
    const url = new URL(href, base)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

/** Article HTML as Markdown, links made absolute, pictures as links, capped. */
export function toMarkdown(html: string, base: string): string {
  const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*',
    hr: '---',
  })
  turndown.use(gfm)
  turndown.remove([
    'script',
    'style',
    'noscript',
    'iframe',
    'form',
    'button',
    'input',
    'select',
    'textarea',
    'svg',
    'canvas',
    'video',
    'audio',
    'object',
    'embed',
  ] as unknown as TurndownService.Filter)
  // One space after a list marker ("- item", "1. item"), not Turndown's padded "-   item".
  // Each list's item positions are worked out once: indexOf per item is quadratic on long lists.
  const positions = new WeakMap<Node, Map<Node, number>>()
  const positionOf = (parent: HTMLElement, node: Node): number => {
    let map = positions.get(parent)
    if (!map) {
      map = new Map()
      let i = 0
      for (const child of Array.from(parent.children)) map.set(child, i++)
      positions.set(parent, map)
    }
    return map.get(node) ?? 0
  }
  turndown.addRule('listItem', {
    filter: 'li',
    replacement: (content, node) => {
      const parent = node.parentNode as HTMLElement | null
      let prefix = '- '
      if (parent?.nodeName === 'OL') {
        const start = Number(parent.getAttribute('start') ?? 1)
        prefix = `${start + positionOf(parent, node)}. `
      }
      const indent = ' '.repeat(prefix.length)
      const body = content
        .replace(/^\n+/, '')
        .replace(/\n+$/, '\n')
        .replace(/\n(?!$)/g, `\n${indent}`)
      return `${prefix}${body}${node.nextSibling && !body.endsWith('\n') ? '\n' : ''}`
    },
  })
  turndown.addRule('picture', {
    filter: 'img',
    replacement: (_content, node) => {
      const el = node as HTMLElement
      const src = absolute(el.getAttribute('src') ?? '', base)
      if (!src) return ''
      const alt = oneLine(el.getAttribute('alt') ?? '').replace(/[[\]]/g, '')
      return `[Picture${alt ? `: ${alt}` : ''}](${src})`
    },
  })
  turndown.addRule('link', {
    filter: (node) => node.nodeName === 'A' && !!(node as HTMLElement).getAttribute('href'),
    replacement: (content, node) => {
      const href = absolute((node as HTMLElement).getAttribute('href') ?? '', base)
      const text = content.trim()
      if (!href || !text) return content
      // A link on the page itself (#section) isn't useful in a copy.
      if (href.split('#')[0] === base.split('#')[0]) return content
      return `[${text}](${href.replace(/\(/g, '%28').replace(/\)/g, '%29')})`
    },
  })
  return turndown
    .turndown(html)
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_LINK_BODY)
}
