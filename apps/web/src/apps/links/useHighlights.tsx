import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useNavigate } from 'react-router'
import { type LinkHighlight, type LinkWithBody, linksApi } from '../../api/links'
import { Icon } from '../../components/Icon'
import { docUrl } from '../../lib/paths'
import { primaryButton, secondaryButton } from '../meetings/components/common'
import { paint, placeHighlights, rangeHas, type Selected, selectionIn } from './textRanges'
import { errorMessage } from './useLinks'

type Rect = { top: number; bottom: number; left: number; right: number }

/** The popover: one highlight, or a new one waiting for its note. */
type Open =
  | { kind: 'highlight'; id: string; rect: Rect; editing: boolean }
  | { kind: 'new'; selected: Selected }

const TOOLBAR_GAP = 8
const NONE: LinkHighlight[] = []

/** In page order: by where the passage was found, else by block, else by time. */
function pageOrder(ranges: Map<string, Range | null>) {
  return (a: LinkHighlight, b: LinkHighlight) => {
    const ra = ranges.get(a.id)
    const rb = ranges.get(b.id)
    if (ra && rb) {
      const c = ra.compareBoundaryPoints(Range.START_TO_START, rb)
      if (c !== 0) return c
    }
    if (ra && !rb) return -1
    if (!ra && rb) return 1
    return (a.block ?? 1e9) - (b.block ?? 1e9) || a.at.localeCompare(b.at)
  }
}

/**
 * Highlights and notes in the reader (docs/PLAN-links-highlights.md R11): selecting words in the
 * copy offers Highlight and Add note; highlights are drawn over the copy without touching its
 * DOM; a click on one opens its note. Returns the Highlights section and the floating parts.
 */
export function useHighlights(opts: {
  link: LinkWithBody | null
  setLink: (update: (cur: LinkWithBody) => LinkWithBody) => void
  /** The member's email, lower case. */
  me: string
  body: RefObject<HTMLElement | null>
  scroller: RefObject<HTMLElement | null>
  /** Whether the copy is on screen. */
  ready: boolean
  /** A highlight to go to once the copy is laid out (`?highlight=`). */
  goTo: string | null
  notify: (message: string) => void
}): { section: ReactNode; overlay: ReactNode; onBodyClick: (e: React.MouseEvent) => void } {
  const { link, setLink, me, body, scroller, ready, goTo, notify } = opts
  const navigate = useNavigate()
  const highlights = link?.highlights ?? NONE
  const [ranges, setRanges] = useState<Map<string, Range | null>>(new Map())
  const [selected, setSelected] = useState<Selected | null>(null)
  const [open, setOpen] = useState<Open | null>(null)
  const [note, setNote] = useState('')
  const [onlyMine, setOnlyMine] = useState(false)
  const [busy, setBusy] = useState(false)
  const wentTo = useRef<string | null>(null)

  // Find each passage in the copy whenever the copy or the highlights change. The copy's DOM is
  // new when its text changes, so the text is a dependency.
  const copyText = link?.body
  useLayoutEffect(() => {
    const b = body.current
    if (!ready || !b || !copyText) {
      setRanges((cur) => (cur.size === 0 ? cur : new Map()))
      return
    }
    setRanges(placeHighlights(b, highlights))
  }, [ready, body, highlights, copyText])

  const shown = useMemo(
    () => highlights.filter((h) => !onlyMine || h.by === me),
    [highlights, onlyMine, me],
  )
  const activeId = open?.kind === 'highlight' ? open.id : null

  // Draw them: yours, teammates', and the open one on top.
  useEffect(() => {
    const pick = (keep: (h: LinkHighlight) => boolean) =>
      shown
        .filter((h) => h.id !== activeId && keep(h))
        .map((h) => ranges.get(h.id))
        .filter((r): r is Range => !!r)
    paint(
      'link-mine',
      pick((h) => h.by === me),
    )
    paint(
      'link-theirs',
      pick((h) => h.by !== me),
    )
    const active = activeId ? ranges.get(activeId) : null
    paint('link-active', active ? [active] : [])
  }, [shown, ranges, me, activeId])
  useEffect(
    () => () => {
      paint('link-mine', [])
      paint('link-theirs', [])
      paint('link-active', [])
    },
    [],
  )

  // The selection toolbar follows the member's selection in the copy.
  useEffect(() => {
    if (!ready) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const check = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        const b = body.current
        setSelected(b ? selectionIn(b) : null)
      }, 120)
    }
    document.addEventListener('selectionchange', check)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('selectionchange', check)
    }
  }, [ready, body])

  // Scrolling moves the passage away from a floating part, so they close.
  useEffect(() => {
    const s = scroller.current
    if (!s) return
    const close = () => {
      setSelected(null)
      setOpen((cur) => (cur?.kind === 'highlight' && !cur.editing ? null : cur))
    }
    s.addEventListener('scroll', close, { passive: true })
    return () => s.removeEventListener('scroll', close)
  }, [scroller])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  const scrollTo = useCallback(
    (id: string) => {
      const range = ranges.get(id)
      const s = scroller.current
      if (!range || !s || typeof range.getBoundingClientRect !== 'function') return null
      const view = s.getBoundingClientRect()
      const box = range.getBoundingClientRect()
      s.scrollTop += box.top - view.top - view.height / 3
      const after = range.getBoundingClientRect()
      return { top: after.top, bottom: after.bottom, left: after.left, right: after.right }
    },
    [ranges, scroller],
  )

  const openHighlight = useCallback(
    (id: string, editing = false) => {
      const rect = scrollTo(id)
      const h = highlights.find((x) => x.id === id)
      setNote(h?.note ?? '')
      setOpen(
        rect
          ? { kind: 'highlight', id, rect, editing }
          : {
              kind: 'highlight',
              id,
              rect: { top: 120, bottom: 120, left: 24, right: 24 },
              editing,
            },
      )
    },
    [scrollTo, highlights],
  )

  // Opened from the Highlights tab: go to that passage once.
  useEffect(() => {
    if (!goTo || wentTo.current === goTo || ranges.size === 0) return
    wentTo.current = goTo
    if (ranges.get(goTo)) openHighlight(goTo)
  }, [goTo, ranges, openHighlight])

  const clearSelection = () => {
    document.getSelection()?.removeAllRanges()
    setSelected(null)
  }

  const add = async (sel: Selected, withNote?: string) => {
    if (!link) return
    setBusy(true)
    try {
      const made = await linksApi.addHighlight(link.space, link.id, {
        quote: sel.quote,
        prefix: sel.prefix,
        suffix: sel.suffix,
        block: sel.block,
        ...(withNote?.trim() ? { note: withNote } : {}),
      })
      setLink((cur) => ({
        ...cur,
        highlights: [...cur.highlights, made],
        highlightCount: cur.highlightCount + 1,
      }))
      clearSelection()
      setOpen(null)
    } catch (e) {
      notify(errorMessage(e, 'That highlight didn’t save. Check your connection and try again.'))
    } finally {
      setBusy(false)
    }
  }

  const saveNote = async (id: string) => {
    if (!link) return
    setBusy(true)
    try {
      const next = await linksApi.noteHighlight(link.space, link.id, id, note)
      setLink((cur) => ({
        ...cur,
        highlights: cur.highlights.map((h) => (h.id === id ? next : h)),
      }))
      setOpen(null)
    } catch (e) {
      notify(errorMessage(e, 'That note didn’t save. Check your connection and try again.'))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id: string) => {
    if (!link) return
    setBusy(true)
    try {
      await linksApi.removeHighlight(link.space, link.id, id)
      setLink((cur) => ({
        ...cur,
        highlights: cur.highlights.filter((h) => h.id !== id),
        highlightCount: Math.max(0, cur.highlightCount - 1),
      }))
      setOpen(null)
      notify('Highlight removed')
    } catch (e) {
      notify(errorMessage(e, 'That didn’t save. Check your connection and try again.'))
    } finally {
      setBusy(false)
    }
  }

  const copyToDoc = async () => {
    if (!link) return
    setBusy(true)
    try {
      const doc = await linksApi.copyHighlights(link.space, link.id)
      notify(`Copied to “${doc.title}”`)
      navigate(docUrl(doc.space, doc.path))
    } catch (e) {
      notify(errorMessage(e, 'Couldn’t make the doc. Check your connection and try again.'))
    } finally {
      setBusy(false)
    }
  }

  // A click on a highlighted passage opens it (when the click didn't select words).
  const onBodyClick = (e: React.MouseEvent) => {
    if (document.getSelection()?.isCollapsed === false) return
    const hit = shown.find((h) => {
      const r = ranges.get(h.id)
      return r ? rangeHas(r, e.clientX, e.clientY) : false
    })
    if (!hit) return
    // A link inside a highlight still opens the page.
    if ((e.target as HTMLElement).closest('a')) return
    const r = ranges.get(hit.id)?.getBoundingClientRect?.()
    setNote(hit.note ?? '')
    setOpen({
      kind: 'highlight',
      id: hit.id,
      rect: r
        ? { top: r.top, bottom: r.bottom, left: r.left, right: r.right }
        : { top: e.clientY, bottom: e.clientY, left: e.clientX, right: e.clientX },
      editing: false,
    })
  }

  const others = highlights.some((h) => h.by !== me)
  const ordered = useMemo(() => [...shown].sort(pageOrder(ranges)), [shown, ranges])

  const section =
    highlights.length > 0 ? (
      <section
        className="mt-6 rounded-xl border border-ash-strong p-4"
        data-testid="link-highlights"
      >
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="mr-auto text-sm font-semibold text-ink">
            Highlights <span className="font-normal text-ink-faint">{shown.length}</span>
          </h2>
          {others ? (
            <label className="flex items-center gap-1.5 text-xs text-ink-soft">
              <input
                type="checkbox"
                checked={onlyMine}
                onChange={(e) => setOnlyMine(e.target.checked)}
                data-testid="link-only-mine"
              />
              Show only mine
            </label>
          ) : null}
          <button
            type="button"
            className={`${secondaryButton} h-8 text-xs`}
            disabled={busy}
            onClick={copyToDoc}
            data-testid="link-copy-highlights"
          >
            <Icon name="docs" />
            Copy to a Doc
          </button>
        </div>
        <ol className="mt-3 space-y-3">
          {ordered.map((h) => {
            const found = !ready || !!ranges.get(h.id)
            return (
              <li key={h.id} data-testid="link-highlight-item">
                <button
                  type="button"
                  className={`w-full border-l-2 pl-3 text-left text-sm text-ink hover:text-ember-strong ${h.by === me ? 'border-ember' : 'border-ash-strong'}`}
                  onClick={() => (found ? openHighlight(h.id) : setOpen(null))}
                  disabled={!found}
                >
                  <span className="line-clamp-3">{h.quote}</span>
                </button>
                {h.note ? (
                  <p className="mt-1 pl-3.5 text-sm whitespace-pre-wrap text-ink-soft">{h.note}</p>
                ) : null}
                <p className="mt-0.5 pl-3.5 text-xs text-ink-faint">
                  {[h.by === me ? '' : h.name, found ? '' : 'Not in the page any more']
                    .filter(Boolean)
                    .join(' · ')}
                  {h.by === me && !found ? (
                    <>
                      {' · '}
                      <button
                        type="button"
                        className="underline hover:text-ink"
                        onClick={() => remove(h.id)}
                      >
                        Remove
                      </button>
                    </>
                  ) : null}
                </p>
              </li>
            )
          })}
        </ol>
      </section>
    ) : null

  const place = (rect: Rect, width: number) => {
    const left = Math.min(
      Math.max(8, (rect.left + rect.right) / 2 - width / 2),
      window.innerWidth - width - 8,
    )
    const below = rect.bottom + TOOLBAR_GAP
    // Below the passage (the phone's own menu sits above it), unless that's off the screen.
    const top = below + 160 > window.innerHeight ? Math.max(8, rect.top - 160) : below
    return { left, top }
  }

  const openHl = open?.kind === 'highlight' ? highlights.find((h) => h.id === open.id) : null

  const overlay = (
    <>
      {selected && !open ? (
        <div
          role="toolbar"
          aria-label="Highlight the selected words"
          data-testid="link-selection-toolbar"
          className="fixed z-40 flex gap-1 rounded-lg border border-ash-strong bg-paper-raised p-1 shadow-lg"
          style={place(selected.rect, 220)}
          // Keep the selection while the buttons are pressed.
          onMouseDown={(e) => e.preventDefault()}
        >
          <button
            type="button"
            className="flex h-9 items-center gap-1.5 rounded-md px-3 text-sm text-ink hover:bg-ash/60"
            disabled={busy}
            onClick={() => add(selected)}
            data-testid="link-highlight"
          >
            <Icon name="pencil" />
            Highlight
          </button>
          <button
            type="button"
            className="flex h-9 items-center gap-1.5 rounded-md px-3 text-sm text-ink hover:bg-ash/60"
            disabled={busy}
            onClick={() => {
              setNote('')
              setOpen({ kind: 'new', selected })
            }}
            data-testid="link-add-note"
          >
            <Icon name="notes" />
            Add note
          </button>
        </div>
      ) : null}
      {open ? (
        <div
          role="dialog"
          aria-label={open.kind === 'new' ? 'Add a note' : 'Highlight'}
          data-testid="link-highlight-popover"
          className="fixed z-40 w-80 max-w-[calc(100vw-16px)] rounded-xl border border-ash-strong bg-paper-raised p-3 shadow-lg"
          style={place(open.kind === 'new' ? open.selected.rect : open.rect, 320)}
        >
          {open.kind === 'new' || (openHl && openHl.by === me && open.editing) ? (
            <form
              onSubmit={(e) => {
                e.preventDefault()
                if (open.kind === 'new') void add(open.selected, note)
                else void saveNote(open.id)
              }}
            >
              <textarea
                className="h-24 w-full resize-y rounded-lg border border-ash-strong bg-paper p-2 text-sm text-ink"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey))
                    e.currentTarget.form?.requestSubmit()
                }}
                placeholder="Your note (only for you and whoever can see this link)"
                aria-label="Note"
                data-testid="link-note-input"
                // biome-ignore lint/a11y/noAutofocus: opened by "Add note" or "Edit note"
                autoFocus
              />
              <div className="mt-2 flex justify-end gap-2">
                <button
                  type="button"
                  className={`${secondaryButton} h-8`}
                  onClick={() => setOpen(null)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className={`${primaryButton} h-8`}
                  disabled={busy}
                  data-testid="link-note-save"
                >
                  {open.kind === 'new' ? 'Highlight' : 'Save'}
                </button>
              </div>
            </form>
          ) : openHl ? (
            <div>
              {openHl.note ? (
                <p className="text-sm whitespace-pre-wrap text-ink" data-testid="link-popover-note">
                  {openHl.note}
                </p>
              ) : openHl.by === me ? (
                <p className="text-sm text-ink-faint">No note yet.</p>
              ) : null}
              <p
                className={`${openHl.note || openHl.by === me ? 'mt-2' : ''} text-xs text-ink-faint`}
              >
                {openHl.by === me ? 'Your highlight' : `Highlighted by ${openHl.name}`}
                {openHl.edited ? ' · edited' : ''}
              </p>
              {openHl.by === me ? (
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    className={`${secondaryButton} h-8 text-xs`}
                    onClick={() => {
                      setNote(openHl.note ?? '')
                      setOpen({ ...open, editing: true })
                    }}
                    data-testid="link-edit-note"
                  >
                    {openHl.note ? 'Edit note' : 'Add note'}
                  </button>
                  <button
                    type="button"
                    className={`${secondaryButton} h-8 text-xs`}
                    disabled={busy}
                    onClick={() => remove(openHl.id)}
                    data-testid="link-remove-highlight"
                  >
                    Remove highlight
                  </button>
                  <button
                    type="button"
                    className="ml-auto text-xs text-ink-soft underline"
                    onClick={() => setOpen(null)}
                  >
                    Close
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="mt-2 text-xs text-ink-soft underline"
                  onClick={() => setOpen(null)}
                >
                  Close
                </button>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  )

  return { section, overlay, onBodyClick }
}
