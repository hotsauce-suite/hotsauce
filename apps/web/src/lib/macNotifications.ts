/**
 * Notifications inside the Mac app's window. Its web view has no Notification API, so the page
 * asks the app (apps/dictate-mac NotificationsBridge): 'state' is what macOS allows, 'open' asks
 * macOS the first time and otherwise opens System Settings → Notifications for the app.
 */
export type MacNotificationState = 'on' | 'off' | 'undecided'

interface Handler {
  postMessage(message: unknown): Promise<unknown> | undefined
}

function bridge(): Handler | undefined {
  return (window as { webkit?: { messageHandlers?: Record<string, Handler> } }).webkit
    ?.messageHandlers?.hearthNotifications
}

/** Whether this page is in a Mac app that can answer (0.12.6 and later). */
export function hasMacNotifications(): boolean {
  return Boolean(bridge())
}

async function ask(request: 'state' | 'open'): Promise<MacNotificationState | null> {
  try {
    const reply = await bridge()?.postMessage(request)
    return reply === 'on' || reply === 'off' || reply === 'undecided' ? reply : null
  } catch {
    return null
  }
}

/** What macOS allows the app right now; null when the app doesn't say. */
export function macNotificationState(): Promise<MacNotificationState | null> {
  return ask('state')
}

/** macOS's prompt the first time, else the app's page in System Settings; then the state. */
export function openMacNotifications(): Promise<MacNotificationState | null> {
  return ask('open')
}
