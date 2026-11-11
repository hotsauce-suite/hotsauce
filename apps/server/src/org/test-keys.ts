/**
 * "Test key" buttons in the setup wizard: one cheap, read-only request per provider that proves
 * the key works, without spending money. Never logs or returns the key.
 */

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
