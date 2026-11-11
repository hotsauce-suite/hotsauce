import { extractLinks, type Link, relativeLink, resolveRelative } from '@hearth/format'

interface Edit {
  from: number
  to: number
  text: string
}

/**
 * Rewrites the links in the markdown file at `filePath` that point at `from` (a file, or a folder
 * and anything under it) so they point at the same file after it moved to `to`. Only relative
 * links change, inline (`[t](href)`, `![a](src)`) or in a reference definition, and only their
 * href text; everything else keeps its exact bytes. The moved file's own links are
 * `rewriteLinksForMove`'s job.
 */
export function rewriteLinksToMoved(
  markdown: string,
  filePath: string,
  from: string,
  to: string,
): string {
  const edits = new Map<number, Edit>()
  for (const link of extractLinks(markdown)) {
    if (link.kind !== 'relative') continue
    const { path, suffix } = splitHref(link.href)
    // Root-absolute hrefs are left alone, as rewriteLinksForMove does.
    if (path === '' || path.startsWith('/')) continue
    const target = resolveRelative(filePath, path)
    const moved =
      target === from ? to : target.startsWith(`${from}/`) ? to + target.slice(from.length) : null
    if (moved === null) continue
    const site = hrefSite(markdown, link)
    if (site === null) continue
    const href = relativeLink(filePath, moved) + (path.endsWith('/') ? '/' : '') + suffix
    // Reference links that share a definition share one edit.
    edits.set(site.from, { ...site, text: href })
  }
  if (edits.size === 0) return markdown
  let out = ''
  let cursor = 0
  for (const edit of [...edits.values()].sort((a, b) => a.from - b.from)) {
    out += markdown.slice(cursor, edit.from) + edit.text
    cursor = edit.to
  }
  return out + markdown.slice(cursor)
}

function splitHref(href: string): { path: string; suffix: string } {
  const cut = href.search(/[?#]/)
  return cut === -1
    ? { path: href, suffix: '' }
    : { path: href.slice(0, cut), suffix: href.slice(cut) }
}

/**
 * Where a link's href is written: inside its parentheses, or in its reference definition. Null
 * when the source spells it differently from the parsed href (backslash escapes), which is left
 * alone rather than guessed at.
 */
function hrefSite(markdown: string, link: Link): { from: number; to: number } | null {
  const open = link.from + (markdown[link.from] === '!' ? 1 : 0)
  const close = open + 1 + link.text.length
  if (markdown[open] !== '[' || markdown[close] !== ']') return null
  if (markdown[close + 1] === '(') {
    let i = close + 2
    while (i < link.to && /\s/.test(markdown.charAt(i))) i++
    if (markdown[i] === '<') i++
    return markdown.startsWith(link.href, i) ? { from: i, to: i + link.href.length } : null
  }
  // Reference forms: [text][label], [text][], [text].
  let label = link.text
  if (markdown[close + 1] === '[') {
    const end = markdown.indexOf(']', close + 2)
    if (end > close + 2) label = markdown.slice(close + 2, end)
  }
  return definitionSite(markdown, label, link.href)
}

const DEFINITION = /^[ \t]*(?:>[ \t]*)*\[((?:[^\\[\]]|\\.)+)\]:[ \t]*<?/gm

function definitionSite(
  markdown: string,
  label: string,
  href: string,
): { from: number; to: number } | null {
  const wanted = normalizeLabel(label)
  for (const match of markdown.matchAll(DEFINITION)) {
    if (normalizeLabel(match[1] ?? '') !== wanted) continue
    // The first definition of a label is the one that counts.
    const start = match.index + match[0].length
    return markdown.startsWith(href, start) ? { from: start, to: start + href.length } : null
  }
  return null
}

function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase()
}
