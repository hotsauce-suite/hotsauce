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
    livePreviewPlugin,
    linkClicks,
  ]
}
