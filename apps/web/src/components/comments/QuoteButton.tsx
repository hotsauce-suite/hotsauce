import { type RefObject, useEffect, useState } from 'react'

/**
 * "Comment" beside a selection in the reading view: quotes the passage into the comment box.
 * (The editor has its own, drawn by CodeMirror.)
 */
export function QuoteButton({
  container,
  onQuote,
}: {
  container: RefObject<HTMLElement | null>
  onQuote: (text: string) => void
}) {
  const [at, setAt] = useState<{ top: number; left: number; text: string } | null>(null)

  useEffect(() => {
    const update = () => {
      const selection = document.getSelection()
      const article = container.current?.querySelector('[data-testid="reading-view"]')
      if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !article) {
        return setAt(null)
      }
      const range = selection.getRangeAt(0)
      const text = selection.toString().trim()
      if (!text || !article.contains(range.commonAncestorContainer)) return setAt(null)
      const rects = range.getClientRects()
      const rect = rects[rects.length - 1] ?? range.getBoundingClientRect()
      setAt({
        top: Math.min(rect.bottom + 6, window.innerHeight - 44),
        left: Math.max(8, Math.min(rect.right - 40, window.innerWidth - 110)),
        text,
      })
    }
    document.addEventListener('selectionchange', update)
    return () => document.removeEventListener('selectionchange', update)
  }, [container])

  if (!at) return null
  return (
    <button
      type="button"
      data-testid="quote-comment"
      style={{ top: at.top, left: at.left }}
      // On the press, not the click: a tap clears the selection (and this button) before a
      // click would arrive.
      onPointerDown={(e) => {
        e.preventDefault()
        onQuote(at.text)
        document.getSelection()?.removeAllRanges()
        setAt(null)
      }}
      className="fixed z-40 inline-flex h-8 items-center rounded-lg border border-ash bg-paper-raised px-3 text-sm font-medium text-ember-strong shadow-float hover:border-ember"
    >
      Comment
    </button>
  )
}
