import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import { request } from 'node:https'
import { BlockList, isIP } from 'node:net'
import { cleanClientName, MAX_REDIRECT_URIS, type OAuthClient, validRedirectUri } from './store.js'

const MAX_BYTES = 16 * 1024
const TIMEOUT_MS = 5000
const CACHE_MS = 60 * 60 * 1000

/**
 * Every address a server must never be made to fetch: anything not plain public unicast
 * (IANA special-purpose registries), including IPv4 hidden inside IPv6 forms.
 */
const blocked = new BlockList()
for (const [net, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
] as const) {
  blocked.addSubnet(net, bits, 'ipv4')
}
for (const [net, bits] of [
  ['::', 96], // unspecified, loopback and the old IPv4-compatible ::a.b.c.d
  ['::ffff:0:0:0', 96], // IPv4-translated
  ['64:ff9b::', 96], // NAT64
  ['64:ff9b:1::', 48],
  ['100::', 64], // discard
  ['2001::', 23], // IETF protocol assignments, Teredo
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // old site-local
  ['ff00::', 8], // multicast
] as const) {
  blocked.addSubnet(net, bits, 'ipv6')
}

/** True for an address a server must never be made to fetch: loopback, private, link-local… */
export function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) return blocked.check(address, 'ipv4')
  if (isIP(address) !== 6) return true
  const v4 = mappedIPv4(address)
  // A BlockList checks IPv4 addresses against IPv4-mapped rules too, so the mapped range has
  // no rule of its own: the address inside it is checked instead.
  return v4 ? blocked.check(v4, 'ipv4') : blocked.check(address, 'ipv6')
}

/** The IPv4 address inside an IPv4-mapped IPv6 address (`::ffff:a.b.c.d` or `::ffff:7f00:1`). */
function mappedIPv4(address: string): string | null {
  const lower = address.toLowerCase()
  const dotted = /^(?:0{0,4}:){0,5}:?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower)?.[1]
  if (dotted) return dotted
  const hex = /^(?:0{0,4}:){0,5}:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower)
  if (!hex?.[1] || !hex[2]) return null
  const hi = Number.parseInt(hex[1], 16)
  const lo = Number.parseInt(hex[2], 16)
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`
}

/** A `client_id` that is a metadata document's URL rather than an id registered here. */
export function isMetadataUrl(clientId: string): boolean {
  return clientId.startsWith('https://')
}

type Lookup = (
  host: string,
  opts: { all: true },
  cb: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void

/**
 * A DNS lookup that refuses private answers. Used as the socket's own lookup, so the address
 * checked is the one connected to: a name can't answer public for a check and private for the
 * fetch (DNS rebinding).
 */
export function guardedLookup(lookup: Lookup = dnsLookup as unknown as Lookup) {
  return (
    host: string,
    opts: { all?: boolean },
    cb: (
      err: NodeJS.ErrnoException | null,
      address: string | LookupAddress[],
      family?: number,
    ) => void,
  ) => {
    lookup(host, { all: true }, (err, addresses) => {
      if (err) return cb(err, '')
      if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) {
        return cb(
          Object.assign(new Error(`${host} resolves to a private address`), { code: 'EPRIVATE' }),
          '',
        )
      }
      if (opts.all) return cb(null, addresses)
      const [first] = addresses
      return cb(null, first?.address ?? '', first?.family)
    })
  }
}

/** Fetches a small JSON document: no redirects, a time limit and a size limit. */
export type GetDocument = (url: URL) => Promise<{ status: number; body: string }>

const getDocument: GetDocument = (url) =>
  new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: 'GET',
        headers: { accept: 'application/json' },
        lookup: guardedLookup() as never,
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (chunk: Buffer) => {
          size += chunk.byteLength
          if (size > MAX_BYTES) {
            req.destroy(new Error('the document is too large'))
            return
          }
          chunks.push(chunk)
        })
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        )
        res.on('error', reject)
      },
    )
    req.on('timeout', () => req.destroy(new Error('timed out')))
    req.on('error', reject)
    req.end()
  })

/**
 * Client ID metadata documents (the MCP 2025-11-25 way, used by ChatGPT): the `client_id` is an
 * https URL whose JSON names the client and its redirect URIs. Fetched without redirects, small,
 * quick, and never from a private address, then cached for an hour.
 */
export class ClientMetadataResolver {
  readonly #get: GetDocument
  readonly #cache = new Map<string, { client: OAuthClient; until: number }>()

  constructor(opts: { get?: GetDocument } = {}) {
    this.#get = opts.get ?? getDocument
  }

  /** The client the document describes, or null when it can't be used (the reason is logged). */
  async resolve(clientId: string): Promise<OAuthClient | null> {
    const cached = this.#cache.get(clientId)
    if (cached && cached.until > Date.now()) return cached.client
    try {
      const client = await this.#load(clientId)
      if (this.#cache.size > 1000) this.#cache.clear()
      this.#cache.set(clientId, { client, until: Date.now() + CACHE_MS })
      return client
    } catch (err) {
      console.warn(
        `oauth: client metadata ${clientId.slice(0, 200)} refused: ${(err as Error).message}`,
      )
      return null
    }
  }

  async #load(clientId: string): Promise<OAuthClient> {
    if (clientId.length > 2000) throw new Error('the URL is too long')
    const url = new URL(clientId)
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
      throw new Error('not a plain https URL')
    }
    if (url.port !== '' && url.port !== '443') throw new Error('not on port 443')
    const host = url.hostname.replace(/^\[|\]$/g, '')
    if (isIP(host) !== 0 || host === 'localhost' || host.endsWith('.localhost')) {
      throw new Error('the host must be a public name')
    }
    const res = await this.#get(url)
    if (res.status !== 200) throw new Error(`answered ${res.status}`)
    if (Buffer.byteLength(res.body) > MAX_BYTES) throw new Error('the document is too large')
    const doc = JSON.parse(res.body) as Record<string, unknown>
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
