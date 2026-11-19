// Runs the tour's stops over the real controls with Driver.js (MIT), loaded only now so the tour
// costs nothing on an everyday page load (docs/PLAN-tour-and-101.md T5).

import type { TourStop } from './stops'

/** Stops a running tour, if any (a replay while one runs, or leaving Today). */
let stopCurrent: (() => void) | null = null

export function stopTour(): void {
  stopCurrent?.()
}

/** Another dialog (⌘K, Ask, a menu) is open over the page: the tour leaves the keys to it. */
function otherDialogOpen(): boolean {
  return [...document.querySelectorAll('[role="dialog"], dialog[open]')].some(
    (el) => !el.classList.contains('driver-popover') && el.getClientRects().length > 0,
  )
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
  // Leaving Today while Driver loads cancels the tour before it starts.
  let cancelled = false
  const cancel = () => {
    cancelled = true
  }
  stopCurrent = cancel
  const [{ driver }] = await Promise.all([import('driver.js'), import('driver.js/dist/driver.css')])
  await import('./tour.css')
  if (cancelled) {
    onEnd()
    return
  }
  const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  let ended = false
  const tour = driver({
    animate: !still,
    smoothScroll: !still,
    allowClose: true,
    // Driver's own keys listen on the window; ours check first that no other dialog has them.
    allowKeyboardControl: false,
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
      // The reader hears the stop, and Enter moves on. Driver focuses the popover's first
      // button (Skip) after this hook, so Next takes focus on the next frame.
      requestAnimationFrame(() => popover.nextButton.focus())
    },
    onDestroyed: () => {
      removeEventListener('keydown', onKey, true)
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
  function onKey(e: KeyboardEvent) {
    if (otherDialogOpen()) return
    if (e.key === 'Escape') tour.destroy()
    else if (e.key === 'ArrowRight') tour.isLastStep() ? tour.destroy() : tour.moveNext()
    else if (e.key === 'ArrowLeft') tour.movePrevious()
    else return
    e.preventDefault()
    e.stopPropagation()
  }
  const stop = () => tour.destroy()
  stopCurrent = stop
  addEventListener('keydown', onKey, true)
  tour.drive()
}
