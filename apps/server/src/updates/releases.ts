export interface Release {
  version: string
  notes: string
  url: string
  publishedAt: string
}

export const RELEASES_URL = 'https://api.github.com/repos/hotsauce-suite/hotsauce/releases/latest'
/** Redirects to the newest release's page. Not part of the API, so its rate limit doesn't apply. */
export const RELEASES_PAGE_URL = 'https://github.com/hotsauce-suite/hotsauce/releases/latest'

const HEADERS = { accept: 'application/vnd.github+json', 'user-agent': 'hotsauce-updater' }
const TIMEOUT_MS = 15_000

const plainVersion = (tag: string): string | null => {
  const version = tag.replace(/^v/, '')
  return /^\d+\.\d+\.\d+$/.test(version) ? version : null
}

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err))

/**
 * The newest published Hotsauce release, or null when there is none. Asks the GitHub API first
 * (it has the notes); when that fails, which on a shared address is usually its rate limit of 60
 * unauthenticated asks an hour, reads the version from where the releases page redirects.
 * Throws, saying why, when neither answers.
 */
export async function fetchLatestRelease(fetchFn: typeof fetch = fetch): Promise<Release | null> {
  let apiFailure: string
  try {
    const res = await fetchFn(RELEASES_URL, {
      headers: HEADERS,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (res.ok) return fromApi(await res.json())
    await res.body?.cancel()
    const limited = res.status === 429 || res.headers.get('x-ratelimit-remaining') === '0'
    apiFailure = `GitHub API answered ${res.status}${limited ? ' (rate limited)' : ''}`
  } catch (err) {
    apiFailure = `GitHub API: ${reason(err)}`
  }
  try {
    return await fromReleasesPage(fetchFn)
  } catch (err) {
    throw new Error(`${apiFailure}; releases page: ${reason(err)}`)
  }
}

function fromApi(json: unknown): Release | null {
  const body = json as {
    tag_name?: string
    body?: string | null
    html_url?: string
    published_at?: string
    draft?: boolean
    prerelease?: boolean
  }
  if (!body.tag_name || body.draft || body.prerelease) return null
  const version = plainVersion(body.tag_name)
  if (!version) return null
  return {
    version,
    notes: (body.body ?? '').slice(0, 20_000),
    url: body.html_url ?? '',
    publishedAt: body.published_at ?? '',
  }
}

async function fromReleasesPage(fetchFn: typeof fetch): Promise<Release | null> {
  const res = await fetchFn(RELEASES_PAGE_URL, {
    method: 'HEAD',
    redirect: 'manual',
    headers: { 'user-agent': HEADERS['user-agent'] },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const raw = res.headers.get('location')
  if (res.status < 300 || res.status >= 400 || !raw) {
    throw new Error(`answered ${res.status} without a redirect`)
  }
  const location = new URL(raw, RELEASES_PAGE_URL)
  const tag = /^\/hotsauce-suite\/hotsauce\/releases\/tag\/([^/]+)$/.exec(location.pathname)?.[1]
  if (!tag) {
    // No release yet redirects to the releases list; anywhere else (a sign-in or abuse page) is
    // a failure, not "nothing new".
    if (/^\/hotsauce-suite\/hotsauce\/releases\/?$/.test(location.pathname)) return null
    throw new Error(`redirected to ${location.href}`)
  }
  const version = plainVersion(decodeURIComponent(tag))
  if (!version) return null
  // Notes need the API; Settings links to the release page instead.
  return { version, notes: '', url: location.href, publishedAt: '' }
}
