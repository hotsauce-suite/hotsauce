import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { HearthError } from '../errors.js'

const REPO_NAME = /^[a-z0-9][a-z0-9._-]{0,99}$/i

/** Repo names end up in file paths (local) and URLs (remote hosts). */
export function assertRepoName(name: string): void {
  if (!REPO_NAME.test(name) || name.includes('..') || name.toLowerCase().endsWith('.git')) {
    throw new HearthError('bad_request', `Invalid repository name: ${JSON.stringify(name)}`)
  }
}

export function assertNotProduction(action: string): void {
  if (process.env.NODE_ENV === 'production') {
    throw new HearthError('forbidden', `${action} is disabled in production`)
  }
}

/** Constant-time check of a hex HMAC-SHA256 of `body` keyed with `secret`. */
export function verifyHmacSha256Hex(secret: string, body: string, signatureHex: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(signatureHex)) return false
  const expected = createHmac('sha256', secret).update(body, 'utf8').digest()
  return timingSafeEqual(expected, Buffer.from(signatureHex, 'hex'))
}

/** Header lookup that ignores case, since frameworks differ in how they pass header names. */
export function header(headers: Record<string, string>, name: string): string | undefined {
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value
  }
  return undefined
}

const PushPayload = z.object({
  ref: z.string().min(1),
  repository: z.object({ name: z.string().min(1) }),
})

/** The fields Hearth needs from a push event body (same shape on GitHub and Forgejo). */
export function parsePushPayload(rawBody: string): { repo: string; ref: string } | null {
  let json: unknown
  try {
    json = JSON.parse(rawBody)
  } catch {
    return null
  }
  const parsed = PushPayload.safeParse(json)
  return parsed.success ? { repo: parsed.data.repository.name, ref: parsed.data.ref } : null
}

/** `fetch` that reports a request that got no response at all (DNS, refused, reset) as host_error. */
export async function hostFetch(host: string, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init)
  } catch (err) {
    console.error(`${host}: ${init.method ?? 'GET'} ${new URL(url).pathname} failed:`, err)
    throw new HearthError('host_error', `${host} could not be reached`)
  }
}

/**
 * A host_error for a failed response. The body is where hosts explain themselves, so it goes to
 * the server log; clients get only what failed and the status.
 */
export async function hostError(host: string, what: string, res: Response): Promise<HearthError> {
  const body = await res.text().catch(() => '')
  const message = `${host}: ${what} failed (${res.status})`
  console.error(`${message}: ${body.slice(0, 500)}`)
  return new HearthError('host_error', message)
}
