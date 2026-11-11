import { atxHeading, scanLines } from './blocks.js'
import { findFrontmatter } from './frontmatter.js'

export interface Chunk {
  /** Heading path, e.g. `Q4 plan > Goals > Revenue`; null before the first heading. */
  heading: string | null
  /** Always `source.slice(from, to)`, trimmed of surrounding whitespace. */
  text: string
  from: number
  to: number
}

const DEFAULT_MAX_CHARS = 2000

/**
 * Splits markdown for search: one section per heading (headings inside fenced code don't count),
 * then sections longer than `maxChars` are cut at the last paragraph break, line break, or space
 * that fits. Frontmatter is skipped.
 */
export function chunkMarkdown(text: string, maxChars = DEFAULT_MAX_CHARS): Chunk[] {
  if (!(maxChars >= 1)) throw new RangeError(`maxChars must be at least 1, got ${maxChars}`)
  const sections: Array<{ heading: string | null; from: number; to: number }> = []
  const path: Array<{ level: number; title: string }> = []
  let current: { heading: string | null; from: number } = {
    heading: null,
    from: findFrontmatter(text)?.bodyFrom ?? 0,
  }
  for (const line of scanLines(text, current.from)) {
    const heading = line.code ? null : atxHeading(line.text)
    if (!heading) continue
    sections.push({ ...current, to: line.from })
    while ((path.at(-1)?.level ?? 0) >= heading.level) path.pop()
    path.push(heading)
    const titles = path.map((h) => h.title).filter(Boolean)
    current = { heading: titles.length > 0 ? titles.join(' > ') : null, from: line.from }
  }
  sections.push({ ...current, to: text.length })

  const chunks: Chunk[] = []
  for (const section of sections) {
    let from = section.from
    while (from < section.to) {
      const to = section.to - from > maxChars ? cutPoint(text, from, from + maxChars) : section.to
      const piece = trimmed(text, from, to)
      if (piece) chunks.push({ heading: section.heading, ...piece })
      from = to
    }
  }
  return chunks
}

function cutPoint(text: string, from: number, limit: number): number {
  const window = text.slice(from, limit)
  let paragraph = -1
  for (const m of window.matchAll(/\n[ \t]*\r?\n/g)) paragraph = m.index + m[0].length
  if (paragraph > 0) return from + paragraph
  const line = window.lastIndexOf('\n')
  if (line > 0) return from + line + 1
  const space = window.search(/\s\S*$/)
  if (space > 0) return from + space + 1
  // Don't split a surrogate pair.
  const code = text.charCodeAt(limit - 1)
  return code >= 0xd800 && code <= 0xdbff && limit - 1 > from ? limit - 1 : limit
}

function trimmed(
  text: string,
  from: number,
  to: number,
): { text: string; from: number; to: number } | null {
  let start = from
  let end = to
  while (start < end && /\s/.test(text.charAt(start))) start++
  while (end > start && /\s/.test(text.charAt(end - 1))) end--
  return start < end ? { text: text.slice(start, end), from: start, to: end } : null
}
