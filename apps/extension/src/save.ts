// "Save to Hearth": the pure parts. The service worker opens Hearth's save page for a page or a
// link in a background tab; that page tells the worker (through the bridge) once it has saved,
// and the worker closes the tab.

/** Which pages can be saved: web pages, not Chrome's own or Hearth itself. */
export function savable(url: string | undefined, hearthOrigins: readonly string[]): boolean {
  if (!url) return false
  try {
    const u = new URL(url)
    return (u.protocol === 'http:' || u.protocol === 'https:') && !hearthOrigins.includes(u.origin)
  } catch {
    return false
  }
}

/** Hearth's save page for `page`. */
export function savePageUrl(hearthUrl: string, page: { url: string; title?: string }): string {
  const url = new URL('/links/save', hearthUrl)
  url.searchParams.set('url', page.url)
  const title = page.title?.replace(/\s+/g, ' ').trim()
  if (title) url.searchParams.set('title', title.slice(0, 300))
  url.searchParams.set('via', 'extension')
  return url.toString()
}

/** A save tab the worker opened, and the tab the person was on. */
export interface SaveTab {
  saveTabId: number
  fromTabId: number | null
  at: number
}

/** Save tabs older than this are forgotten. */
export const SAVE_TAB_TTL_MS = 10 * 60_000

export function rememberSaveTab(list: SaveTab[], entry: SaveTab): SaveTab[] {
  return [
    ...list.filter((s) => s.saveTabId !== entry.saveTabId && entry.at - s.at < SAVE_TAB_TTL_MS),
    entry,
  ]
}

/** The entry for `tabId` and the list without it; null when the worker didn't open that tab. */
export function takeSaveTab(
  list: SaveTab[],
  tabId: number,
): { entry: SaveTab | null; rest: SaveTab[] } {
  const entry = list.find((s) => s.saveTabId === tabId) ?? null
  return { entry, rest: list.filter((s) => s.saveTabId !== tabId) }
}
