// The first-run tour's seen flag (docs/PLAN-tour-and-101.md S1, S2, T7). Tests start with it seen,
// so the welcome card stays out of every other test's way; the live demo starts unseen and keeps
// the answer in this browser, so a visitor sees the tour once.

import { HttpResponse, http } from 'msw'

const DEMO_KEY = 'hotsauce:demo-tour-seen'

/** 'seen' and 'unseen' are in memory; 'browser' is kept in localStorage (the demo). */
export type TourMode = 'seen' | 'unseen' | 'browser'

export interface FakeTour {
  seen: boolean
}

function readBrowser(): boolean {
  try {
    return window.localStorage.getItem(DEMO_KEY) === '1'
  } catch {
    return false
  }
}

function writeBrowser(): void {
  try {
    window.localStorage.setItem(DEMO_KEY, '1')
  } catch {
    // Private window: the tour may show again next visit, which is harmless.
  }
}

export function tourHandlers(mode: TourMode) {
  const tour: FakeTour = { seen: mode === 'browser' ? readBrowser() : mode === 'seen' }
  const handlers = [
    http.get('/api/tour', () => HttpResponse.json({ seen: tour.seen })),
    http.post('/api/tour/seen', () => {
      tour.seen = true
      if (mode === 'browser') writeBrowser()
      return HttpResponse.json({ seen: true })
    }),
  ]
  return { tour, handlers }
}
