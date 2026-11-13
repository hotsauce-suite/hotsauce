import { CompletionContext } from '@codemirror/autocomplete'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { insertLink, setHeading, toggleCheckbox, toggleList, toggleMarker } from './commands'
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

describe('editor formatting keys (slice 5)', () => {
  it('Cmd-E and Shift-Cmd-X wrap in code and strikethrough', () => {
    expect(run('call fn now', 5, 7, toggleMarker('`')).text).toBe('call `fn` now')
    expect(run('old plan', 0, 3, toggleMarker('~~')).text).toBe('~~old~~ plan')
  })

  it('Opt-Cmd-1 to 3 set the heading level and Opt-Cmd-0 removes it', () => {
    expect(run('Title', 2, 2, setHeading(1)).text).toBe('# Title')
    expect(run('# Title', 3, 3, setHeading(3)).text).toBe('### Title')
    expect(run('## Title', 3, 3, setHeading(0)).text).toBe('Title')
    expect(run('a\nb', 0, 3, setHeading(2)).text).toBe('## a\n## b')
  })

  it('Shift-Cmd-7/8/9 make numbered, bulleted and checklist lines, and toggle them off', () => {
    expect(run('one\ntwo', 0, 7, toggleList('numbered')).text).toBe('1. one\n2. two')
    expect(run('one\ntwo', 0, 7, toggleList('bullet')).text).toBe('- one\n- two')
    expect(run('- one', 3, 3, toggleList('checklist')).text).toBe('- [ ] one')
    expect(run('- one\n- two', 0, 11, toggleList('bullet')).text).toBe('one\ntwo')
    expect(run('  1. deep', 5, 5, toggleList('bullet')).text).toBe('  - deep')
  })

  it('Cmd-Enter ticks and unticks a checklist item, and passes elsewhere', () => {
    expect(run('- [ ] milk', 7, 7, toggleCheckbox).text).toBe('- [x] milk')
    expect(run('- [x] milk', 7, 7, toggleCheckbox).text).toBe('- [ ] milk')
    expect(run('plain', 2, 2, toggleCheckbox).handled).toBe(false)
  })
})

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
