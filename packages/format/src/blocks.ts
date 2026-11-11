// Line-level markdown scanning shared by titles, links, and chunking. Internal to the package.
//
// Only fenced code is recognized as code. Indented code blocks need list context to detect
// reliably, and treating list continuations as code would hide real content.

export interface Line {
  from: number
  /** End of the line's text, before `\n` or `\r\n`. */
  to: number
  /** Start of the next line. */
  next: number
  text: string
  /** Inside a fenced code block, fence lines included. */
  code: boolean
}

interface Fence {
  char: string
  length: number
}

// Fences may sit inside list items or blockquotes, so any indentation and `>` prefixes are allowed.
const FENCE = /^[ \t]*(?:>[ \t]*)*(`{3,}|~{3,})(.*)$/

function fenceOpen(text: string): Fence | null {
  const m = FENCE.exec(text)
  const marker = m?.[1]
  if (!m || !marker) return null
  // A backtick fence's info string cannot contain backticks (that's inline code).
  if (marker.startsWith('`') && (m[2] ?? '').includes('`')) return null
  return { char: marker.charAt(0), length: marker.length }
}

function closesFence(text: string, fence: Fence): boolean {
  const m = FENCE.exec(text)
  const marker = m?.[1]
  return (
    marker !== undefined &&
    marker.charAt(0) === fence.char &&
    marker.length >= fence.length &&
    (m?.[2] ?? '').trim() === ''
  )
}

export function scanLines(source: string, start = 0): Line[] {
  const lines: Line[] = []
  let fence: Fence | null = null
  let pos = start
  while (pos < source.length) {
    const nl = source.indexOf('\n', pos)
    const next = nl === -1 ? source.length : nl + 1
    let to = nl === -1 ? source.length : nl
    if (to > pos && source[to - 1] === '\r') to--
    const text = source.slice(pos, to)
    if (fence) {
      lines.push({ from: pos, to, next, text, code: true })
      if (closesFence(text, fence)) fence = null
    } else {
      fence = fenceOpen(text)
      lines.push({ from: pos, to, next, text, code: fence !== null })
    }
    pos = next
  }
  return lines
}

const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/

/** An ATX heading (`## Title ##`). Setext headings are not recognized. */
export function atxHeading(text: string): { level: number; title: string } | null {
  const m = ATX.exec(text)
  if (!m?.[1]) return null
  const title = (m[2] ?? '').replace(/(?:^|[ \t]+)#+[ \t]*$/, '').trim()
  return { level: m[1].length, title }
}
