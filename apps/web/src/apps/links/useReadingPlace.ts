import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { linksApi, type ReadingPlace } from '../../api/links'

/** Quiet time after scrolling before the place is saved, and the least time between saves. */
const SETTLE_MS = 1000
const MIN_GAP_MS = 3000
/** How long "Picked up where you left off" stays. */
const RESUMED_MS = 10_000
/** Room left above a block scrolled back to; measuring uses the same line. */
const TOP_GAP = 16

/**
 * Places this tab sent lately, by link id: the list shows them even when it loaded before the
 * last save (sent as the reader closed) reached the server.
 */
const recent = new Map<string, Place & { at: string }>()

/** Tests start each case with none. */
export function forgetRecentPlaces(): void {
  recent.clear()
}

/** A list's link with this tab's latest place laid over the server's, when it's newer. */
export function withRecentPlace<T extends { id: string; reading: ReadingPlace | null }>(
  link: T,
): T {
  const mine = recent.get(link.id)
  // A later place from another device wins.
  if (!mine || (link.reading && link.reading.updated >= mine.at)) return link
  return {
    ...link,
    reading: {
      anchor: mine.anchor,
      percent: mine.percent,
      furthest: Math.max(link.reading?.furthest ?? 0, mine.percent),
      updated: mine.at,
    },
  }
}

export interface Place {
  anchor: number
  percent: number
}

/**
 * Where the screen is in the copy: the first block whose bottom is below the top of the scroller,
 * and how far through the copy the bottom of the scroller is.
 */
export function measurePlace(scroller: HTMLElement, body: HTMLElement): Place {
  const view = scroller.getBoundingClientRect()
  const copy = body.getBoundingClientRect()
  const blocks = body.children
  // Blocks are in page order, so the first one still showing is found by halving.
  let lo = 0
  let hi = blocks.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if ((blocks[mid] as HTMLElement).getBoundingClientRect().bottom > view.top + TOP_GAP + 1) {
      hi = mid
    } else lo = mid + 1
  }
  const percent =
    copy.height > 0 ? Math.min(100, Math.max(0, ((view.bottom - copy.top) / copy.height) * 100)) : 0
  return { anchor: Math.max(0, lo), percent: Math.round(percent * 10) / 10 }
}

/** Scrolls to a saved place: its block, or the same percent when the copy has fewer blocks now. */
export function scrollToPlace(scroller: HTMLElement, body: HTMLElement, place: Place): void {
  const view = scroller.getBoundingClientRect()
  const block = body.children[place.anchor] as HTMLElement | undefined
  if (block) {
    scroller.scrollTop += block.getBoundingClientRect().top - view.top - TOP_GAP
    return
  }
  const copy = body.getBoundingClientRect()
  scroller.scrollTop += copy.top + (copy.height * place.percent) / 100 - view.bottom
}

/**
 * Keeps the member's place in a saved link (R5, R6): goes back to it once when the copy is shown,
 * then saves it a moment after scrolling stops (at most every 3 s) and when the page is hidden or
 * left. Saving never interrupts reading: a failed save is dropped.
 */
export function useReadingPlace(opts: {
  space: string
  id: string
  /** The saved place when the link was opened; null before the copy is ready. */
  saved: ReadingPlace | null
  /** Whether the copy is on screen (not fetching, failed or empty). */
  ready: boolean
  scroller: RefObject<HTMLElement | null>
  body: RefObject<HTMLElement | null>
}): { resumed: boolean; startOver: () => void } {
  const { space, id, saved, ready, scroller, body } = opts
  const [resumed, setResumed] = useState(false)
  const restoredFor = useRef<string | null>(null)
  /** The place last measured on screen, and the one last sent. */
  const seen = useRef<Place | null>(null)
  const sent = useRef<Place | null>(null)
  const sentAt = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // The place is the link's, whatever space it's in: sharing it mid-read changes only the address.
  const spaceNow = useRef(space)
  spaceNow.current = space

  const measure = useCallback(() => {
    const s = scroller.current
    const b = body.current
    if (s && b?.isConnected) seen.current = measurePlace(s, b)
  }, [scroller, body])

  // Sends what was last measured, if it moved: works after unmount too, when the page is gone.
  const send = useCallback(
    (keepalive: boolean) => {
      clearTimeout(timer.current)
      const place = seen.current
      const prev = sent.current
      if (!place || (prev && prev.anchor === place.anchor && prev.percent === place.percent)) return
      sent.current = place
      sentAt.current = Date.now()
      recent.set(id, { ...place, at: new Date().toISOString() })
      linksApi.setReading(spaceNow.current, id, place, { keepalive }).catch(() => {})
    },
    [id],
  )

  const schedule = useCallback(() => {
    clearTimeout(timer.current)
    const wait = Math.max(SETTLE_MS, sentAt.current + MIN_GAP_MS - Date.now())
    timer.current = setTimeout(() => {
      measure()
      send(false)
    }, wait)
  }, [measure, send])

  // Back to the saved place, once per link, as soon as the copy is laid out.
  useLayoutEffect(() => {
    if (!ready || restoredFor.current === id) return
    const s = scroller.current
    const b = body.current
    if (!s || !b) return
    restoredFor.current = id
    sent.current = saved ? { anchor: saved.anchor, percent: saved.percent } : null
    if (saved && saved.anchor > 0) {
      scrollToPlace(s, b, saved)
      setResumed(true)
    } else setResumed(false)
    seen.current = measurePlace(s, b)
    // Opening counts: what's on screen now is read, even without a scroll.
    schedule()
  }, [ready, id, saved, scroller, body, schedule])

  useEffect(() => {
    const s = scroller.current
    if (!ready || !s) return
    let frame = 0
    const onScroll = () => {
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0
          measure()
        })
      }
      schedule()
    }
    const flush = () => {
      if (document.visibilityState !== 'hidden') return
      measure()
      send(true)
    }
    const leave = () => {
      measure()
      send(true)
    }
    s.addEventListener('scroll', onScroll, { passive: true })
    document.addEventListener('visibilitychange', flush)
    window.addEventListener('pagehide', leave)
    return () => {
      cancelAnimationFrame(frame)
      s.removeEventListener('scroll', onScroll)
      document.removeEventListener('visibilitychange', flush)
      window.removeEventListener('pagehide', leave)
      measure()
      send(true)
    }
  }, [ready, scroller, measure, schedule, send])

  useEffect(() => {
    if (!resumed) return
    const t = setTimeout(() => setResumed(false), RESUMED_MS)
    return () => clearTimeout(t)
  }, [resumed])

  const startOver = useCallback(() => {
    const s = scroller.current
    if (s) s.scrollTop = 0
    setResumed(false)
    measure()
    send(false)
  }, [scroller, measure, send])

  return { resumed, startOver }
}
