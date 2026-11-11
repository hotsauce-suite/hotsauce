// Obsidian/GitHub callouts: a blockquote whose first line is `[!kind] Optional title`
// renders as <div class="callout callout-kind"> with a title line. The file is untouched.

interface MdNode {
  type: string
  value?: string
  children?: MdNode[]
  data?: { hName?: string; hProperties?: Record<string, unknown> }
}

const MARKER = /^\[!(\w+)\][+-]?[ \t]*([^\n]*)\n?/

function toCallout(quote: MdNode): void {
  const first = quote.children?.[0]
  const text = first?.type === 'paragraph' ? first.children?.[0] : undefined
  if (!first || text?.type !== 'text' || !text.value) return
  const match = MARKER.exec(text.value)
  if (!match) return
  const kind = (match[1] ?? 'note').toLowerCase()
  const title = match[2]?.trim() || kind[0]?.toUpperCase() + kind.slice(1)

  text.value = text.value.slice(match[0].length)
  if (!text.value) first.children?.shift()
  if (first.children?.length === 0) quote.children?.shift()

  quote.data = {
    hName: 'div',
    hProperties: { className: ['callout', `callout-${kind}`], dataCallout: kind },
  }
  quote.children?.unshift({
    type: 'paragraph',
    data: { hProperties: { className: ['callout-title'] } },
    children: [{ type: 'text', value: title }],
  })
}

function walk(node: MdNode): void {
  for (const child of node.children ?? []) {
    if (child.type === 'blockquote') toCallout(child)
    walk(child)
  }
}

export function remarkCallouts() {
  return (tree: MdNode) => walk(tree)
}
