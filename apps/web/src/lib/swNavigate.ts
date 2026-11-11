// A meeting reminder clicked while Hearth is already open (public/push-sw.js): the service worker
// focuses the tab and asks it to go to the reminder's page. The tab moves in-app, because a full
// page load would end a meeting being recorded there.

export const NAVIGATE_MESSAGE = 'hearth:navigate'

type Container = Pick<ServiceWorkerContainer, 'addEventListener'>

/** Follows the service worker's navigate messages with `navigate` (the router's). */
export function followServiceWorkerNavigation(
  container: Container | undefined,
  navigate: (to: string) => void,
): void {
  container?.addEventListener('message', (event) => {
    const data = (event as MessageEvent).data as { type?: unknown; url?: unknown } | null
    if (data?.type !== NAVIGATE_MESSAGE || typeof data.url !== 'string') return
    let url: URL
    try {
      url = new URL(data.url, window.location.origin)
    } catch {
      return
    }
    if (url.origin !== window.location.origin) return
    navigate(url.pathname + url.search + url.hash)
  })
}
