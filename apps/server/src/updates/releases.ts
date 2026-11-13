export interface Release {
  version: string
  notes: string
  url: string
  publishedAt: string
}

export const RELEASES_URL = 'https://api.github.com/repos/hotsauce-suite/hotsauce/releases/latest'

/** The newest published Hotsauce release, or null when GitHub can't say right now. */
export async function fetchLatestRelease(
  url = RELEASES_URL,
  fetchFn: typeof fetch = fetch,
): Promise<Release | null> {
  try {
    const res = await fetchFn(url, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'hotsauce-updater' },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return null
    const body = (await res.json()) as {
      tag_name?: string
      body?: string | null
      html_url?: string
      published_at?: string
      draft?: boolean
      prerelease?: boolean
    }
    if (!body.tag_name || body.draft || body.prerelease) return null
    const version = body.tag_name.replace(/^v/, '')
    if (!/^\d+\.\d+\.\d+$/.test(version)) return null
    return {
      version,
      notes: (body.body ?? '').slice(0, 20_000),
      url: body.html_url ?? '',
      publishedAt: body.published_at ?? '',
    }
  } catch {
    return null
  }
}
