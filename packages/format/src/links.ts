import { scanLines } from './blocks.js'
import { findFrontmatter } from './frontmatter.js'
import { relativeLink, resolveRelative, splitHref } from './paths.js'

export interface Link {
  href: string
  /** The link text or image alt text, as written. */
  text: string
  /**
   * The whole link in the source: `[text](href)`, `![alt](src)`, `[text][ref]`, `<url>`, or a
   * bare URL. A reference link's href lives in its definition, outside this range.
   */
  from: number
  to: number
  kind: 'relative' | 'hearth' | 'external'
}

/** Where an href is written in the source: an inline destination or a reference definition. */
interface Site {
  href: string
  from: number
  to: number
}

interface Context {
  definitions: Map<string, Site>
  /** The matching `]` for each `[` in the region being scanned. */
  brackets: Map<number, number>
  links: Link[]
  sites: Site[]
}

/**
 * Links and images in GitHub-flavored markdown, in source order: inline, reference (full,
 * collapsed, shortcut), autolinks, bare URLs, and `hearth://<id>`. Ignores frontmatter, fenced
 * code, and code spans.
 */
export function extractLinks(markdown: string): Link[] {
  return scan(markdown).links
}

/**
 * Rewrites the relative links in a file that moved from `oldPath` to `newPath` so they point at
 * the same targets as before. A link to the file itself follows it to `newPath`. External,
 * hearth://, fragment-only, and root-absolute links are untouched, and so is any link that still
 * resolves correctly from the new location.
 *
 * When the file moved as part of a folder, `folder` is that move: targets under `folder.from`
 * moved too (to `folder.to`), so a link to a sibling that moved with the file keeps its bytes.
 */
export function rewriteLinksForMove(
  markdown: string,
  oldPath: string,
  newPath: string,
  folder?: { from: string; to: string },
): string {
  const edits: Array<Site & { text: string }> = []
  for (const site of scan(markdown).sites) {
    const text = movedHref(site.href, oldPath, newPath, folder)
    if (text !== null) edits.push({ ...site, text })
  }
  if (edits.length === 0) return markdown
  edits.sort((a, b) => a.from - b.from)
  let out = ''
  let cursor = 0
  for (const edit of edits) {
    out += markdown.slice(cursor, edit.from) + edit.text
    cursor = edit.to
  }
  return out + markdown.slice(cursor)
}

function movedHref(
  href: string,
  oldPath: string,
  newPath: string,
  folder: { from: string; to: string } | undefined,
): string | null {
  if (kindOf(href) !== 'relative' || href.startsWith('#') || href.startsWith('/')) return null
  const { path, suffix } = splitHref(href)
  if (path === '') return null
  const before = resolveRelative(oldPath, path)
  if (before === '..' || before.startsWith('../')) return null
  const target =
    before === oldPath
      ? newPath
      : folder && (before === folder.from || before.startsWith(`${folder.from}/`))
        ? folder.to + before.slice(folder.from.length)
        : before
  if (resolveRelative(newPath, path) === target) return null
  const next = relativeLink(newPath, target) + (path.endsWith('/') ? '/' : '')
  return next + suffix
}

function kindOf(href: string): Link['kind'] {
  if (/^hearth:/i.test(href)) return 'hearth'
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return 'external'
  return 'relative'
}

function scan(src: string): { links: Link[]; sites: Site[] } {
  const ctx: Context = { definitions: new Map(), brackets: new Map(), links: [], sites: [] }
  // Paragraph-like runs of lines. Links and code spans never cross a blank line or a fence.
  const regions: Array<{ from: number; to: number }> = []
  let region: { from: number; to: number } | null = null
  for (const line of scanLines(src, findFrontmatter(src)?.bodyFrom ?? 0)) {
    const definition = line.code ? null : definitionAt(line.text, line.from)
    if (definition && !ctx.definitions.has(definition.label)) {
      ctx.definitions.set(definition.label, definition.site)
      if (definition.site.href !== '') ctx.sites.push(definition.site)
    }
    if (line.code || definition || line.text.trim() === '') {
      region = null
    } else if (region) {
      region.to = line.to
    } else {
      region = { from: line.from, to: line.to }
      regions.push(region)
    }
  }
  for (const r of regions) {
    ctx.brackets = matchBrackets(src, r.from, r.to)
    scanInline(src, r.from, r.to, ctx, false)
  }
  ctx.links.sort((a, b) => a.from - b.from)
  return { links: ctx.links, sites: ctx.sites }
}

const DEFINITION =
  /^[ \t]*(?:>[ \t]*)*\[((?:[^\\[\]]|\\.)+)\]:[ \t]*(?:<([^<>\n]*)>|(\S+))(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^()]*\)))?[ \t]*$/d

function definitionAt(text: string, offset: number): { label: string; site: Site } | null {
  const m = DEFINITION.exec(text)
  const label = m?.[1]
  // `[^1]: ...` is a GFM footnote, not a link definition.
  if (!m || !label || label.startsWith('^') || label.trim() === '') return null
  const group = m[2] !== undefined ? 2 : 3
  const [start, end] = m.indices?.[group] ?? [0, 0]
  return {
    label: normalizeLabel(label),
    site: { href: unescapeMarkdown(m[group] ?? ''), from: offset + start, to: offset + end },
  }
}

function scanInline(src: string, from: number, to: number, ctx: Context, imagesOnly: boolean) {
  let i = from
  while (i < to) {
    const c = src.charAt(i)
    if (c === '\\') {
      i += 2
      continue
    }
    if (c === '`') {
      i = skipCodeSpan(src, i, to)
      continue
    }
    if (c === '!' && src[i + 1] === '[') {
      const image = linkAt(src, i + 1, to, ctx)
      if (image) {
        emit(ctx, image.href, src.slice(image.textFrom, image.textTo), i, image.end)
        i = image.end
        continue
      }
    }
    if (!imagesOnly) {
      const found = c === '[' ? linkAt(src, i, to, ctx) : null
      if (found) {
        emit(ctx, found.href, src.slice(found.textFrom, found.textTo), i, found.end)
        // Link text can hold images, but not other links.
        scanInline(src, found.textFrom, found.textTo, ctx, true)
        i = found.end
        continue
      }
      const auto = c === '<' ? autolinkAt(src, i, to) : bareUrlAt(src, i, from, to)
      if (auto) {
        emit(ctx, auto.href, src.slice(auto.textFrom, auto.textTo), i, auto.end)
        i = auto.end
        continue
      }
    }
    i++
  }
}

function emit(ctx: Context, href: string, text: string, from: number, to: number) {
  if (href !== '') ctx.links.push({ href, text, from, to, kind: kindOf(href) })
}

interface Found {
  href: string
  textFrom: number
  textTo: number
  end: number
}

/** A link whose text starts with the `[` at `open`, in inline, full, collapsed, or shortcut form. */
function linkAt(src: string, open: number, to: number, ctx: Context): Found | null {
  const close = ctx.brackets.get(open)
  if (close === undefined || close >= to) return null
  const textFrom = open + 1
  const text = src.slice(textFrom, close)
  if (src[close + 1] === '(') {
    const tail = inlineTail(src, close + 1, to)
    if (tail) {
      const site = {
        href: unescapeMarkdown(src.slice(tail.hrefFrom, tail.hrefTo)),
        from: tail.hrefFrom,
        to: tail.hrefTo,
      }
      if (site.href !== '') ctx.sites.push(site)
      return { href: site.href, textFrom, textTo: close, end: tail.end }
    }
  } else if (src[close + 1] === '[') {
    const labelEnd = src.indexOf(']', close + 2)
    if (labelEnd !== -1 && labelEnd < to) {
      const label = src.slice(close + 2, labelEnd)
      const definition = ctx.definitions.get(normalizeLabel(label === '' ? text : label))
      return definition
        ? { href: definition.href, textFrom, textTo: close, end: labelEnd + 1 }
        : null
    }
  }
  const definition = ctx.definitions.get(normalizeLabel(text))
  return definition ? { href: definition.href, textFrom, textTo: close, end: close + 1 } : null
}

// One pass per region: scanning forward from each `[` instead is quadratic in a paragraph full
// of unmatched brackets.
function matchBrackets(src: string, from: number, to: number): Map<number, number> {
  const matches = new Map<number, number>()
  const open: number[] = []
  for (let i = from; i < to; i++) {
    const c = src[i]
    if (c === '\\') {
      i++
    } else if (c === '`') {
      i = skipCodeSpan(src, i, to) - 1
    } else if (c === '[') {
      open.push(i)
    } else if (c === ']') {
      const start = open.pop()
      if (start !== undefined) matches.set(start, i)
    }
  }
  return matches
}

/** `(dest "title")` starting at the `(`; returns where the destination is and where the link ends. */
function inlineTail(
  src: string,
  paren: number,
  to: number,
): { hrefFrom: number; hrefTo: number; end: number } | null {
  let i = skipSpace(src, paren + 1, to)
  let hrefFrom = i
  let hrefTo: number
  if (src[i] === '<') {
    hrefFrom = i + 1
    let j = hrefFrom
    while (j < to && src[j] !== '>' && src[j] !== '<' && src[j] !== '\n') {
      j += src[j] === '\\' ? 2 : 1
    }
    if (j >= to || src[j] !== '>') return null
    hrefTo = j
    i = j + 1
  } else {
    let depth = 0
    while (i < to) {
      const c = src.charAt(i)
      if (c === '\\') {
        i += 2
        continue
      }
      if (c <= ' ') break
      if (c === '(') depth++
      if (c === ')') {
        if (depth === 0) break
        depth--
      }
      i++
    }
    if (depth !== 0) return null
    hrefTo = Math.min(i, to)
  }
  const afterHref = i
  i = skipSpace(src, i, to)
  const opener = src.charAt(i)
  if (i > afterHref && (opener === '"' || opener === "'" || opener === '(')) {
    const closer = opener === '(' ? ')' : opener
    let j = i + 1
    while (j < to && src[j] !== closer) {
      j += src[j] === '\\' ? 2 : 1
    }
    if (j >= to) return null
    i = skipSpace(src, j + 1, to)
  }
  if (i >= to || src[i] !== ')') return null
  return { hrefFrom, hrefTo, end: i + 1 }
}

/** Index just past the code span opening at `start`, or past the backticks if it never closes. */
function skipCodeSpan(src: string, start: number, to: number): number {
  let open = start
  while (open < to && src[open] === '`') open++
  const length = open - start
  let i = open
  while (i < to) {
    if (src[i] !== '`') {
      i++
      continue
    }
    let run = i
    while (run < to && src[run] === '`') run++
    if (run - i === length) return run
    i = run
  }
  return open
}

function skipSpace(src: string, i: number, to: number): number {
  let j = i
  while (j < to && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n' || src[j] === '\r')) j++
  return j
}

interface Auto {
  href: string
  textFrom: number
  textTo: number
  end: number
}

const URI_AUTOLINK = /<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*)>/y
const EMAIL_AUTOLINK =
  /<([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)>/y

function autolinkAt(src: string, i: number, to: number): Auto | null {
  for (const [pattern, prefix] of [
    [URI_AUTOLINK, ''],
    [EMAIL_AUTOLINK, 'mailto:'],
  ] as const) {
    pattern.lastIndex = i
    const m = pattern.exec(src)
    if (m?.[1] && i + m[0].length <= to) {
      return {
        href: prefix + m[1],
        textFrom: i + 1,
        textTo: i + 1 + m[1].length,
        end: i + m[0].length,
      }
    }
  }
  return null
}

const BARE_URL = /(?:https?:\/\/|hearth:\/\/|www\.)[^\s<]*/iy
const BARE_PREFIX = /^(?:https?:\/\/|hearth:\/\/|www\.)/i

/** A GFM extended autolink (`https://…`, `www.…`), plus bare `hearth://<id>`. */
function bareUrlAt(src: string, i: number, from: number, to: number): Auto | null {
  if (!'hHwW'.includes(src.charAt(i))) return null
  if (i > from && !/[\s*_~(]/.test(src.charAt(i - 1))) return null
  BARE_URL.lastIndex = i
  const m = BARE_URL.exec(src)
  if (!m) return null
  let end = Math.min(i + m[0].length, to)
  // Trailing punctuation ends the sentence, not the URL; so does an unbalanced `)`.
  while (end > i) {
    const c = src.charAt(end - 1)
    const url = src.slice(i, end)
    if ('?!.,:*_~\'"'.includes(c)) end--
    else if (c === ')' && count(url, ')') > count(url, '(')) end--
    else break
  }
  const text = src.slice(i, end)
  if (text.length <= (BARE_PREFIX.exec(text)?.[0].length ?? text.length)) return null
  const href = /^www\./i.test(text) ? `http://${text}` : text
  return { href, textFrom: i, textTo: end, end }
}

function count(s: string, c: string): number {
  return s.split(c).length - 1
}

function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase()
}

function unescapeMarkdown(s: string): string {
  return s.replace(/\\([!-/:-@[-`{-~])/g, '$1')
}
