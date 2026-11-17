/**
 * The Mac app's own update, asked from Settings → Apps inside the app (apps/dictate-mac
 * UpdateBridge, docs/PLAN-mac-self-update.md U7, U8). 'state' says where it stands; 'install'
 * quits the app, swaps in the ready build and reopens it. Older apps have no bridge.
 */
export type MacUpdateState = 'none' | 'available' | 'downloading' | 'ready'

export interface MacUpdate {
  state: MacUpdateState
  version: string | null
}

interface Handler {
  postMessage(message: unknown): Promise<unknown> | undefined
}

function bridge(): Handler | undefined {
  return (window as { webkit?: { messageHandlers?: Record<string, Handler> } }).webkit
    ?.messageHandlers?.hotsauceMacUpdate
}

/** Whether this Mac app can update itself. */
export function hasMacUpdate(): boolean {
  return Boolean(bridge())
}

const STATES: readonly MacUpdateState[] = ['none', 'available', 'downloading', 'ready']

async function ask(request: 'state' | 'install'): Promise<MacUpdate | null> {
  try {
    const reply = (await bridge()?.postMessage(request)) as
      | { state?: unknown; version?: unknown }
      | null
      | undefined
    if (!reply || !STATES.includes(reply.state as MacUpdateState)) return null
    return {
      state: reply.state as MacUpdateState,
      version: typeof reply.version === 'string' ? reply.version : null,
    }
  } catch {
    return null
  }
}

export function macUpdateState(): Promise<MacUpdate | null> {
  return ask('state')
}

/** Restarts the app into the ready update (it quits, so the reply may never come). */
export function installMacUpdate(): Promise<MacUpdate | null> {
  return ask('install')
}
