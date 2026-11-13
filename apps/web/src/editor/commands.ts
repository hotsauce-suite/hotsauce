import { EditorSelection, type StateCommand } from '@codemirror/state'

/** Wraps each selection in `marker` (Cmd-B/Cmd-I), or unwraps it if it's already wrapped. */
export function toggleMarker(marker: string): StateCommand {
  return ({ state, dispatch }) => {
    const n = marker.length
    const transaction = state.changeByRange((range) => {
      const before = state.sliceDoc(range.from - n, range.from)
      const after = state.sliceDoc(range.to, range.to + n)
      // `*` inside `**`: the selection is bold, not italic, so wrap rather than unwrap.
      const doubled =
        n === 1 &&
        (state.sliceDoc(range.from - 2, range.from - 1) === marker ||
          state.sliceDoc(range.to + 1, range.to + 2) === marker)
      if (before === marker && after === marker && !doubled) {
        return {
          changes: [
            { from: range.from - n, to: range.from },
            { from: range.to, to: range.to + n },
          ],
          range: EditorSelection.range(range.from - n, range.to - n),
        }
      }
      return {
        changes: [
          { from: range.from, insert: marker },
          { from: range.to, insert: marker },
        ],
        range: EditorSelection.range(range.from + n, range.to + n),
      }
    })
    dispatch(state.update(transaction, { scrollIntoView: true, userEvent: 'input.format' }))
    return true
  }
}

/**
 * Cmd-K with a selection makes it a link. With nothing selected it returns false so the
 * keystroke falls through to the command palette.
 */
export const insertLink: StateCommand = ({ state, dispatch }) => {
  const range = state.selection.main
  if (range.empty) return false
  const text = state.sliceDoc(range.from, range.to)
  const isUrl = /^https?:\/\/\S+$/.test(text)
  const insert = isUrl ? `[](${text})` : `[${text}]()`
  const cursor = isUrl ? range.from + 1 : range.from + text.length + 3
  dispatch(
    state.update({
      changes: { from: range.from, to: range.to, insert },
      selection: { anchor: cursor },
      scrollIntoView: true,
      userEvent: 'input.format',
    }),
  )
  return true
}

/** The lines the selections touch, each once, top to bottom. */
function selectedLines(state: Parameters<StateCommand>[0]['state']) {
  const seen = new Set<number>()
  const lines = []
  for (const range of state.selection.ranges) {
    for (let n = state.doc.lineAt(range.from).number; n <= state.doc.lineAt(range.to).number; n++) {
      if (seen.has(n)) continue
      seen.add(n)
      lines.push(state.doc.line(n))
    }
  }
  return lines
}

const HEADING = /^#{1,6}[ \t]+/
const LIST = /^(\s*)(?:[-*+][ \t]+\[[ xX]\][ \t]+|[-*+][ \t]+|\d+[.)][ \t]+)/

/** ⌥⌘1–⌥⌘3 make the lines headings of that level; ⌥⌘0 makes them plain text again. */
export function setHeading(level: number): StateCommand {
  return ({ state, dispatch }) => {
    const changes = selectedLines(state).map((line) => {
      const old = HEADING.exec(line.text)?.[0] ?? ''
      return {
        from: line.from,
        to: line.from + old.length,
        insert: level ? `${'#'.repeat(level)} ` : '',
      }
    })
    dispatch(state.update({ changes, scrollIntoView: true, userEvent: 'input.format' }))
    return true
  }
}

export type ListKind = 'bullet' | 'numbered' | 'checklist'
const MARKERS: Record<ListKind, (i: number) => string> = {
  bullet: () => '- ',
  numbered: (i) => `${i + 1}. `,
  checklist: () => '- [ ] ',
}
const kindOf = (marker: string): ListKind =>
  /\[[ xX]\]/.test(marker) ? 'checklist' : /\d/.test(marker) ? 'numbered' : 'bullet'

/**
 * ⇧⌘7 numbered, ⇧⌘8 bullets, ⇧⌘9 checklist (as in Google Docs). Lines already in that kind of
 * list become plain text; any other list marker is swapped.
 */
export function toggleList(kind: ListKind): StateCommand {
  return ({ state, dispatch }) => {
    const lines = selectedLines(state).filter((l, _, all) => all.length === 1 || l.text.trim())
    const allThisKind = lines.every((l) => {
      const m = LIST.exec(l.text)
      return m && kindOf(m[0]) === kind
    })
    const changes = lines.map((line, i) => {
      const m = LIST.exec(line.text)
      const indent = m?.[1] ?? /^\s*/.exec(line.text)?.[0] ?? ''
      const old = m?.[0] ?? indent
      return {
        from: line.from,
        to: line.from + old.length,
        insert: allThisKind ? indent : indent + MARKERS[kind](i),
      }
    })
    dispatch(state.update({ changes, scrollIntoView: true, userEvent: 'input.format' }))
    return true
  }
}

/** ⌘Enter ticks or unticks the checklist item the cursor is on. Elsewhere it does nothing. */
export const toggleCheckbox: StateCommand = ({ state, dispatch }) => {
  const changes = []
  for (const line of selectedLines(state)) {
    const m = /^(\s*[-*+][ \t]+\[)([ xX])\]/.exec(line.text)
    if (!m) continue
    const at = line.from + (m[1]?.length ?? 0)
    changes.push({ from: at, to: at + 1, insert: m[2] === ' ' ? 'x' : ' ' })
  }
  if (changes.length === 0) return false
  dispatch(state.update({ changes, userEvent: 'input.format' }))
  return true
}
