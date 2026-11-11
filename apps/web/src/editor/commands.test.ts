import { CompletionContext } from '@codemirror/autocomplete'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { insertLink, toggleMarker } from './commands'
import { wikiLinkSource } from './wikiLink'

function run(doc: string, from: number, to: number, command: typeof insertLink) {
  let state = EditorState.create({ doc, selection: EditorSelection.single(from, to) })
  const handled = command({
    state,
    dispatch: (tr) => {
      state = tr.state
    },
  })
  return { handled, text: state.doc.toString(), selection: state.selection.main }
}

describe('editor commands', () => {
  it('Cmd-B wraps the selection in ** and unwraps it again', () => {
    const wrapped = run('make this bold', 5, 9, toggleMarker('**'))
    expect(wrapped.text).toBe('make **this** bold')
    const unwrapped = run(
      wrapped.text,
      wrapped.selection.from,
      wrapped.selection.to,
      toggleMarker('**'),
    )
    expect(unwrapped.text).toBe('make this bold')
  })

  it('Cmd-I wraps in * and does not mistake bold for italic', () => {
    expect(run('a word', 2, 6, toggleMarker('*')).text).toBe('a *word*')
    expect(run('a **word**', 4, 8, toggleMarker('*')).text).toBe('a ***word***')
  })

  it('Cmd-K turns a selection into a link and leaves an empty selection to the palette', () => {
    expect(run('see docs', 4, 8, insertLink)).toMatchObject({ handled: true, text: 'see [docs]()' })
    expect(run('https://x.org', 0, 13, insertLink).text).toBe('[](https://x.org)')
    expect(run('nothing selected', 3, 3, insertLink).handled).toBe(false)
  })

  it('[[ completion writes a standard relative link', async () => {
    const doc = 'See [[q4'
    const parent = document.createElement('div')
    const view = new EditorView({
      state: EditorState.create({ doc, selection: { anchor: doc.length } }),
      parent,
    })
    const source = wikiLinkSource(
      async () => [{ path: 'docs/plans/q4-plan.md', title: 'Q4 plan' }],
      () => 'docs/eng/notes.md',
    )
    const result = await source(new CompletionContext(view.state, doc.length, true))
    const option = result?.options[0]
    expect(option?.label).toBe('Q4 plan')
    const apply = option?.apply
    if (!option || typeof apply !== 'function') throw new Error('expected an apply function')
    apply(view, option, result?.from ?? 0, doc.length)
    expect(view.state.doc.toString()).toBe('See [Q4 plan](../plans/q4-plan.md)')
    view.destroy()
  })
})
