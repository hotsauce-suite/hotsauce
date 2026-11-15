import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { cleanClientName, MAX_REDIRECT_URIS, type OAuthClient, validRedirectUri } from './store.js'

const MAX_BYTES = 16 * 1024
const TIMEOUT_MS = 5000
const CACHE_MS = 60 * 60 * 1000

export type ResolveHost = (host: string) => Promise<string[]>

const resolveHost: ResolveHost = async (host) =>
  (await lookup(host, { all: true })).map((a) => a.address)

/** True for an address a server must never be made to fetch: loopback, private, link-local. */
export function isPrivateAddress(address: string): boolean {
  const v4 = address.startsWith('::ffff:') ? address.slice(7) : address
  if (isIP(v4) === 4) {
    const [a = 0, b = 0] = v4.split('.').map(Number)
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    )
  }
  const v6 = address.toLowerCase()
  return (
    v6 === '::' ||
    v6 === '::1' ||
    v6.startsWith('fc') ||
    v6.startsWith('fd') ||
    v6.startsWith('fe80') ||
    v6.startsWith('ff')
  )
}

/** A `client_id` that is a metadata document's URL rather than an id registered here. */
export function isMetadataUrl(clientId: string): boolean {
  return clientId.startsWith('https://')
}

/**
 * Client ID metadata documents (the MCP 2025-11-25 way, used by ChatGPT): the `client_id` is an
 * https URL whose JSON names the client and its redirect URIs. Fetched without redirects, small,
 * quick, and never from a private address, then cached for an hour.
 */
export class ClientMetadataResolver {
  readonly #fetch: typeof fetch
  readonly #resolve: ResolveHost
  readonly #cache = new Map<string, { client: OAuthClient; until: number }>()

  constructor(opts: { fetch?: typeof fetch; resolveHost?: ResolveHost } = {}) {
    this.#fetch = opts.fetch ?? fetch
    this.#resolve = opts.resolveHost ?? resolveHost
  }

  /** The client the document describes, or null when it can't be used (the reason is logged). */
  async resolve(clientId: string): Promise<OAuthClient | null> {
    const cached = this.#cache.get(clientId)
    if (cached && cached.until > Date.now()) return cached.client
    try {
      const client = await this.#load(clientId)
      this.#cache.set(clientId, { client, until: Date.now() + CACHE_MS })
      return client
    } catch (err) {
      console.warn(`oauth: client metadata ${clientId} refused: ${(err as Error).message}`)
      return null
    }
  }

  async #load(clientId: string): Promise<OAuthClient> {
    const url = new URL(clientId)
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
      throw new Error('not a plain https URL')
    }
    if (url.port !== '' && url.port !== '443') throw new Error('not on port 443')
    const host = url.hostname.replace(/^\[|\]$/g, '')
    if (isIP(host) !== 0 || host === 'localhost' || host.endsWith('.localhost')) {
      throw new Error('the host must be a public name')
    }
    const addresses = await this.#resolve(host)
    if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
      throw new Error('the host resolves to a private address')
    }
    const res = await this.#fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: 'application/json' },
    })
    if (res.status !== 200) throw new Error(`answered ${res.status}`)
    const text = await readCapped(res)
    const doc = JSON.parse(text) as Record<string, unknown>
    if (doc.client_id !== clientId) throw new Error('client_id in the document does not match')
    const uris = doc.redirect_uris
    if (
      !Array.isArray(uris) ||
      uris.length === 0 ||
      uris.length > MAX_REDIRECT_URIS ||
      !uris.every((u): u is string => typeof u === 'string' && validRedirectUri(u))
    ) {
      throw new Error('redirect_uris are missing or not allowed')
    }
    return {
      id: clientId,
      name: cleanClientName(doc.client_name, url.hostname),
      redirectUris: uris,
    }
  }
}

async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_BYTES) {
      await reader.cancel()
      throw new Error('the document is too large')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}
