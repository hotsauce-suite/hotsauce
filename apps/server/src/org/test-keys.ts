/**
 * "Test key" buttons in the setup wizard: one cheap, read-only request per provider that proves
 * the key works, without spending money. Never logs or returns the key.
 */

import { r2Endpoint, S3Client, S3Error } from '../storage/s3.js'

export interface KeyTestResult {
  ok: boolean
  /** One line for the admin: what worked, or what to fix. */
  message: string
}

type Fetch = typeof fetch

export async function testProvider(
  provider: 'anthropic' | 'deepgram' | 'clerk' | 'github',
  key: string,
  extra: string,
  fetchImpl: Fetch = fetch,
): Promise<KeyTestResult> {
  if (!key) return { ok: false, message: 'Paste a key first' }
  try {
    switch (provider) {
      case 'anthropic': {
        const res = await fetchImpl('https://api.anthropic.com/v1/models?limit=1', {
          headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
          signal: AbortSignal.timeout(10_000),
        })
        if (res.ok) return { ok: true, message: 'Anthropic accepted the key' }
        return { ok: false, message: rejected('Anthropic', res.status) }
      }
      case 'deepgram': {
        const res = await fetchImpl('https://api.deepgram.com/v1/projects', {
          headers: { Authorization: `Token ${key}` },
          signal: AbortSignal.timeout(10_000),
        })
        if (res.ok) return { ok: true, message: 'Deepgram accepted the key' }
        return { ok: false, message: rejected('Deepgram', res.status) }
      }
      case 'clerk': {
        if (!/^sk_(test|live)_/.test(key)) {
          return { ok: false, message: 'A Clerk secret key starts with sk_test_ or sk_live_' }
        }
        const res = await fetchImpl('https://api.clerk.com/v1/users?limit=1', {
          headers: { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(10_000),
        })
        if (!res.ok) return { ok: false, message: rejected('Clerk', res.status) }
        const pk = extra.trim()
        if (pk && pk.slice(3, 7) !== key.slice(3, 7)) {
          return {
            ok: false,
            message:
              'The keys are from different Clerk instances: use both from Development, or both from Production',
          }
        }
        return { ok: true, message: 'Clerk accepted the secret key' }
      }
      case 'github': {
        const org = extra.trim()
        if (!org) return { ok: false, message: 'Enter the GitHub organization first' }
        const res = await fetchImpl(`https://api.github.com/orgs/${encodeURIComponent(org)}`, {
          headers: {
            Authorization: `Bearer ${key}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'hotsauce-setup',
          },
          signal: AbortSignal.timeout(10_000),
        })
        if (res.status === 404) {
          return { ok: false, message: `GitHub can’t find the organization ${org} with this token` }
        }
        if (!res.ok) return { ok: false, message: rejected('GitHub', res.status) }
        return { ok: true, message: `The token can reach ${org}` }
      }
    }
  } catch (err) {
    const timedOut = (err as Error).name === 'TimeoutError'
    return {
      ok: false,
      message: timedOut
        ? 'The provider didn’t answer within 10 seconds; try again'
        : 'Couldn’t reach the provider from this server; check its internet access',
    }
  }
}

function rejected(name: string, status: number): string {
  if (status === 401 || status === 403)
    return `${name} rejected the key (${status}): check you copied all of it`
  if (status === 429) return `${name} is rate limiting this server; try again in a minute`
  return `${name} answered ${status}; try again`
}

/** Forgejo: the token can see the organization (GET /api/v1/orgs/:org). */
export async function testForgejo(
  url: string,
  org: string,
  token: string,
  fetchImpl: Fetch = fetch,
): Promise<KeyTestResult> {
  if (!url.trim()) return { ok: false, message: 'Enter the Forgejo address first' }
  if (!org.trim()) return { ok: false, message: 'Enter the Forgejo organization first' }
  if (!token) return { ok: false, message: 'Paste a token first' }
  const base = url.trim().replace(/\/+$/, '')
  try {
    const res = await fetchImpl(`${base}/api/v1/orgs/${encodeURIComponent(org.trim())}`, {
      headers: { Authorization: `token ${token}`, Accept: 'application/json' },
      // A redirect must not carry the token somewhere else.
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    })
    if (res.status === 404) {
      return { ok: false, message: `Forgejo can’t find the organization ${org} with this token` }
    }
    if (!res.ok) return { ok: false, message: rejected('Forgejo', res.status) }
    return { ok: true, message: `The token can reach ${org}` }
  } catch (err) {
    return { ok: false, message: unreachable(err, 'the Forgejo server') }
  }
}

/**
 * A storage bucket: writes, reads back and deletes one small object, so a key that can list but
 * not write (or the wrong bucket or region) fails here instead of on the first upload.
 */
export async function testStorage(
  opts: {
    endpoint: string
    region: string
    accountId: string
    accessKeyId: string
    bucket: string
    secretAccessKey: string
  },
  fetchImpl: Fetch = fetch,
): Promise<KeyTestResult> {
  const endpoint =
    opts.endpoint.trim() || (opts.accountId.trim() ? r2Endpoint(opts.accountId.trim()) : '')
  if (!endpoint) return { ok: false, message: 'Enter the account ID (R2) or endpoint first' }
  if (!opts.accessKeyId.trim() || !opts.bucket.trim()) {
    return { ok: false, message: 'Enter the access key ID and bucket first' }
  }
  if (!opts.secretAccessKey) return { ok: false, message: 'Paste the secret access key first' }
  const s3 = new S3Client({
    endpoint,
    region: opts.region.trim() || 'auto',
    bucket: opts.bucket.trim(),
    accessKeyId: opts.accessKeyId.trim(),
    secretAccessKey: opts.secretAccessKey,
    fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
      fetchImpl(input, {
        ...init,
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      })) as Fetch,
  })
  const key = `.hotsauce-test/${Date.now().toString(36)}`
  const body = new TextEncoder().encode('ok')
  try {
    await s3.put(key, body, body.length, 'text/plain')
    const back = await s3.get(key)
    if (!back)
      return { ok: false, message: 'The bucket took a test file but couldn’t read it back' }
    await back.body.cancel()
    await s3.delete(key)
    return { ok: true, message: `Wrote, read and deleted a test file in ${opts.bucket.trim()}` }
  } catch (err) {
    if (err instanceof S3Error) {
      if (err.status === 404) return { ok: false, message: `No bucket ${opts.bucket} there` }
      if (err.status === 301 || err.status === 400) {
        return {
          ok: false,
          message: `The bucket answered ${err.status}: check the region and endpoint`,
        }
      }
      return { ok: false, message: rejected('The bucket', err.status) }
    }
    return { ok: false, message: unreachable(err, 'the storage service') }
  }
}

function unreachable(err: unknown, what: string): string {
  return (err as Error).name === 'TimeoutError'
    ? `${what} didn’t answer within 10 seconds; try again`
    : `Couldn’t reach ${what} from this server; check the address`
}
