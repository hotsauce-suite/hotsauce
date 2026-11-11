import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it } from 'vitest'
import { aiLineRanges, aiRanges } from './aiRanges'

const NOTE = `---
id: X
type: meeting
ai_ranges: [[1, 2], [4, 4]]
---
# Acme sync
- AI summary line
my own line
- AI follow-up
another own line
`
// Frontmatter is 5 lines, so body line n is file line n + 5.

let views: EditorView[] = []
afterEach(() => {
  for (const view of views) view.destroy()
  views = []
})

function mount(doc: string) {
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: [aiRanges()] }),
    parent: document.body,
  })
  views.push(view)
  return view
}

const mutedText = (view: EditorView) =>
  [...view.contentDOM.querySelectorAll('.cm-ai-line')].map((el) => el.textContent)

describe('aiLineRanges', () => {
  it('turns body line ranges into file line ranges past the frontmatter', () => {
    expect(aiLineRanges(NOTE)).toEqual({
      ranges: [
        [6, 7],
        [9, 9],
      ],
      frontmatterEnd: NOTE.indexOf('# Acme'),
    })
  })

  it('ignores malformed ranges and files without frontmatter', () => {
    const bad = NOTE.replace('[[1, 2], [4, 4]]', '[[3, 1], [0, 2], "x", [2.5, 3], [2, 2]]')
    expect(aiLineRanges(bad).ranges).toEqual([[7, 7]])
    expect(aiLineRanges('# Just a doc\n')).toEqual({ ranges: [], frontmatterEnd: 0 })
  })

  it('handles CRLF files', () => {
    expect(aiLineRanges(NOTE.replace(/\n/g, '\r\n')).ranges).toEqual([
      [6, 7],
      [9, 9],
    ])
  })
})

describe('the AI-range decoration', () => {
  it('marks exactly the AI lines', () => {
    const view = mount(NOTE)
    expect(mutedText(view)).toEqual(['# Acme sync', '- AI summary line', '- AI follow-up'])
    expect(view.contentDOM.querySelectorAll('[data-testid="ai-text"]')).toHaveLength(3)
  })

  it('keeps the marks on their text while the body is edited', () => {
    const view = mount(NOTE)
    const at = view.state.doc.toString().indexOf('my own line')
    view.dispatch({ changes: { from: at, insert: 'a new line\n' } })
    expect(mutedText(view)).toEqual(['# Acme sync', '- AI summary line', '- AI follow-up'])
  })

  it('keeps the marks on their text when a line is added at the very top of the body', () => {
    const view = mount(NOTE)
    const at = view.state.doc.toString().indexOf('# Acme sync')
    view.dispatch({ changes: { from: at, insert: '\n' } })
    expect(mutedText(view)).toEqual(['# Acme sync', '- AI summary line', '- AI follow-up'])
  })

  it('keeps a mark while its line’s start is typed over, and drops it when the line is joined up', () => {
    const view = mount(NOTE)
    const at = () => view.state.doc.toString().indexOf('- AI follow-up')
    view.dispatch({ changes: { from: at(), insert: 'x' } })
    expect(mutedText(view)).toContain('x- AI follow-up')
    // Backspace at its start joins it onto the member's line above, which stays theirs.
    view.dispatch({ changes: { from: at() - 2, to: at() - 1 } })
    expect(mutedText(view)).toEqual(['# Acme sync', '- AI summary line'])
  })

  it('re-reads the ranges when the frontmatter changes (an enhance adopted in place)', () => {
    const view = mount(NOTE)
    const from = view.state.doc.toString().indexOf('[[1, 2], [4, 4]]')
    view.dispatch({ changes: { from, to: from + '[[1, 2], [4, 4]]'.length, insert: '[[3, 3]]' } })
    expect(mutedText(view)).toEqual(['my own line'])
  })

  it('copes with overlapping and out-of-order ranges and ones past the end', () => {
    const view = mount(NOTE.replace('[[1, 2], [4, 4]]', '[[4, 99], [1, 2], [2, 3]]'))
    expect(mutedText(view)).toEqual([
      '# Acme sync',
      '- AI summary line',
      'my own line',
      '- AI follow-up',
      'another own line',
      '',
    ])
  })
})
