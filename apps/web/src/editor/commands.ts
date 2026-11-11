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
