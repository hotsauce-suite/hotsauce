// "Save page" sends the page as the person sees it (docs/PLAN-links-page-copy.md): signed in,
// past a paywall, built by its scripts. The worker runs `pageCopy` in the tab and hands the copy
// to the save tab it opens; the server reads it like a fetched page.

/** The server sets aside copies over this (UTF-8 bytes) and fetches the page instead. */
export const MAX_PAGE_BYTES = 2 * 1024 * 1024

/** A page copy waiting for its save tab, in session storage under `pageKey(saveTabId)`. */
export function pageKey(saveTabId: number): string {
  return `page-${saveTabId}`
}

/**
 * The rendered page as HTML, without what a readable copy never uses (scripts, styles, frames,
 * media); null when it's still over `maxBytes` after dropping inline styles too.
 *
 * It runs inside the page through `chrome.scripting.executeScript`, which sends only the function's
 * own source: it must not use anything from outside its body.
 */
export function pageCopy(maxBytes: number, doc: Document = document): string | null {
  const root = doc.documentElement.cloneNode(true) as Element
  const drop =
    'script, style, noscript, template, iframe, frame, frameset, object, embed, svg, canvas, video, audio, link'
  for (const el of Array.from(root.querySelectorAll(drop))) el.remove()
  const size = (s: string) => new TextEncoder().encode(s).length
  let html = `<!doctype html>\n${root.outerHTML}`
  if (size(html) > maxBytes) {
    for (const el of Array.from(root.querySelectorAll('[style], [srcset]'))) {
      el.removeAttribute('style')
      el.removeAttribute('srcset')
    }
    html = `<!doctype html>\n${root.outerHTML}`
  }
  return size(html) <= maxBytes ? html : null
}
