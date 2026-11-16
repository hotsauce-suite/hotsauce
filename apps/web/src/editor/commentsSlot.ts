// The conversation under a doc (docs/PLAN-comments.md): a slot after the last line of the text,
// inside the editor's own scroll, filled by React from outside. And "Comment" on a selection,
// which quotes the passage into the comment box.

import { type EditorState, type Extension, StateField } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  showTooltip,
  type Tooltip,
  ViewPlugin,
  WidgetType,
} from '@codemirror/view'

export interface CommentsSlot {
  /** One element for the life of the page: the editor places it, React fills it. */
  host: HTMLElement
  /** Whether a selection can be commented on right now (a team item that takes comments). */
  canQuote: () => boolean
  onQuote: (text: string) => void
}

class SlotWidget extends WidgetType {
  constructor(readonly host: HTMLElement) {
    super()
  }
  eq(other: SlotWidget) {
    return other.host === this.host
  }
  toDOM() {
    return this.host
  }
  // The comment box and its buttons handle their own typing and clicks.
  ignoreEvent() {
    return true
  }
}

function quoteTooltip(state: EditorState, slot: CommentsSlot): Tooltip | null {
  const range = state.selection.main
  if (range.empty || !slot.canQuote()) return null
  if (state.sliceDoc(range.from, range.to).trim() === '') return null
  return {
    pos: range.head,
    above: range.head < range.anchor,
    strictSide: false,
    arrow: false,
    create: (view) => {
      const dom = document.createElement('div')
      dom.className = 'cm-comment-tooltip'
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = 'Comment'
      button.setAttribute('data-testid', 'quote-comment')
      // Keep the selection while the button is pressed.
      button.addEventListener('mousedown', (event) => event.preventDefault())
      button.addEventListener('click', () => {
        const { from, to } = view.state.selection.main
        const text = view.state.sliceDoc(from, to).trim()
        if (!text) return
        view.dispatch({ selection: { anchor: to } })
        slot.onQuote(text)
      })
      dom.append(button)
      return { dom }
    },
  }
}

export function commentsSlot(slot: CommentsSlot): Extension {
  const widget = Decoration.widget({ widget: new SlotWidget(slot.host), block: true, side: 1 })
  const place = (state: EditorState): DecorationSet =>
    Decoration.set([widget.range(state.doc.length)])
  return [
    StateField.define<DecorationSet>({
      create: place,
      update: (value, tr) => (tr.docChanged ? place(tr.state) : value),
      provide: (field) => EditorView.decorations.from(field),
    }),
    // The conversation grows and shrinks on its own; the editor has to measure it again.
    ViewPlugin.define((view) => {
      const observer =
        typeof ResizeObserver === 'undefined'
          ? null
          : new ResizeObserver(() => view.requestMeasure())
      observer?.observe(slot.host)
      return { destroy: () => observer?.disconnect() }
    }),
    StateField.define<Tooltip | null>({
      create: (state) => quoteTooltip(state, slot),
      update: (value, tr) => (tr.docChanged || tr.selection ? quoteTooltip(tr.state, slot) : value),
      provide: (field) => showTooltip.from(field),
    }),
  ]
}
