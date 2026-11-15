// A saved link's readable copy (ARCHITECTURE §23.2): Mozilla Readability picks the article out of
// the page, Turndown writes it as Markdown. Words, headings, lists, quotes, code, tables and
// links; pictures become links to the original.

import { MAX_LINK_BODY, oneLine, siteOf, wordCount } from '@hotsauce/format'
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
  revealStreamedParts(document)
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

/**
 * Puts a streamed React page together the way its scripts would in a browser. React sends the
 * slow parts of a page (often the article itself) at the end, in hidden `<div hidden id="S:x">`
 * blocks, with a script that moves each into its placeholder: a `<template id="B:y">` boundary,
 * whose loading stand-in runs from the `<!--$?-->` before it to the matching `<!--/$-->`
 * (`$RC("B:y","S:x")`), or a `<template id="P:y">` segment (`$RS("S:x","P:y")`). Readability drops
 * hidden blocks, so without this only the page's header is left.
 */
export function revealStreamedParts(document: Document): void {
  // Where each part goes: the page's own calls (React 18 numbers boundaries and parts apart),
  // else the placeholder with the same number (React 19 numbers them alike).
  const named = new Map<string, string>()
  for (const script of Array.from(document.querySelectorAll('script'))) {
    const code = script.textContent ?? ''
    if (!code.includes('$R')) continue
    for (const m of code.matchAll(/\$RC\(\s*["'](B:[^"']+)["']\s*,\s*["'](S:[^"']+)["']/g)) {
      named.set(m[2] as string, m[1] as string)
    }
    for (const m of code.matchAll(/\$RS\(\s*["'](S:[^"']+)["']\s*,\s*["'](P:[^"']+)["']/g)) {
      named.set(m[1] as string, m[2] as string)
    }
  }
  for (const part of Array.from(document.querySelectorAll('div[hidden][id^="S:"]'))) {
    const key = part.id.slice(2)
    const ids = [named.get(part.id) ?? `B:${key}`, `P:${key}`]
    const placeholder = ids
      .map((id) => document.getElementById(id))
      .find((el) => el?.tagName === 'TEMPLATE')
    const parent = placeholder?.parentNode
    // A placeholder inside its own part can't be filled (only a hostile page does that).
    if (!placeholder || !parent || part.contains(parent)) continue
    let before: Node | null = null
    if (placeholder.id.startsWith('B:')) {
      const opener = placeholder.previousSibling
      if (opener?.nodeType !== 8 || (opener as Comment).data !== '$?') continue
      // Take out the stand-in, from the template to its matching "/$" comment.
      let depth = 0
      let node: Node | null = placeholder
      while (node) {
        if (node.nodeType === 8) {
          const data = (node as Comment).data
          if (data === '/$') {
            if (depth === 0) break
            depth--
          } else if (data === '$' || data === '$?' || data === '$!') depth++
        }
        const next: Node | null = node.nextSibling
        parent.removeChild(node)
        node = next
      }
      before = node
      ;(opener as Comment).data = '$'
    } else {
      before = placeholder.nextSibling
      parent.removeChild(placeholder)
    }
    while (part.firstChild) parent.insertBefore(part.firstChild, before)
    part.parentNode?.removeChild(part)
  }
}

/** An address with its parentheses escaped, so it can't end a Markdown link early. */
const parens = (url: string): string => url.replace(/\(/g, '%28').replace(/\)/g, '%29')

/** A picture as `toMarkdown` writes it, with its label in group 1. */
const PICTURE = /\[(Picture[^\]]*)\]\([^)]*\)/g

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
      return `[Picture${alt ? `: ${alt}` : ''}](${parens(src)})`
    },
  })
  turndown.addRule('link', {
    filter: (node) => node.nodeName === 'A' && !!(node as HTMLElement).getAttribute('href'),
    replacement: (content, node) => {
      const href = absolute((node as HTMLElement).getAttribute('href') ?? '', base)
      // A picture inside a link (a logo, a thumbnail) would make a link inside a link, which
      // Markdown can't show: keep the link's words, or the picture's label when it has none.
      const text = content.replace(PICTURE, '').trim() || content.replace(PICTURE, '$1').trim()
      if (!href || !text) return content
      // A link on the page itself (#section) isn't useful in a copy.
      if (href.split('#')[0] === base.split('#')[0]) return content
      return `[${text}](${parens(href)})`
    },
  })
  return turndown
    .turndown(html)
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_LINK_BODY)
}
