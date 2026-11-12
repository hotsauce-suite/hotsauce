import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { inlineHtml, type LivePreviewOptions, livePreview, tableCells } from './livePreview'

let views: EditorView[] = []

afterEach(() => {
  for (const view of views) view.destroy()
  views = []
})

function mount(doc: string, opts: { cursorLine?: number; preview?: LivePreviewOptions } = {}) {
  const parent = document.createElement('div')
  document.body.append(parent)
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [markdown({ base: markdownLanguage }), livePreview(opts.preview ?? {})],
    }),
    parent,
  })
  views.push(view)
  if (opts.cursorLine) placeCursor(view, opts.cursorLine)
  return view
}

/** Focus the editor and put the cursor at the start of a 1-based line. */
function placeCursor(view: EditorView, lineNo: number) {
  view.focus()
  view.dispatch({ selection: { anchor: view.state.doc.line(lineNo).from } })
}

const lineText = (view: EditorView, index: number) =>
  view.contentDOM.querySelectorAll('.cm-line')[index]?.textContent

describe('live preview', () => {
  it('gives headings their size class', () => {
    const view = mount('# Title\n\n## Section\n\n### Small\n')
    const lines = view.contentDOM.querySelectorAll('.cm-line')
    expect(lines[0]).toHaveClass('cm-lp-h1')
    expect(lines[2]).toHaveClass('cm-lp-h2')
    expect(lines[4]).toHaveClass('cm-lp-h3')
  })

  it('hides heading and emphasis markers on inactive lines', () => {
    const view = mount('# Title\n\nSome **bold** and *soft* and ~~gone~~ text\n', { cursorLine: 2 })
    expect(lineText(view, 0)).toBe('Title')
    expect(lineText(view, 2)).toBe('Some bold and soft and gone text')
    expect(view.contentDOM.querySelector('.cm-lp-strong')?.textContent).toBe('bold')
    expect(view.contentDOM.querySelector('.cm-lp-em')?.textContent).toBe('soft')
    expect(view.contentDOM.querySelector('.cm-lp-strike')?.textContent).toBe('gone')
  })

  it('shows the raw markers on the active line only', () => {
    const view = mount('# Title\n\nSome **bold** text\n', { cursorLine: 3 })
    expect(lineText(view, 2)).toBe('Some **bold** text')
    expect(lineText(view, 0)).toBe('Title')
    placeCursor(view, 1)
    expect(lineText(view, 0)).toBe('# Title')
    expect(lineText(view, 2)).toBe('Some bold text')
  })

  it('previews every line while the editor is unfocused', () => {
    const view = mount('# Title\n\n`code` here\n')
    expect(view.hasFocus).toBe(false)
    expect(lineText(view, 0)).toBe('Title')
    expect(lineText(view, 2)).toBe('code here')
  })

  it('does not style code spans as emphasis', () => {
    const view = mount('Use `*not em*` and *em* here\n', { cursorLine: 1 })
    const emphasis = view.contentDOM.querySelectorAll('.cm-lp-em')
    expect(emphasis).toHaveLength(1)
    expect(emphasis[0]?.textContent).toBe('*em*')
    const code = view.contentDOM.querySelector('.cm-lp-code')
    expect(code?.textContent).toBe('`*not em*`')
    expect(code?.querySelector('.cm-lp-em')).toBeNull()
  })

  it('toggles a task checkbox in the document text', () => {
    const view = mount('# Tasks\n\n- [ ] write tests\n- [x] ship\n', { cursorLine: 1 })
    const boxes = view.contentDOM.querySelectorAll<HTMLInputElement>('input.cm-lp-checkbox')
    expect(boxes).toHaveLength(2)
    expect(boxes[0]?.checked).toBe(false)
    expect(boxes[1]?.checked).toBe(true)

    boxes[0]?.click()
    expect(view.state.doc.line(3).text).toBe('- [x] write tests')

    view.contentDOM.querySelectorAll<HTMLInputElement>('input.cm-lp-checkbox')[1]?.click()
    expect(view.state.doc.line(4).text).toBe('- [ ] ship')
  })

  it('shows the raw task marker when the cursor is on it', () => {
    const view = mount('- [ ] item\n')
    view.focus()
    view.dispatch({ selection: { anchor: 3 } })
    expect(view.contentDOM.querySelector('input.cm-lp-checkbox')).toBeNull()
    expect(lineText(view, 0)).toBe('- [ ] item')
  })

  it('renders links as clickable text and opens them on Cmd/Ctrl-click', () => {
    const openLink = vi.fn()
    const view = mount('Intro\n\nSee [the plan](plans/q4-plan.md) now\n', {
      cursorLine: 1,
      preview: { openLink },
    })
    expect(lineText(view, 2)).toBe('See the plan now')
    const link = view.contentDOM.querySelector('.cm-lp-link')
    expect(link).toHaveAttribute('data-href', 'plans/q4-plan.md')

    link?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    expect(openLink).not.toHaveBeenCalled()
    link?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, metaKey: true }))
    expect(openLink).toHaveBeenCalledWith('plans/q4-plan.md')
  })

  it('renders images inline through the resolver, keeping the syntax on the active line', async () => {
    const resolveImage = vi.fn(async (src: string) => `blob:resolved/${src}`)
    const view = mount('Text\n\n![Funnel](../assets/funnel.png)\n', {
      cursorLine: 1,
      preview: { resolveImage },
    })
    const img = view.contentDOM.querySelector('.cm-lp-image img')
    expect(img).toHaveAttribute('alt', 'Funnel')
    expect(lineText(view, 2)).toBe('')
    await vi.waitFor(() => expect(img).toHaveAttribute('src', 'blob:resolved/../assets/funnel.png'))

    placeCursor(view, 3)
    expect(lineText(view, 2)).toBe('![Funnel](../assets/funnel.png)')
    expect(view.contentDOM.querySelector('.cm-lp-image img')).not.toBeNull()
  })

  it('folds frontmatter behind a Properties chip and unfolds on click', () => {
    const view = mount('---\nid: 01J\ntitle: Plan\n---\n\n# Plan\n')
    const chip = view.contentDOM.querySelector<HTMLButtonElement>('.cm-lp-properties-toggle')
    expect(chip?.textContent).toBe('2 properties')
    expect(view.contentDOM.textContent).not.toContain('title: Plan')

    chip?.click()
    expect(view.contentDOM.textContent).toContain('title: Plan')
    expect(view.contentDOM.querySelector('.cm-lp-frontmatter')).not.toBeNull()
    // Frontmatter lines are not mistaken for a setext heading.
    expect(view.contentDOM.querySelectorAll('.cm-lp-h2')).toHaveLength(0)
  })

  it('draws bullets and code block lines', () => {
    const view = mount('- one\n- two\n\n```ts\nconst a = 1\n```\n')
    expect(view.contentDOM.querySelectorAll('.cm-lp-bullet')).toHaveLength(2)
    expect(view.contentDOM.querySelectorAll('.cm-lp-fence')).toHaveLength(3)
    expect(view.contentDOM.querySelector('.cm-lp-fence-start')?.textContent).toBe('```ts')
  })

  it('marks callout blockquotes', () => {
    const view = mount('> [!note] Heads up\n> Body\n\n> plain quote\n')
    const lines = view.contentDOM.querySelectorAll('.cm-line')
    expect(lines[0]).toHaveClass('cm-lp-callout')
    expect(lines[1]).toHaveClass('cm-lp-callout')
    expect(lines[3]).toHaveClass('cm-lp-quote')
    expect(lines[3]).not.toHaveClass('cm-lp-callout')
  })

  it('never changes the document text by itself', () => {
    const doc = '---\na: 1\n---\n# T\n\n- [ ] x\n**b** `c` [l](u) ![i](p)\n'
    const view = mount(doc, { cursorLine: 4 })
    placeCursor(view, 7)
    expect(view.state.doc.toString()).toBe(doc)
  })
})

describe('table preview', () => {
  const TABLE = 'Intro\n\n| A | B |\n|:--|--:|\n| **1** | 2 |\n\nAfter\n'

  it('draws a table while the cursor is elsewhere, and the source while it is inside', () => {
    const view = mount(TABLE, { cursorLine: 1 })
    const widget = view.contentDOM.querySelector('.cm-lp-table-widget')
    expect(widget?.querySelectorAll('th')).toHaveLength(2)
    expect(widget?.querySelector('td strong')?.textContent).toBe('1')
    expect(widget?.querySelectorAll('td')[1]).toHaveStyle({ textAlign: 'right' })
    placeCursor(view, 4)
    expect(view.contentDOM.querySelector('.cm-lp-table-widget')).toBeNull()
    expect(view.contentDOM.textContent).toContain('| A | B |')
  })

  it('styles indented code like fenced code', () => {
    const view = mount('Text\n\n    code line\n', { cursorLine: 1 })
    expect(view.contentDOM.querySelectorAll('.cm-line')[2]).toHaveClass('cm-lp-indented-code')
  })
})

describe('table preview helpers', () => {
  it('splits cells on pipes, but not escaped ones or ones inside code', () => {
    expect(tableCells('| a | `x|y` | b \\| c |')).toEqual(['a', '`x|y`', 'b | c'])
    expect(tableCells('a | b')).toEqual(['a', 'b'])
  })

  it('renders a cell’s inline markdown, escaping everything else', () => {
    expect(inlineHtml('**b** and *i* `<code>` [t](u) <script>')).toBe(
      '<strong>b</strong> and <em>i</em> <code>&lt;code&gt;</code> <span class="cm-lp-link">t</span> &lt;script&gt;',
    )
    expect(inlineHtml('a ` b')).toBe('a ` b')
  })
})
