// The slides window that presenter view drives (docs/PLAN-slides.md R6). It is a blank window of
// the same origin: the page copies its styles and look into it and renders the slides there with
// a React portal, so both windows share one state. The Mac app recognises its address and puts
// it full screen on the external display (SuiteWindow's createWebViewWith).

export const AUDIENCE_URL = 'about:blank#hotsauce-slides'
const AUDIENCE_NAME = 'hotsauce-slides'

export interface Audience {
  win: Window
  /** Where the slides render. */
  root: HTMLElement
}

/** Opens (or reuses) the slides window; null when the browser blocked it. */
export function openAudience(title: string): Audience | null {
  const features = 'popup,width=1280,height=760'
  let win: Window | null = null
  try {
    win = window.open(AUDIENCE_URL, AUDIENCE_NAME, features)
  } catch {
    win = null
  }
  if (!win) return null
  const doc = win.document
  doc.title = title
  // The page's look: its stylesheets, theme attributes and brand variables.
  doc.head.replaceChildren()
  const charset = doc.createElement('meta')
  charset.setAttribute('charset', 'utf-8')
  doc.head.append(charset)
  for (const node of document.head.querySelectorAll('style, link[rel="stylesheet"]')) {
    const copy = node.cloneNode(true) as HTMLElement
    // A relative stylesheet address would resolve against about:blank.
    if (copy instanceof HTMLLinkElement) copy.href = (node as HTMLLinkElement).href
    doc.head.append(copy)
  }
  for (const attr of document.documentElement.attributes) {
    doc.documentElement.setAttribute(attr.name, attr.value)
  }
  doc.body.replaceChildren()
  doc.body.className = 'slides-stage'
  doc.body.style.margin = '0'
  doc.body.style.height = '100vh'
  doc.body.style.overflow = 'hidden'
  const root = doc.createElement('div')
  root.style.height = '100%'
  doc.body.append(root)
  return { win, root }
}
