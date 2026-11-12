// Obsidian-style live preview over the raw markdown source. The document text is never
// rewritten by these decorations: markers are hidden on lines the cursor isn't on and shown
// again on the active line, so what you edit is always exactly what's in the file.
//
// Only the visible ranges are decorated, so cost scales with the viewport, not the document.

import { syntaxTree } from '@codemirror/language'
import {
  type EditorState,
  type Extension,
  Facet,
  type Range,
  StateEffect,
  StateField,
} from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view'
import { parseFrontmatter } from '@hearth/format'
import { isExternalHref } from '../lib/paths'

export interface LivePreviewOptions {
  /** Turns an image src from the document into a loadable URL (relative paths, auth). */
  resolveImage?: (src: string) => Promise<string>
  /** Called when the user Cmd/Ctrl-clicks a link. */
  openLink?: (href: string) => void
  /**
   * Draws a `tasks` block's live task list into `host` (its text without the fences); returns
   * the cleanup. Without it, the block stays as source.
   */
  mountTaskList?: (source: string, host: HTMLElement) => () => void
}

const previewOptions = Facet.define<LivePreviewOptions, LivePreviewOptions>({
  combine: (values) => values[0] ?? {},
})

// ---------------------------------------------------------------------------------------------
// Frontmatter: folded behind a "Properties" chip. Block decorations must come from state, not
// from a view plugin, so this half lives in a StateField + computed decorations.

const FRONTMATTER_SCAN_CHARS = 20_000

export const setFrontmatterFolded = StateEffect.define<boolean>()

interface FrontmatterInfo {
  /** End of the closing fence line. */
  to: number
  fields: number
}

function readFrontmatter(state: EditorState): FrontmatterInfo | null {
  const head = state.doc.sliceString(0, FRONTMATTER_SCAN_CHARS)
  const { data, yamlText, body } = parseFrontmatter(head)
  if (yamlText === null) return null
  // The body starts just past the closing fence's line break.
  const end = head.length - body.length
  return { to: state.doc.lineAt(Math.max(0, end - 1)).to, fields: Object.keys(data).length }
}

const frontmatterInfo = StateField.define<FrontmatterInfo | null>({
  create: readFrontmatter,
  update(value, tr) {
    if (!tr.docChanged) return value
    // Edits below the frontmatter can't change it; skip the rescan on ordinary typing.
    if (!tr.changes.touchesRange(0, (value?.to ?? 3) + 1)) return value
    return readFrontmatter(tr.state)
  },
})

const frontmatterFolded = StateField.define<boolean>({
  create: () => true,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setFrontmatterFolded)) return effect.value
    return value
  },
})

/** Where the body starts, for placing the initial cursor below folded frontmatter. */
export function bodyStart(state: EditorState): number {
  const info = state.field(frontmatterInfo, false)
  if (!info) return 0
  return Math.min(state.doc.length, info.to + 1)
}

class PropertiesWidget extends WidgetType {
  constructor(readonly fields: number) {
    super()
  }
  eq(other: PropertiesWidget) {
    return other.fields === this.fields
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement('div')
    wrap.className = 'cm-lp-properties'
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'cm-lp-properties-toggle'
    button.textContent = this.fields === 1 ? '1 property' : `${this.fields} properties`
    button.title = 'Show the YAML frontmatter'
    button.addEventListener('mousedown', (event) => event.preventDefault())
    button.addEventListener('click', () => {
      view.dispatch({ effects: setFrontmatterFolded.of(false) })
    })
    wrap.append(button)
    return wrap
  }
}

class FoldPropertiesWidget extends WidgetType {
  eq() {
    return true
  }
  toDOM(view: EditorView) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'cm-lp-properties-fold'
    button.textContent = 'Hide properties'
    button.addEventListener('mousedown', (event) => event.preventDefault())
    button.addEventListener('click', () =>
      view.dispatch({ effects: setFrontmatterFolded.of(true) }),
    )
    return button
  }
}

const FRONTMATTER_LINE = Decoration.line({ class: 'cm-lp-frontmatter' })

const frontmatterDecorations = EditorView.decorations.compute(
  [frontmatterInfo, frontmatterFolded],
  (state) => {
    const info = state.field(frontmatterInfo)
    if (!info) return Decoration.none
    if (state.field(frontmatterFolded)) {
      const widget = new PropertiesWidget(info.fields)
      return Decoration.set([Decoration.replace({ widget, block: true }).range(0, info.to)])
    }
    const ranges: Range<Decoration>[] = []
    for (let pos = 0; pos <= info.to; ) {
      const line = state.doc.lineAt(pos)
      ranges.push(FRONTMATTER_LINE.range(line.from))
      pos = line.to + 1
    }
    const firstLineEnd = state.doc.lineAt(0).to
    ranges.push(
      Decoration.widget({ widget: new FoldPropertiesWidget(), side: 1 }).range(firstLineEnd),
    )
    return Decoration.set(ranges, true)
  },
)

// ---------------------------------------------------------------------------------------------
// Tables: drawn as a real table while the cursor is elsewhere, raw pipes while it's inside.
// A block replacement, so like the frontmatter it lives in state, not in the view plugin.

type Align = 'left' | 'center' | 'right' | null

/** One table row's cells, splitting on pipes outside inline code and not escaped. */
export function tableCells(line: string): string[] {
  const text = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  const cells: string[] = []
  let cell = ''
  let inCode = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\\' && text[i + 1] === '|') {
      cell += '|'
      i++
    } else if (ch === '`') {
      inCode = !inCode
      cell += ch
    } else if (ch === '|' && !inCode) {
      cells.push(cell.trim())
      cell = ''
    } else {
      cell += ch
    }
  }
  cells.push(cell.trim())
  return cells
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c,
  )
}

/** A cell's inline markdown as HTML: code, bold, italic, strike, links (as text). Escaped first. */
export function inlineHtml(text: string): string {
  // Odd pieces are inside backticks: code, taken literally. An unpaired backtick stays as text.
  const pieces = text.split('`')
  if (pieces.length % 2 === 0) {
    const last = pieces.pop() ?? ''
    pieces.push(`${pieces.pop() ?? ''}\`${last}`)
  }
  return pieces
    .map((piece, i) =>
      i % 2 === 1
        ? `<code>${escapeHtml(piece)}</code>`
        : escapeHtml(piece)
            .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '<span class="cm-lp-link">$1</span>')
            .replace(/(\*\*|__)(.+?)\1/g, '<strong>$2</strong>')
            .replace(/(\*|_)(.+?)\1/g, '<em>$2</em>')
            .replace(/~~(.+?)~~/g, '<s>$1</s>'),
    )
    .join('')
}

class TableWidget extends WidgetType {
  constructor(readonly source: string) {
    super()
  }
  eq(other: TableWidget) {
    return other.source === this.source
  }
  toDOM(view: EditorView) {
    const lines = this.source.split('\n')
    const aligns: Align[] = tableCells(lines[1] ?? '').map((d) =>
      /^:-+:$/.test(d) ? 'center' : /^-+:$/.test(d) ? 'right' : /^:-+$/.test(d) ? 'left' : null,
    )
    const wrap = document.createElement('div')
    wrap.className = 'cm-lp-table-widget'
    const table = document.createElement('table')
    const row = (line: string, tag: 'th' | 'td') => {
      const tr = document.createElement('tr')
      const cells = tableCells(line)
      const width = Math.max(aligns.length, 1)
      for (let i = 0; i < width; i++) {
        const cell = document.createElement(tag)
        cell.innerHTML = inlineHtml(cells[i] ?? '')
        const align = aligns[i]
        if (align) cell.style.textAlign = align
        tr.append(cell)
      }
      return tr
    }
    const head = document.createElement('thead')
    head.append(row(lines[0] ?? '', 'th'))
    const body = document.createElement('tbody')
    for (const line of lines.slice(2)) if (line.trim()) body.append(row(line, 'td'))
    table.append(head, body)
    wrap.append(table)
    // A click puts the cursor in the table, which shows its source for editing.
    wrap.addEventListener('mousedown', (event) => {
      event.preventDefault()
      // Read the position now: the widget is kept while text above it changes.
      view.dispatch({ selection: { anchor: view.posAtDOM(wrap) } })
      view.focus()
    })
    return wrap
  }
  ignoreEvent() {
    return false
  }
}

/** Each drawn list's cleanup, by its DOM: a kept widget can be destroyed through a newer twin. */
const taskListCleanups = new WeakMap<HTMLElement, () => void>()

class TaskListWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly mount: (source: string, host: HTMLElement) => () => void,
  ) {
    super()
  }
  eq(other: TaskListWidget) {
    return other.source === this.source
  }
  get estimatedHeight() {
    return 120
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement('div')
    wrap.className = 'cm-lp-task-list'
    const host = document.createElement('div')
    const edit = document.createElement('button')
    edit.type = 'button'
    edit.className = 'cm-lp-task-list-edit'
    edit.textContent = 'Edit query'
    edit.addEventListener('mousedown', (event) => event.preventDefault())
    edit.addEventListener('click', () => {
      // Onto the first query line, inside the fences, so the source shows for editing.
      const line = view.state.doc.lineAt(view.posAtDOM(wrap))
      view.dispatch({ selection: { anchor: Math.min(line.to + 1, view.state.doc.length) } })
      view.focus()
    })
    wrap.append(edit, host)
    taskListCleanups.set(wrap, this.mount(this.source, host))
    return wrap
  }
  destroy(dom: HTMLElement) {
    taskListCleanups.get(dom)?.()
    taskListCleanups.delete(dom)
  }
  ignoreEvent() {
    // Checkboxes and links in the list handle their own clicks.
    return true
  }
}

/** The text of a `tasks` fence, without the fence lines; null for any other block. */
function taskQuerySource(state: EditorState, from: number, to: number): string | null {
  const first = state.doc.lineAt(from)
  if (!/^\s*(`{3,}|~{3,})\s*tasks\s*$/.test(first.text)) return null
  const last = state.doc.lineAt(to)
  const closed = last.number > first.number && /^\s*(`{3,}|~{3,})\s*$/.test(last.text)
  const end = closed ? last.from - 1 : to
  return end > first.to ? state.doc.sliceString(first.to + 1, end) : ''
}

/** Tables and `tasks` blocks drawn whole while the cursor is elsewhere. */
function blockDecorations(state: EditorState): DecorationSet {
  const ranges: Range<Decoration>[] = []
  const frontmatterTo = state.field(frontmatterInfo)?.to ?? -1
  const { mountTaskList } = state.facet(previewOptions)
  const { selection } = state
  for (let node = syntaxTree(state).topNode.firstChild; node; node = node.nextSibling) {
    if ((node.name !== 'Table' && node.name !== 'FencedCode') || node.from <= frontmatterTo) {
      continue
    }
    const from = state.doc.lineAt(node.from).from
    const to = state.doc.lineAt(node.to).to
    if (selection.ranges.some((r) => r.from <= to && r.to >= from)) continue
    if (node.name === 'Table') {
      const widget = new TableWidget(state.doc.sliceString(from, to))
      ranges.push(Decoration.replace({ widget, block: true }).range(from, to))
      continue
    }
    const source = mountTaskList ? taskQuerySource(state, from, to) : null
    if (source === null || !mountTaskList) continue
    const widget = new TaskListWidget(source, mountTaskList)
    ranges.push(Decoration.replace({ widget, block: true }).range(from, to))
  }
  return Decoration.set(ranges)
}

const blockPreview = StateField.define<DecorationSet>({
  create: blockDecorations,
  update(value, tr) {
    if (tr.docChanged || tr.selection || syntaxTree(tr.startState) !== syntaxTree(tr.state)) {
      return blockDecorations(tr.state)
    }
    return value
  },
  provide: (field) => EditorView.decorations.from(field),
})

// ---------------------------------------------------------------------------------------------
// Inline preview.

export function toggleTaskAt(view: EditorView, pos: number): boolean {
  const marker = view.state.sliceDoc(pos, pos + 3)
  const next = marker === '[ ]' ? '[x]' : /^\[[xX]\]$/.test(marker) ? '[ ]' : null
  if (!next) return false
  view.dispatch({ changes: { from: pos, to: pos + 3, insert: next }, userEvent: 'input.toggle' })
  return true
}

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super()
  }
  eq(other: CheckboxWidget) {
    return other.checked === this.checked
  }
  toDOM(view: EditorView) {
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.className = 'cm-lp-checkbox'
    box.checked = this.checked
    box.setAttribute('aria-label', this.checked ? 'Mark as not done' : 'Mark as done')
    // Keep the cursor where it is; the click toggles the text, which re-renders the box.
    box.addEventListener('mousedown', (event) => event.preventDefault())
    box.addEventListener('click', (event) => {
      event.preventDefault()
      toggleTaskAt(view, view.posAtDOM(box))
    })
    return box
  }
}

class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
  ) {
    super()
  }
  eq(other: ImageWidget) {
    return other.src === this.src && other.alt === this.alt
  }
  get estimatedHeight() {
    return 180
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement('span')
    wrap.className = 'cm-lp-image'
    const img = document.createElement('img')
    img.alt = this.alt
    img.decoding = 'async'
    wrap.append(img)
    const resolve = view.state.facet(previewOptions).resolveImage
    if (!resolve || isExternalHref(this.src)) {
      img.src = this.src
    } else {
      resolve(this.src).then(
        (url) => {
          img.src = url
        },
        () => {
          wrap.classList.add('cm-lp-image-missing')
          img.remove()
          wrap.textContent = `Image not found: ${this.src}`
        },
      )
    }
    return wrap
  }
}

class TextWidget extends WidgetType {
  constructor(
    readonly className: string,
    readonly text: string,
  ) {
    super()
  }
  eq(other: TextWidget) {
    return other.className === this.className && other.text === this.text
  }
  toDOM() {
    const span = document.createElement('span')
    span.className = this.className
    span.textContent = this.text
    span.setAttribute('aria-hidden', 'true')
    return span
  }
}

const HIDE = Decoration.replace({})
const BULLET = Decoration.replace({ widget: new TextWidget('cm-lp-bullet', '•') })
const RULE = Decoration.replace({ widget: new TextWidget('cm-lp-hr', '') })
const EMPHASIS = Decoration.mark({ class: 'cm-lp-em' })
const STRONG = Decoration.mark({ class: 'cm-lp-strong' })
const STRIKE = Decoration.mark({ class: 'cm-lp-strike' })
const CODE = Decoration.mark({ class: 'cm-lp-code' })
const QUOTE_MARK = Decoration.mark({ class: 'cm-lp-quote-mark' })
const HEADING_LINES = [1, 2, 3, 4, 5, 6].map((level) =>
  Decoration.line({ class: `cm-lp-heading cm-lp-h${level}` }),
)
const QUOTE_LINE = Decoration.line({ class: 'cm-lp-quote' })
const CALLOUT_LINE = Decoration.line({ class: 'cm-lp-quote cm-lp-callout' })
const TABLE_LINE = Decoration.line({ class: 'cm-lp-table' })
const FENCE_LINE = Decoration.line({ class: 'cm-lp-fence' })
const INDENTED_CODE_LINE = Decoration.line({ class: 'cm-lp-fence cm-lp-indented-code' })
const FENCE_START = Decoration.line({ class: 'cm-lp-fence cm-lp-fence-start' })
const FENCE_END = Decoration.line({ class: 'cm-lp-fence cm-lp-fence-end' })

const linkMark = (href: string) =>
  Decoration.mark({
    class: 'cm-lp-link',
    attributes: { 'data-href': href, title: `${href} (Cmd-click or Ctrl-click to open)` },
  })

/** Lines holding a selection, but only while the editor has focus; unfocused, all lines preview. */
function activeLines(view: EditorView): Set<number> {
  const lines = new Set<number>()
  if (!view.hasFocus) return lines
  const { doc } = view.state
  for (const range of view.state.selection.ranges) {
    const last = doc.lineAt(range.to).number
    for (let n = doc.lineAt(range.from).number; n <= last; n++) lines.add(n)
  }
  return lines
}

function buildDecorations(view: EditorView): DecorationSet {
  const { state } = view
  const { doc } = state
  const active = activeLines(view)
  const frontmatterTo = state.field(frontmatterInfo)?.to ?? -1
  const ranges: Range<Decoration>[] = []
  const isActive = (pos: number) => active.has(doc.lineAt(pos).number)
  // Replacements from a plugin may not cross line breaks; markers never legitimately do.
  const replace = (deco: Decoration, from: number, to: number) => {
    if (from < to && doc.lineAt(from).number === doc.lineAt(to).number) {
      ranges.push(deco.range(from, to))
    }
  }
  const eachLine = (from: number, to: number, deco: (lineNo: number) => Decoration) => {
    const last = doc.lineAt(to).number
    for (let n = doc.lineAt(from).number; n <= last; n++)
      ranges.push(deco(n).range(doc.line(n).from))
  }

  for (const visible of view.visibleRanges) {
    syntaxTree(state).iterate({
      from: visible.from,
      to: visible.to,
      enter: (node) => {
        if (node.name !== 'Document' && node.from <= frontmatterTo) return false
        const from = Math.max(node.from, visible.from)
        const to = Math.min(node.to, visible.to)
        switch (node.name) {
          case 'ATXHeading1':
          case 'ATXHeading2':
          case 'ATXHeading3':
          case 'ATXHeading4':
          case 'ATXHeading5':
          case 'ATXHeading6':
          case 'SetextHeading1':
          case 'SetextHeading2': {
            const level = Number(node.name.slice(-1))
            const deco = HEADING_LINES[level - 1]
            if (deco) ranges.push(deco.range(doc.lineAt(node.from).from))
            return
          }
          case 'HeaderMark': {
            if (!node.node.parent?.name.startsWith('ATX') || isActive(node.from)) return
            if (doc.sliceString(node.to, node.to + 1) === ' ') replace(HIDE, node.from, node.to + 1)
            else if (doc.sliceString(node.from - 1, node.from) === ' ')
              replace(HIDE, node.from - 1, node.to)
            else replace(HIDE, node.from, node.to)
            return
          }
          case 'Emphasis':
            ranges.push(EMPHASIS.range(node.from, node.to))
            return
          case 'StrongEmphasis':
            ranges.push(STRONG.range(node.from, node.to))
            return
          case 'Strikethrough':
            ranges.push(STRIKE.range(node.from, node.to))
            return
          case 'InlineCode':
            ranges.push(CODE.range(node.from, node.to))
            return
          case 'EmphasisMark':
          case 'StrikethroughMark':
            if (!isActive(node.from)) replace(HIDE, node.from, node.to)
            return
          case 'CodeMark':
            if (node.node.parent?.name === 'InlineCode' && !isActive(node.from)) {
              replace(HIDE, node.from, node.to)
            }
            return
          case 'Link': {
            const marks = node.node.getChildren('LinkMark')
            const url = node.node.getChild('URL')
            const open = marks[0]
            const close = marks[1]
            if (!url || !open || !close) return
            const href = doc.sliceString(url.from, url.to)
            if (close.from > open.to) ranges.push(linkMark(href).range(open.to, close.from))
            if (!isActive(node.from)) {
              replace(HIDE, open.from, open.to)
              replace(HIDE, close.from, node.to)
            }
            return
          }
          case 'URL': {
            const parent = node.node.parent?.name
            if (parent === 'Link' || parent === 'Image') return
            ranges.push(linkMark(doc.sliceString(node.from, node.to)).range(node.from, node.to))
            return
          }
          case 'Image': {
            const url = node.node.getChild('URL')
            const marks = node.node.getChildren('LinkMark')
            if (!url) return false
            const alt = marks[0] && marks[1] ? doc.sliceString(marks[0].to, marks[1].from) : ''
            const widget = new ImageWidget(doc.sliceString(url.from, url.to), alt)
            if (isActive(node.from)) {
              ranges.push(Decoration.widget({ widget, side: 1 }).range(node.to))
            } else {
              replace(Decoration.replace({ widget }), node.from, node.to)
            }
            return false
          }
          case 'TaskMarker': {
            const touched =
              view.hasFocus &&
              state.selection.ranges.some((r) => r.from <= node.to && r.to >= node.from)
            if (touched) return
            const checked = /x/i.test(doc.sliceString(node.from + 1, node.to - 1))
            replace(Decoration.replace({ widget: new CheckboxWidget(checked) }), node.from, node.to)
            return
          }
          case 'ListMark': {
            const item = node.node.parent
            if (item?.parent?.name !== 'BulletList' || isActive(node.from)) return
            if (item.getChild('Task')) {
              const space = doc.sliceString(node.to, node.to + 1) === ' ' ? 1 : 0
              replace(HIDE, node.from, node.to + space)
            } else {
              replace(BULLET, node.from, node.to)
            }
            return
          }
          case 'HorizontalRule':
            if (!isActive(node.from)) replace(RULE, node.from, node.to)
            return
          case 'Blockquote': {
            const firstLine = doc.lineAt(node.from)
            const isCallout = /^\s*>\s*\[!\w+\]/.test(firstLine.text)
            eachLine(from, to, () => (isCallout ? CALLOUT_LINE : QUOTE_LINE))
            return
          }
          case 'QuoteMark':
            ranges.push(QUOTE_MARK.range(node.from, node.to))
            return
          case 'Table':
            eachLine(from, to, () => TABLE_LINE)
            return
          case 'CodeBlock':
            eachLine(from, to, () => INDENTED_CODE_LINE)
            return false
          case 'FencedCode': {
            const first = doc.lineAt(node.from).number
            const last = doc.lineAt(node.to).number
            eachLine(from, to, (n) =>
              n === first ? FENCE_START : n === last ? FENCE_END : FENCE_LINE,
            )
            // Code content is highlighted by the nested language parser, not by us.
            return false
          }
          default:
            return
        }
      },
    })
  }
  return Decoration.set(ranges, true)
}

const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view)
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet ||
        update.focusChanged ||
        syntaxTree(update.startState) !== syntaxTree(update.state) ||
        update.startState.field(frontmatterInfo) !== update.state.field(frontmatterInfo)
      ) {
        this.decorations = buildDecorations(update.view)
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
)

const linkClicks = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (event.button !== 0 || !(event.metaKey || event.ctrlKey)) return false
    const target = (event.target as HTMLElement | null)?.closest('[data-href]')
    const href = target?.getAttribute('data-href')
    if (!href) return false
    event.preventDefault()
    view.state.facet(previewOptions).openLink?.(href)
    return true
  },
})

export function livePreview(options: LivePreviewOptions = {}): Extension {
  return [
    previewOptions.of(options),
    frontmatterInfo,
    frontmatterFolded,
    frontmatterDecorations,
    blockPreview,
    livePreviewPlugin,
    linkClicks,
  ]
}
