// The Mac app's sign-in through the browser (ARCHITECTURE §9.4.1). The app opens
// /desktop/connect?state=<nonce> in the default browser; once the member confirms, the page asks
// the server for a one-time ticket and hands it back to the app through its URL scheme. The app
// checks the nonce is the one it sent, then opens /desktop/finish in its own window, which asks the
// app for the ticket over a script bridge: never from its URL, so no link can supply a ticket.

/** The Mac app's URL scheme (apps/dictate-mac/Sources/DictateCore/Brand.swift). */
export const DESKTOP_SCHEME = 'hearth'

/** The app's nonce: random, URL-safe, and long enough not to guess. */
export function isDesktopState(state: string | null): state is string {
  return state !== null && /^[A-Za-z0-9_-]{32,128}$/.test(state)
}

/** Where the browser sends the ticket: back to the app, which checks the state. */
export function desktopCallback(state: string, ticket: string): string {
  const params = new URLSearchParams({ state, ticket })
  return `${DESKTOP_SCHEME}://auth/callback?${params.toString()}`
}

/** The ticket the Mac app received, handed over once; null outside the app or with none waiting. */
export async function takeDesktopTicket(): Promise<string | null> {
  const handlers = (
    window as { webkit?: { messageHandlers?: Record<string, { postMessage(m: string): unknown }> } }
  ).webkit?.messageHandlers
  const bridge = handlers?.hearthTicket
  if (!bridge) return null
  const ticket = await bridge.postMessage('take')
  return typeof ticket === 'string' && ticket.length > 0 && ticket.length <= 4096 ? ticket : null
}

/** A sign-in page to return to after signing in: a path on this site, nothing else. */
export function safeReturnPath(from: string | undefined): string {
  return from?.startsWith('/') && !from.startsWith('//') && !from.includes('\\') ? from : '/today'
}

/** The bridge the Mac app adds to its window: present only inside the app. */
interface DesktopBridge {
  postMessage(message: string): void
}

export function desktopSignInBridge(): DesktopBridge | null {
  const handlers = (window as { webkit?: { messageHandlers?: Record<string, DesktopBridge> } })
    .webkit?.messageHandlers
  return handlers?.hearthSignIn ?? null
}
