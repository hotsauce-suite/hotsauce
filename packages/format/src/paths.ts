import { atxHeading, scanLines } from './blocks.js'
import { findFrontmatter, parseFrontmatter, patchFrontmatter } from './frontmatter.js'
import { newId } from './ids.js'
import { SPACE_LAYOUT } from './space.js'

const SLUG_MAX = 80

// Latin letters that NFKD doesn't split into a base letter plus a diacritic.
const LETTERS: Record<string, string> = {
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  ø: 'o',
  đ: 'd',
  ð: 'd',
  ł: 'l',
  þ: 'th',
  ı: 'i',
}

/** Lowercase `a-z0-9` words joined by single hyphens, at most 80 characters, never empty. */
export function slugify(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[ßæœøđðłþı]/g, (c) => LETTERS[c] ?? c)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/, '')
  return slug || 'untitled'
}

/** Frontmatter `title` if it's a non-empty string, else the first `# H1` outside code, else null. */
export function extractTitle(text: string): string | null {
  const { data } = parseFrontmatter(text)
  if (typeof data.title === 'string' && data.title.trim() !== '') return data.title.trim()
  for (const line of scanLines(text, findFrontmatter(text)?.bodyFrom ?? 0)) {
    if (line.code) continue
    const heading = atxHeading(line.text)
    if (heading?.level === 1 && heading.title !== '') return heading.title
  }
  return null
}

/** `docs/<folder>/<slug>.md`; `folder` is relative to `docs/` and may be empty. */
export function docPath(folder: string, title: string): string {
  return [SPACE_LAYOUT.docs, ...folder.split('/').filter(Boolean), `${slugify(title)}.md`].join('/')
}

/** A new document at the top of `docs/`, in the style Hearth generates. */
export function newDoc(title: string): { path: string; text: string } {
  const name = title.replace(/\s+/g, ' ').trim() || 'Untitled'
  const created = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const text = patchFrontmatter(`\n# ${name}\n\n`, { id: newId(), title: name, created })
  return { path: docPath('', name), text }
}

/**
 * The repo path a relative href points to, from the file at `fromPath`. Drops `?query` and
 * `#fragment`, decodes percent-escapes, and treats a leading `/` as the repo root. A path that
 * climbs above the root keeps its leading `..` segments. Not meant for external or hearth:// hrefs.
 */
export function resolveRelative(fromPath: string, href: string): string {
  const { path } = splitHref(href)
  if (path === '') return normalize(fromPath.split('/'))
  const decoded = safeDecode(path)
  const base = decoded.startsWith('/') ? [] : fromPath.split('/').slice(0, -1)
  return normalize([...base, ...decoded.split('/')])
}

/** The relative href from the file at `fromPath` to the repo path `toPath`, percent-encoded where markdown needs it. */
export function relativeLink(fromPath: string, toPath: string): string {
  const fromDir = normalize(fromPath.split('/')).split('/').slice(0, -1)
  const to = normalize(toPath.split('/')).split('/')
  let common = 0
  while (common < fromDir.length && common < to.length - 1 && fromDir[common] === to[common]) {
    common++
  }
  const segments = [...Array<string>(fromDir.length - common).fill('..'), ...to.slice(common)]
  const href = segments.map(encodeSegment).join('/')
  // `a:b.md` would read as a URL with scheme `a`.
  return segments[0]?.includes(':') ? `./${href}` : href
}

/** Splits an href into its path and its `?query#fragment` suffix. */
export function splitHref(href: string): { path: string; suffix: string } {
  const cut = href.search(/[?#]/)
  return cut === -1
    ? { path: href, suffix: '' }
    : { path: href.slice(0, cut), suffix: href.slice(cut) }
}

function normalize(segments: string[]): string {
  const out: string[] = []
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue
    if (segment === '..' && out.length > 0 && out[out.length - 1] !== '..') out.pop()
    else out.push(segment)
  }
  return out.join('/')
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

// Only what would break or change the meaning of a markdown link destination; everything else,
// including non-ASCII letters, stays readable.
function encodeSegment(segment: string): string {
  return segment.replace(/[\s%()<>#?\\]/g, (c) => {
    if (c === '(') return '%28'
    if (c === ')') return '%29'
    return encodeURIComponent(c)
  })
}
