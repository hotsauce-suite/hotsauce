// Text offsets in the reader's copy (docs/PLAN-links-highlights.md): a highlight is found again
// by its words in the copy's text, then drawn as a DOM Range. Nothing here changes the DOM.

import { findQuoteIn, HIGHLIGHT_CONTEXT, prepareText } from '@hotsauce/format'

export interface TextIndex {
  /** Every text node's characters, in order: what `Range.toString()` would give. */
  text: string
  nodes: Text[]
  /** Where each node starts in `text`. */
  starts: number[]
}

export function textIndex(root: HTMLElement): TextIndex {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  const starts: number[] = []
  let text = ''
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push(n as Text)
    starts.push(text.length)
    text += (n as Text).data
  }
  return { text, nodes, starts }
}

/** The node and offset in it for a text offset. */
function pointAt(idx: TextIndex, offset: number, end: boolean): { node: Text; offset: number } {
  let lo = 0
  let hi = idx.nodes.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    const start = idx.starts[mid] ?? 0
    // An end at a node's very start belongs to the node before it.
    if (end ? start < offset : start <= offset) lo = mid
    else hi = mid - 1
  }
  const node = idx.nodes[lo] as Text
  return { node, offset: Math.min(node.data.length, offset - (idx.starts[lo] ?? 0)) }
}

export function rangeFor(idx: TextIndex, start: number, end: number): Range | null {
  if (idx.nodes.length === 0 || end <= start) return null
  const a = pointAt(idx, start, false)
  const b = pointAt(idx, end, true)
  const range = a.node.ownerDocument.createRange()
  range.setStart(a.node, a.offset)
  range.setEnd(b.node, b.offset)
  return range
}

/** The text offset of a point in the copy. */
export function offsetOf(root: HTMLElement, node: Node, offset: number): number {
  const range = root.ownerDocument.createRange()
  range.setStart(root, 0)
  range.setEnd(node, offset)
  return range.toString().length
}

/** The index of the copy's top-level block that holds `node`, or -1. */
export function blockOf(root: HTMLElement, node: Node): number {
  let n: Node | null = node
  while (n && n.parentNode !== root) n = n.parentNode
  return n ? Array.prototype.indexOf.call(root.children, n) : -1
}

export interface Selected {
  quote: string
  prefix: string
  suffix: string
  block: number
  /** Where the selection is on screen, for the toolbar. */
  rect: { top: number; bottom: number; left: number; right: number }
}

/** The member's selection when it is words inside the copy, else null. */
export function selectionIn(root: HTMLElement): Selected | null {
  const sel = root.ownerDocument.getSelection()
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null
  const range = sel.getRangeAt(0)
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null
  const idx = textIndex(root)
  const start = offsetOf(root, range.startContainer, range.startOffset)
  const end = offsetOf(root, range.endContainer, range.endOffset)
  const raw = idx.text.slice(start, end)
  if (!raw.trim()) return null
  // jsdom lays nothing out and has no boxes for ranges.
  const box =
    typeof range.getBoundingClientRect === 'function'
      ? range.getBoundingClientRect()
      : { top: 0, bottom: 0, left: 0, right: 0 }
  return {
    quote: raw.replace(/\s+/g, ' ').trim(),
    prefix: idx.text.slice(Math.max(0, start - HIGHLIGHT_CONTEXT), start),
    suffix: idx.text.slice(end, end + HIGHLIGHT_CONTEXT),
    block: Math.max(0, blockOf(root, range.startContainer)),
    rect: { top: box.top, bottom: box.bottom, left: box.left, right: box.right },
  }
}

/** Each highlight's Range in the copy, or null when its words aren't there any more. */
export function placeHighlights<
  H extends { id: string; quote: string; prefix?: string; suffix?: string; block?: number },
>(root: HTMLElement, highlights: readonly H[]): Map<string, Range | null> {
  const idx = textIndex(root)
  const prepared = prepareText(idx.text)
  // Where each top-level block starts, in one pass over the text nodes.
  const starts: number[] = []
  let n = 0
  for (let b = 0; b < root.children.length; b++) {
    const el = root.children[b] as Element
    while (n < idx.nodes.length && !el.contains(idx.nodes[n] as Node)) n++
    starts.push(idx.starts[n] ?? idx.text.length)
  }
  const out = new Map<string, Range | null>()
  for (const h of highlights) {
    const near = h.block !== undefined ? starts[h.block] : undefined
    const at = findQuoteIn(prepared, h, near)
    out.set(h.id, at ? rangeFor(idx, at.start, at.end) : null)
  }
  return out
}

type HighlightRegistry = Map<string, unknown>
type HighlightCtor = new (...ranges: Range[]) => unknown

/** Draws ranges under a highlight name; false when the browser can't (old browsers, jsdom). */
export function paint(name: string, ranges: Range[]): boolean {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS
  const Ctor = (globalThis as { Highlight?: HighlightCtor }).Highlight
  if (!css?.highlights || !Ctor) return false
  if (ranges.length === 0) css.highlights.delete(name)
  else css.highlights.set(name, new Ctor(...ranges))
  return true
}

/** True when a point on screen is inside the range's text. */
export function rangeHas(range: Range, x: number, y: number): boolean {
  if (typeof range.getClientRects !== 'function') return false
  for (const r of Array.from(range.getClientRects())) {
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true
  }
  return false
}
