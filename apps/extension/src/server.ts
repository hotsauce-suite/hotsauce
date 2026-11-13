// Which Hotsauce server this extension talks to. A copy downloaded from a server carries that
// server in server.json (the server writes it into the zip); a copy from the Chrome Web Store
// carries none and asks on first use. The person's own choice, saved in storage, always wins.

export interface Server {
  /** The server's origin, e.g. https://hotsauce.acme.com. */
  url: string
  /** What the organization calls it, e.g. Hotsauce. */
  name: string
}

export const DEFAULT_NAME = 'Hotsauce'

/**
 * The origin someone typed, or null with the reason. https only, except localhost; a bare host
 * gets https://.
 */
export function parseServerUrl(input: string): { url: string } | { error: string } {
  const raw = input.trim()
  if (!raw) return { error: 'Enter your server’s address.' }
  let url: URL
  try {
    url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`)
  } catch {
    return { error: 'That isn’t a web address.' }
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    return { error: 'The address must start with https://.' }
  }
  return { url: url.origin }
}

/** Pages that may talk to the extension: the server, and both dev ports on localhost. */
export function originsFor(serverUrl: string): string[] {
  const origin = new URL(serverUrl).origin
  if (new URL(origin).hostname !== 'localhost') return [origin]
  return [...new Set([origin, 'http://localhost:3000', 'http://localhost:5173'])]
}

/** Chrome match patterns for those pages (patterns carry no port). */
export function matchPatterns(serverUrl: string): string[] {
  return [
    ...new Set(
      originsFor(serverUrl).map((o) => `${new URL(o).protocol}//${new URL(o).hostname}/*`),
    ),
  ]
}

export function isServerPage(server: Server | null, url: string | undefined): boolean {
  if (!server || !url) return false
  try {
    return originsFor(server.url).includes(new URL(url).origin)
  } catch {
    return false
  }
}

const KEY = 'server'

/** The chosen server, else the one this copy was downloaded from, else null. */
export async function getServer(): Promise<Server | null> {
  const stored = (await chrome.storage.local.get(KEY))[KEY] as Server | undefined
  if (stored?.url) return stored
  try {
    const res = await fetch(chrome.runtime.getURL('server.json'))
    if (!res.ok) return null
    const body = (await res.json()) as Partial<Server>
    if (typeof body.url !== 'string') return null
    return { url: new URL(body.url).origin, name: body.name?.trim() || DEFAULT_NAME }
  } catch {
    return null
  }
}

/**
 * Connects to the server at `input`: asks Chrome for access to that site (call from a click),
 * checks it is a Hotsauce server, saves it, and runs the page bridge there.
 */
export async function connect(input: string): Promise<Server | { error: string }> {
  const parsed = parseServerUrl(input)
  if ('error' in parsed) return parsed
  const patterns = matchPatterns(parsed.url)
  const granted = await chrome.permissions.request({ origins: patterns })
  if (!granted) return { error: 'Chrome needs your OK to connect to that site.' }
  let name = DEFAULT_NAME
  try {
    const res = await fetch(new URL('/api/health', parsed.url))
    const body = (await res.json()) as { ok?: boolean; productName?: string }
    if (!res.ok || body.ok !== true) throw new Error('not ok')
    name = body.productName?.trim() || DEFAULT_NAME
  } catch {
    return { error: 'No Hotsauce server answered at that address.' }
  }
  const server = { url: parsed.url, name }
  await chrome.storage.local.set({ [KEY]: server })
  // The bridge runs on the server's pages so they can ask for a Meet tab's audio.
  await chrome.scripting.unregisterContentScripts({ ids: ['bridge'] }).catch(() => {})
  await chrome.scripting.registerContentScripts([
    { id: 'bridge', matches: patterns, js: ['bridge.js'], runAt: 'document_start' },
  ])
  return server
}
