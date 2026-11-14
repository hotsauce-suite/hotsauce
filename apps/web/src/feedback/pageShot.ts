// A picture of the page a member was on when they opened Send feedback
// (docs/PLAN-feedback-screenshots.md S5). It lives in memory only, never in storage, and is attached
// only if the member taps it on the form.

/** Opening Send feedback never waits longer than this for the picture. */
export const PAGE_SHOT_WAIT_MS = 1500
/** A picture older than this isn't offered (the member wandered off and came back). */
const FRESH_MS = 10 * 60_000

let held: { blob: Blob; from: string; at: number } | null = null
let attempt = 0

/** Send feedback, remembering the page it was opened from. */
export function feedbackLink(pathname: string): string {
  return pathname === '/feedback' ? '/feedback' : `/feedback?from=${encodeURIComponent(pathname)}`
}

/** The picture taken on `from`, if there is a fresh one. Reading it doesn't use it up. */
export function pageShot(from: string | undefined): Blob | null {
  if (!held || from === undefined || held.from !== from) return null
  return Date.now() - held.at < FRESH_MS ? held.blob : null
}

export function clearPageShot(): void {
  held = null
  attempt++
}

type Capture = () => Promise<Blob | null>

/**
 * Pictures the page, waiting at most PAGE_SHOT_WAIT_MS. A picture that comes later is thrown away:
 * by then the next page is drawing and the picture would show half of each.
 */
export async function capturePage(capture: Capture = pictureOfPage, from = location.pathname) {
  clearPageShot()
  const mine = attempt
  let late = false
  const shot = capture().then(
    (blob) => {
      if (!late && mine === attempt && blob) held = { blob, from, at: Date.now() }
    },
    (err: unknown) => {
      console.warn('Send feedback: could not picture the page', err)
    },
  )
  let timer: ReturnType<typeof setTimeout> | undefined
  const waited = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, PAGE_SHOT_WAIT_MS)
  })
  await Promise.race([shot, waited])
  clearTimeout(timer)
  late = true
}

/** Every Send feedback entry: picture the page, then open the form from it. */
export async function openFeedback(
  navigate: (to: string) => void,
  pathname: string,
  capture: Capture = pictureOfPage,
): Promise<void> {
  if (pathname === '/feedback') {
    navigate('/feedback')
    return
  }
  await capturePage(capture, pathname)
  navigate(feedbackLink(pathname))
}

/**
 * The click handler for a Send feedback link: a plain click pictures the page first; a click that
 * opens a new tab or window goes through as an ordinary link.
 */
export function onFeedbackClick(navigate: (to: string) => void, pathname: string) {
  return (event: {
    defaultPrevented: boolean
    button: number
    metaKey: boolean
    ctrlKey: boolean
    shiftKey: boolean
    altKey: boolean
    preventDefault: () => void
  }) => {
    if (event.defaultPrevented || event.button !== 0) return
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    void openFeedback(navigate, pathname)
  }
}

/** Waits for a menu or sheet that was just closed to leave the screen. */
const nextFrame = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  )

/** The visible page as a PNG, at most 2000 px wide. The library is loaded only when needed. */
async function pictureOfPage(): Promise<Blob | null> {
  await nextFrame()
  const { domToBlob } = await import('modern-screenshot')
  const width = document.documentElement.clientWidth
  const height = document.documentElement.clientHeight
  return domToBlob(document.body, {
    width,
    height,
    scale: Math.min(window.devicePixelRatio || 1, 2000 / Math.max(width, 1)),
    type: 'image/png',
    // The page's paper colour sits on <body> under a grain texture (an SVG noise filter) that the
    // picture draws as solid black, so the picture keeps the colour and leaves the texture out.
    backgroundColor: getComputedStyle(document.body).backgroundColor,
    style: { backgroundImage: 'none', margin: '0' },
    // Videos and pictures from other sites may come out blank; that's accepted.
    timeout: PAGE_SHOT_WAIT_MS,
  })
}
