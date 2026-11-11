// Mutes the AI-written lines of an enhanced meeting note. The file stays clean markdown; which
// lines the AI wrote is frontmatter `ai_ranges` (Meetings PRD §6.4, §7): 1-based inclusive
// line ranges counted in the body, after the frontmatter.

import {
  type EditorState,
  type Extension,
  MapMode,
  RangeSetBuilder,
  StateField,
} from '@codemirror/state'
import { Decoration, EditorView } from '@codemirror/view'
import { parseFrontmatter } from '@hearth/format'

const FRONTMATTER_SCAN_CHARS = 20_000

const AI_LINE = Decoration.line({ class: 'cm-ai-line', attributes: { 'data-testid': 'ai-text' } })

function isRange(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every((n) => typeof n === 'number' && Number.isInteger(n))
  )
}

/**
 * The `ai_ranges` of a note as 1-based line ranges of the whole file, and where the
 * frontmatter ends (0 when there is none).
 */
export function aiLineRanges(text: string): {
  ranges: Array<[number, number]>
  frontmatterEnd: number
} {
  const { data, yamlText, body } = parseFrontmatter(text)
  if (yamlText === null) return { ranges: [], frontmatterEnd: 0 }
  const head = text.slice(0, text.length - body.length)
  const bodyOffset = head.split('\n').length - 1
  const raw = Array.isArray(data.ai_ranges) ? data.ai_ranges : []
  const ranges = raw
    .filter(isRange)
    .filter(([first, last]) => first >= 1 && last >= first)
    .map(([first, last]): [number, number] => [first + bodyOffset, last + bodyOffset])
  return { ranges, frontmatterEnd: head.length }
}

interface AiState {
  /** Where each AI line starts, ascending. */
  lines: number[]
  frontmatterEnd: number
}

function read(state: EditorState): AiState {
  // The frontmatter is at the top; there's no need to parse the rest of a long note.
  const head = state.doc.sliceString(0, FRONTMATTER_SCAN_CHARS)
  const { ranges, frontmatterEnd } = aiLineRanges(head)
  // Ranges may overlap or come unsorted; each line counts once.
  const numbers = new Set<number>()
  for (const [first, last] of ranges) {
    for (let n = Math.max(1, first); n <= Math.min(last, state.doc.lines); n++) numbers.add(n)
  }
  const lines = [...numbers].sort((a, b) => a - b).map((n) => state.doc.line(n).from)
  return { lines, frontmatterEnd }
}

const aiField = StateField.define<AiState>({
  create: read,
  update(value, tr) {
    if (!tr.docChanged) return value
    // A changed frontmatter (an enhance adopted in place) re-reads the ranges. The
    // frontmatter ends with its closing fence's line break.
    if (tr.changes.touchesRange(0, Math.max(0, value.frontmatterEnd - 1))) return read(tr.state)
    // In the body a mark follows its line's text: past a line break typed at the line's
    // start, and gone with a line joined onto the one above.
    const lines = new Set<number>()
    for (const from of value.lines) {
      const mapped = tr.changes.mapPos(from, 1, MapMode.TrackBefore)
      if (mapped !== null) lines.add(tr.state.doc.lineAt(mapped).from)
    }
    return { lines: [...lines].sort((a, b) => a - b), frontmatterEnd: value.frontmatterEnd }
  },
  provide: (field) =>
    EditorView.decorations.from(field, (value) => {
      const builder = new RangeSetBuilder<Decoration>()
      for (const from of value.lines) builder.add(from, from, AI_LINE)
      return builder.finish()
    }),
})

export function aiRanges(): Extension {
  return aiField
}
