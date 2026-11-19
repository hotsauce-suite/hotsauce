// The first-run tour on Today (docs/PLAN-tour-and-101.md): a welcome card, then the stops over the
// real controls. Once per member, on a computer; "Take the tour" (`/today?tour=1`) replays it.

import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { tourApi } from '../api/tour'
import { useLive } from '../apps/meetings/live/liveState'
import { inMacApp } from '../apps/today/weatherPlace'
import { org, product } from '../brand/product'
import { Dialog } from '../components/Dialog'
import { MOBILE_QUERY, useMediaQuery } from '../hooks/useMediaQuery'
import { runTour, stopTour } from './runTour'
import { findByTestId, presentStops, tourStops } from './stops'

/** The address that replays the tour (account menu, Command-K). */
export const TOUR_REPLAY = '/today?tour=1'

export function TourHost({
  ready,
  find = findByTestId,
}: {
  /** Today's tiles are on screen, so the stops can find their controls. */
  ready: boolean
  /** Finds a control by test id (tests stand in for the browser's layout). */
  find?: (testId: string) => Element | null
}) {
  const phone = useMediaQuery(MOBILE_QUERY)
  const live = useLive()
  const recording = live !== null && (live.state === 'recording' || live.state === 'paused')
  const [params, setParams] = useSearchParams()
  const replay = params.get('tour') === '1'
  const [welcome, setWelcome] = useState(false)
  const asked = useRef(false)

  // Leaving Today ends a running tour.
  useEffect(() => stopTour, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: asks once per visit, or once per replay
  useEffect(() => {
    if (!ready || phone || recording) return
    if (replay) {
      setParams(
        (p) => {
          p.delete('tour')
          return p
        },
        { replace: true },
      )
      stopTour()
      setWelcome(true)
      return
    }
    if (asked.current) return
    asked.current = true
    let cancelled = false
    tourApi.get().then(
      ({ seen }) => {
        if (!cancelled && !seen) setWelcome(true)
      },
      () => {
        // Can't tell: say nothing rather than show it twice.
      },
    )
    return () => {
      cancelled = true
    }
  }, [ready, phone, recording, replay])

  if (!welcome) return null

  // Any way out of the welcome counts as seen (T3); the server keeps it once.
  const seen = () => void tourApi.markSeen().catch(() => {})
  const notNow = () => {
    setWelcome(false)
    seen()
  }
  const start = () => {
    setWelcome(false)
    seen()
    const stops = presentStops(tourStops({ name: org() || product(), mac: inMacApp() }), find)
    void runTour(stops, find, () => {})
  }
  const name = org() || product()
  return (
    <Dialog title={`Welcome to ${name}`} onClose={notNow} testId="tour-welcome">
      <p className="text-sm text-ink-soft">
        Want a quick look around? It takes about a minute and a half, and you can watch it again any
        time from your account menu.
      </p>
      <div className="mt-5 flex justify-end gap-2">
        <button
          type="button"
          data-testid="tour-not-now"
          onClick={notNow}
          className="inline-flex h-9 items-center rounded-lg border border-ash-strong px-3 text-sm text-ink hover:border-ember"
        >
          Not now
        </button>
        <button
          type="button"
          data-testid="tour-start"
          onClick={start}
          className="inline-flex h-9 items-center rounded-lg bg-ember px-3 text-sm font-medium text-paper-raised hover:bg-ember-strong"
        >
          Show me around
        </button>
      </div>
    </Dialog>
  )
}
