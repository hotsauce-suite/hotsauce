// Fetching a saved link's page (ARCHITECTURE §23.2). The address comes from a member, so the
// server must never be talked into reading its own network: every address a name resolves to has
// to be public, the connection goes to the address that was checked (no DNS rebinding), and every
// redirect is checked the same way.

import dns from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import zlib from 'node:zlib'

export const FETCH_TIMEOUT_MS = 15_000
/** The page's HTML after decompression; parsing runs on the main thread, so it stays small. */
export const MAX_PAGE_BYTES = 2 * 1024 * 1024
export const MAX_REDIRECTS = 5
const PORTS = new Set(['', '80', '443', '8080', '8443'])
const TYPES = ['text/html', 'application/xhtml+xml', 'text/plain']

/** A fetch that failed, with a message for the member. */
export class LinkFetchError extends Error {
  override readonly name = 'LinkFetchError'
}

export interface FetchedPage {
  /** Where the page ended up, after redirects. */
  url: string
  contentType: string
  text: string
}

export type PageFetcher = (url: string) => Promise<FetchedPage>

const BLOCKED = new net.BlockList()
for (const [net4, bits] of [
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
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  BLOCKED.addSubnet(net4, bits, 'ipv4')
}
for (const [net6, bits] of [
  ['2001:db8::', 32], // documentation
  ['2001::', 32], // Teredo, which carries an IPv4 address
  ['2002::', 16], // 6to4, likewise
] as const) {
  BLOCKED.addSubnet(net6, bits, 'ipv6')
}
const GLOBAL_V6 = new net.BlockList()
GLOBAL_V6.addSubnet('2000::', 3, 'ipv6')

/** The IPv4 address inside an IPv4-mapped or NAT64 IPv6 address, else null. */
function embeddedV4(ip: string): string | null {
  const lower = ip.toLowerCase()
  const m = /^(?:::ffff:|64:ff9b::)(?:0:)?(\d+\.\d+\.\d+\.\d+)$/.exec(lower)
  if (m?.[1]) return m[1]
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower)
  if (hex?.[1] && hex[2]) {
    const a = Number.parseInt(hex[1], 16)
    const b = Number.parseInt(hex[2], 16)
    return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`
  }
  return null
}

/** True for an address on the public internet: not loopback, private, link-local or reserved. */
export function isPublicAddress(ip: string): boolean {
  const family = net.isIP(ip)
  if (family === 4) return !BLOCKED.check(ip, 'ipv4')
  if (family !== 6) return false
  const v4 = embeddedV4(ip)
  if (v4 !== null) return isPublicAddress(v4)
  // Only global unicast (2000::/3) is public; that leaves out ::1, ::, fc00::/7, fe80::/10, ff00::/8.
  return GLOBAL_V6.check(ip, 'ipv6') && !BLOCKED.check(ip, 'ipv6')
}

export type Resolve = (host: string) => Promise<Array<{ address: string; family: number }>>

const systemResolve: Resolve = (host) => dns.lookup(host, { all: true, verbatim: true })

/** The one public address to connect to for `host`; throws when any of its addresses isn't public. */
export async function publicAddressOf(
  host: string,
  resolve: Resolve = systemResolve,
  allowed: (ip: string) => boolean = isPublicAddress,
): Promise<{ address: string; family: number }> {
  const bare = host.replace(/^\[|\]$/g, '')
  if (net.isIP(bare)) {
    if (!allowed(bare)) throw new LinkFetchError('Only pages on the public web can be read')
    return { address: bare, family: net.isIP(bare) }
  }
  let found: Array<{ address: string; family: number }>
  try {
    found = await resolve(bare)
  } catch {
    throw new LinkFetchError(`Couldn’t find the site ${bare}`)
  }
  if (found.length === 0) throw new LinkFetchError(`Couldn’t find the site ${bare}`)
  if (found.some((a) => !allowed(a.address))) {
    throw new LinkFetchError('Only pages on the public web can be read')
  }
  return found[0] as { address: string; family: number }
}

interface RawResponse {
  status: number
  headers: http.IncomingHttpHeaders
  body: Buffer
}

export interface FetchOptions {
  resolve?: Resolve
  timeoutMs?: number
  maxBytes?: number
  userAgent?: string
  /** Which addresses may be connected to; public ones only, unless a test says otherwise. */
  allowed?: (ip: string) => boolean
  /** Which ports may be connected to; the usual web ones unless a test says otherwise. */
  ports?: ReadonlySet<string>
}

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 (compatible; saved-links)'

/** Fetches a page the safe way (see the top of this file). Throws `LinkFetchError`. */
export async function fetchPage(raw: string, opts: FetchOptions = {}): Promise<FetchedPage> {
  const deadline = Date.now() + (opts.timeoutMs ?? FETCH_TIMEOUT_MS)
  let url = parseWebUrl(raw, opts.ports)
  for (let hop = 0; ; hop++) {
    const res = await requestOnce(url, deadline, opts)
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      if (hop >= MAX_REDIRECTS) throw new LinkFetchError('The page redirects too many times')
      url = parseWebUrl(new URL(res.headers.location, url).toString(), opts.ports)
      continue
    }
    if (res.status === 401 || res.status === 403) {
      throw new LinkFetchError('The site wouldn’t show the page (it may need a sign-in)')
    }
    if (res.status === 404 || res.status === 410)
      throw new LinkFetchError('The page isn’t there any more')
    if (res.status < 200 || res.status >= 300) {
      throw new LinkFetchError(`The site answered with an error (${res.status})`)
    }
    const contentType = String(res.headers['content-type'] ?? '').toLowerCase()
    const mime = contentType.split(';')[0]?.trim() ?? ''
    if (mime && !TYPES.includes(mime)) {
      throw new LinkFetchError(
        mime === 'application/pdf'
          ? 'It’s a PDF, not a web page, so there’s no readable copy; the link is kept'
          : 'It isn’t a web page, so there’s no readable copy; the link is kept',
      )
    }
    return {
      url: url.toString(),
      contentType: mime || 'text/html',
      text: decode(res.body, contentType),
    }
  }
}

function parseWebUrl(raw: string, ports: ReadonlySet<string> = PORTS): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new LinkFetchError('That isn’t a web link')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new LinkFetchError('Only web links (http or https) can be read')
  }
  if (url.username || url.password) throw new LinkFetchError('Links with a password can’t be read')
  if (!ports.has(url.port))
    throw new LinkFetchError('Only pages on the usual web ports can be read')
  return url
}

async function requestOnce(url: URL, deadline: number, opts: FetchOptions): Promise<RawResponse> {
  const target = await publicAddressOf(url.hostname, opts.resolve, opts.allowed)
  const left = deadline - Date.now()
  if (left <= 0) throw new LinkFetchError('The site took too long to answer')
  const maxBytes = opts.maxBytes ?? MAX_PAGE_BYTES
  const lib = url.protocol === 'https:' ? https : http
  return new Promise<RawResponse>((resolve, reject) => {
    const req = lib.request(
      url,
      {
        method: 'GET',
        headers: {
          'user-agent': opts.userAgent ?? USER_AGENT,
          accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1',
          'accept-encoding': 'gzip, deflate, br',
          'accept-language': 'en;q=0.9,*;q=0.5',
        },
        // Connect to the address that was checked, never a second lookup's answer.
        lookup: (_host, options, cb) => {
          if ((options as { all?: boolean }).all) {
            ;(cb as unknown as (e: null, a: Array<{ address: string; family: number }>) => void)(
              null,
              [target],
            )
          } else cb(null, target.address, target.family)
        },
        timeout: left,
      },
      (res) => {
        const status = res.statusCode ?? 0
        if (status >= 300 && status < 400) {
          res.resume()
          resolve({ status, headers: res.headers, body: Buffer.alloc(0) })
          return
        }
        let stream: NodeJS.ReadableStream = res
        const encoding = String(res.headers['content-encoding'] ?? '').toLowerCase()
        if (encoding === 'gzip' || encoding === 'x-gzip') stream = res.pipe(zlib.createGunzip())
        else if (encoding === 'deflate') stream = res.pipe(zlib.createInflate())
        else if (encoding === 'br') stream = res.pipe(zlib.createBrotliDecompress())
        const chunks: Buffer[] = []
        let size = 0
        let over = false
        stream.on('data', (chunk: Buffer) => {
          if (over) return
          size += chunk.length
          if (size > maxBytes) {
            over = true
            // Stop the decompressor too: left running, a small zip bomb keeps the CPU busy.
            if (stream !== res) (stream as unknown as { destroy(): void }).destroy()
            res.destroy()
            req.destroy()
            reject(new LinkFetchError('The page is too big to keep a readable copy of'))
            return
          }
          chunks.push(chunk)
        })
        stream.on('end', () =>
          resolve({ status, headers: res.headers, body: Buffer.concat(chunks) }),
        )
        stream.on('error', () => reject(new LinkFetchError('The page came back garbled')))
      },
    )
    const timer = setTimeout(() => req.destroy(new Error('timeout')), left)
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', (err) => {
      if (err instanceof LinkFetchError) reject(err)
      else if (err.message === 'timeout')
        reject(new LinkFetchError('The site took too long to answer'))
      else reject(new LinkFetchError('Couldn’t reach the site'))
    })
    req.on('close', () => clearTimeout(timer))
    req.end()
  })
}

/** The body as text in the charset the header or a `<meta charset>` names; UTF-8 otherwise. */
function decode(body: Buffer, contentType: string): string {
  let charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1]
  if (!charset) {
    const head = body.subarray(0, 2048).toString('latin1')
    charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1]
  }
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(body)
  } catch {
    return new TextDecoder('utf-8').decode(body)
  }
}
