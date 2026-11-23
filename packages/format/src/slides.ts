// A Doc presented as slides (docs/PLAN-slides.md). The doc stays an ordinary Markdown file: a line
// that is only `---` ends a slide, or, in a doc without one, each `##` heading starts one. A line
// starting `Notes:` begins the slide's speaker notes, which run to the end of the slide.

import { parseFrontmatter } from './frontmatter.js'

export interface Slide {
  /** The slide's Markdown, without its notes. */
  body: string
  /** The speaker notes' Markdown, '' when the slide has none. */
  notes: string
}

const SEPARATOR = /^---[ \t]*$/
const SLIDE_HEADING = /^## /
const NOTES = /^notes:[ \t]*/i
const FENCE = /^ {0,3}(`{3,}|~{3,})/

/** Each line, and whether it sits inside a fenced code block (fence lines themselves count). */
function scan(lines: string[]): boolean[] {
  const inCode: boolean[] = []
  let open: string | null = null
  for (const line of lines) {
    const fence = FENCE.exec(line)?.[1] ?? null
    if (open === null) {
      if (fence) open = fence
      inCode.push(open !== null)
    } else {
      inCode.push(true)
      // Closed by a fence of the same character, at least as long, with nothing after it.
      if (fence && fence[0] === open[0] && fence.length >= open.length && line.trim() === fence) {
        open = null
      }
    }
  }
  return inCode
}

/** Drops blank lines at the start and end, keeping the first line's indentation. */
function trimBlank(lines: string[]): string {
  let from = 0
  let to = lines.length
  while (from < to && (lines[from] ?? '').trim() === '') from++
  while (to > from && (lines[to - 1] ?? '').trim() === '') to--
  // Trailing spaces stay: two of them are a Markdown line break.
  return lines.slice(from, to).join('\n')
}

/** A paragraph line: `---` right under one underlines it as a heading, it doesn't end a slide. */
const PARAGRAPH = /^ {0,3}(?![-*+] |\d+[.)] |#|>|\|)\S/

/** The doc's slides, in order. Empty slides (two separators in a row) are left out. */
export function splitSlides(markdown: string): Slide[] {
  const lines = parseFrontmatter(markdown).body.replace(/\r\n?/g, '\n').split('\n')
  const inCode = scan(lines)
  const isSeparator = (i: number) =>
    !inCode[i] &&
    SEPARATOR.test(lines[i] ?? '') &&
    !(i > 0 && !inCode[i - 1] && PARAGRAPH.test(lines[i - 1] ?? ''))
  const byRule = lines.some((_, i) => isSeparator(i))
  const chunks: { lines: string[]; code: boolean[] }[] = [{ lines: [], code: [] }]
  lines.forEach((line, i) => {
    const code = inCode[i] ?? false
    if (byRule && isSeparator(i)) {
      chunks.push({ lines: [], code: [] })
      return
    }
    if (!code && !byRule && SLIDE_HEADING.test(line)) chunks.push({ lines: [], code: [] })
    const chunk = chunks.at(-1) as { lines: string[]; code: boolean[] }
    chunk.lines.push(line)
    chunk.code.push(code)
  })
  const slides: Slide[] = []
  for (const chunk of chunks) {
    const at = chunk.lines.findIndex((l, i) => !chunk.code[i] && NOTES.test(l))
    const bodyLines = at === -1 ? chunk.lines : chunk.lines.slice(0, at)
    const noteLines =
      at === -1 ? [] : [(chunk.lines[at] ?? '').replace(NOTES, ''), ...chunk.lines.slice(at + 1)]
    const slide = { body: trimBlank(bodyLines), notes: trimBlank(noteLines) }
    if (slide.body !== '' || slide.notes !== '') slides.push(slide)
  }
  return slides
}

/** The slides as one Markdown text, joined by `---`, without the notes (for the PDF). */
export function deckMarkdown(slides: Slide[]): string {
  return `${slides.map((s) => s.body).join('\n\n---\n\n')}\n`
}
