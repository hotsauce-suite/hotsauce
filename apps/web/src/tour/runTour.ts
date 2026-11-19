// Runs the tour's stops over the real controls with Driver.js (MIT), loaded only now so the tour
// costs nothing on an everyday page load (docs/PLAN-tour-and-101.md T5).

import type { TourStop } from './stops'

/** Stops a running tour, if any (a replay while one runs, or leaving Today). */
let stopCurrent: (() => void) | null = null

export function stopTour(): void {
  stopCurrent?.()
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/**
 * Walks `stops` in order; `onEnd` runs once however it ends (Done, Skip, Esc, or the page going
 * away). Driver.js handles Next, Back, the arrow keys and Esc.
 */
export async function runTour(
  stops: readonly TourStop[],
  find: (testId: string) => Element | null,
  onEnd: () => void,
): Promise<void> {
  stopTour()
  if (stops.length === 0) {
    onEnd()
    return
  }
  const [{ driver }] = await Promise.all([import('driver.js'), import('driver.js/dist/driver.css')])
  await import('./tour.css')
  const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  let ended = false
  const tour = driver({
    animate: !still,
    smoothScroll: !still,
    allowClose: true,
    allowKeyboardControl: true,
    overlayClickBehavior: 'none',
    showProgress: true,
    progressText: '{{current}} of {{total}}',
    nextBtnText: 'Next',
    prevBtnText: 'Back',
    doneBtnText: 'Done',
    closeBtnLabel: 'Skip the tour',
    popoverClass: 'hotsauce-tour',
    stagePadding: 6,
    stageRadius: 10,
    showButtons: ['next', 'previous', 'close'],
    onPopoverRender: (popover) => {
      popover.wrapper.setAttribute('data-testid', 'tour-stop')
      popover.wrapper.setAttribute('role', 'dialog')
      popover.wrapper.setAttribute('aria-modal', 'true')
      popover.wrapper.setAttribute('aria-labelledby', 'driver-popover-title')
      popover.nextButton.setAttribute('data-testid', 'tour-next')
      popover.previousButton.setAttribute('data-testid', 'tour-back')
      popover.closeButton.setAttribute('data-testid', 'tour-skip')
      // The reader hears the stop, and Enter moves on.
      popover.nextButton.focus()
    },
    onDestroyed: () => {
      if (stopCurrent === stop) stopCurrent = null
      if (ended) return
      ended = true
      onEnd()
    },
    steps: stops.map((s) => {
      const popover = { title: escapeHtml(s.title), description: escapeHtml(s.body) }
      const target = s.target
      return target === null
        ? { data: { id: s.id }, popover }
        : { element: () => find(target) ?? document.body, data: { id: s.id }, popover }
    }),
  })
  const stop = () => tour.destroy()
  stopCurrent = stop
  tour.drive()
}
