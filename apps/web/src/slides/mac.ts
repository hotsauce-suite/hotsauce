// The Mac app's side of a slide show (docs/PLAN-slides.md R11). The app says how many displays
// there are (`window.hotsauceMacDisplays`, kept current), puts the slides window full screen on
// the external one when the page opens it, and makes its own window full screen on request.

interface Handler {
  postMessage: (body: unknown) => void
}

declare global {
  interface Window {
    /** Set by the Mac app: how many displays the Mac has now. */
    hotsauceMacDisplays?: number
    /** What the Mac app's View → Present calls on the open doc. */
    hotsaucePresent?: (() => void) | undefined
  }
}

function handler(): Handler | null {
  const w = window as { webkit?: { messageHandlers?: Record<string, Handler | undefined> } }
  return w.webkit?.messageHandlers?.hotsauceSlides ?? null
}

/** In the Mac app: how many displays it has; null in a browser. */
export function macDisplays(): number | null {
  if (!handler()) return null
  return typeof window.hotsauceMacDisplays === 'number' ? window.hotsauceMacDisplays : 1
}

/** Asks the Mac app to make its window full screen, or to put it back as it was. */
export function macFullScreen(on: boolean): boolean {
  const mac = handler()
  if (!mac) return false
  mac.postMessage({ fullScreen: on })
  return true
}

/** Offers the open doc to the Mac app's View → Present until the returned function is called. */
export function offerToMacPresent(present: () => void): () => void {
  window.hotsaucePresent = present
  return () => {
    if (window.hotsaucePresent === present) window.hotsaucePresent = undefined
  }
}
