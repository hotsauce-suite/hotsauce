// What the web app knows about the Chrome extension it hands out (docs/PLAN-extension-setup.md):
// the version this build's download carries, the Web Store listing once Google approves it, and
// whether this browser can run it at all.

declare const __EXTENSION_VERSION__: string | undefined

/** The version in /downloads/hotsauce-meetings-chrome.zip (vite.config.ts `define`); '' in tests. */
export const BUNDLED_EXTENSION_VERSION: string =
  typeof __EXTENSION_VERSION__ === 'string' ? __EXTENSION_VERSION__ : ''

/**
 * The Chrome Web Store listing. Null until Google approves it; then set it here and the page
 * offers Add to Chrome, with the by-hand install under it.
 */
export const CHROME_WEB_STORE_URL: string | null = null

/** Whether `installed` is an older version than `latest` (plain x.y.z; anything else: no). */
export function isOlder(installed: string, latest: string): boolean {
  const parse = (v: string) => (/^\d+(\.\d+)*$/.test(v) ? v.split('.').map(Number) : null)
  const a = parse(installed)
  const b = parse(latest)
  if (!a || !b) return false
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x < y
  }
  return false
}

/**
 * Chrome (or another Chromium browser that takes Chrome extensions) on a computer. Not phones,
 * tablets, Safari, Firefox or the Mac app's own window.
 */
export function canRunExtension(userAgent: string = navigator.userAgent): boolean {
  if (!/\bChrome\/\d+/.test(userAgent)) return false
  return !/Mobile|Android|CriOS|iPad|iPhone/.test(userAgent)
}
