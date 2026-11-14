import { describe, expect, it } from 'vitest'
import { fetchLatestRelease, RELEASES_PAGE_URL, RELEASES_URL } from './releases.js'

// docs/PLAN-releases-and-updates.md R10, R12.
type Answer = Response | Error
function fakeFetch(answers: Record<string, Answer>) {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    const a = answers[url]
    if (!a) throw new Error(`unexpected ${url}`)
    if (a instanceof Error) throw a
    return a
  }) as typeof fetch
  return { fn, calls }
}

const apiOk = () =>
  new Response(
    JSON.stringify({
      tag_name: 'v0.12.7',
      body: '- Faster updates',
      html_url: 'https://github.com/hotsauce-suite/hotsauce/releases/tag/v0.12.7',
      published_at: '2026-11-14T18:00:00Z',
    }),
    { status: 200 },
  )
const redirectTo = (location: string) => new Response(null, { status: 302, headers: { location } })
const rateLimited = () =>
  new Response('{"message":"API rate limit exceeded"}', {
    status: 403,
    headers: { 'x-ratelimit-remaining': '0' },
  })

describe('fetchLatestRelease', () => {
  it('reads the newest release, with its notes, from the GitHub API', async () => {
    const { fn } = fakeFetch({ [RELEASES_URL]: apiOk() })
    expect(await fetchLatestRelease(fn)).toEqual({
      version: '0.12.7',
      notes: '- Faster updates',
      url: 'https://github.com/hotsauce-suite/hotsauce/releases/tag/v0.12.7',
      publishedAt: '2026-11-14T18:00:00Z',
    })
  })

  it('falls back to the releases page when the API is rate limited', async () => {
    const tag = 'https://github.com/hotsauce-suite/hotsauce/releases/tag/v0.12.7'
    const { fn, calls } = fakeFetch({
      [RELEASES_URL]: rateLimited(),
      [RELEASES_PAGE_URL]: redirectTo(tag),
    })
    expect(await fetchLatestRelease(fn)).toEqual({
      version: '0.12.7',
      notes: '',
      url: tag,
      publishedAt: '',
    })
    expect(calls[1]?.init?.redirect).toBe('manual')
  })

  it('falls back when the API can’t be reached at all', async () => {
    const { fn } = fakeFetch({
      [RELEASES_URL]: new Error('timed out'),
      [RELEASES_PAGE_URL]: redirectTo(
        'https://github.com/hotsauce-suite/hotsauce/releases/tag/v1.0.0',
      ),
    })
    expect((await fetchLatestRelease(fn))?.version).toBe('1.0.0')
  })

  it('says why when neither answers, so the updater can log it', async () => {
    const { fn } = fakeFetch({
      [RELEASES_URL]: rateLimited(),
      [RELEASES_PAGE_URL]: new Error('getaddrinfo ENOTFOUND github.com'),
    })
    await expect(fetchLatestRelease(fn)).rejects.toThrow(
      /GitHub API answered 403 \(rate limited\).*releases page: getaddrinfo ENOTFOUND/,
    )
  })

  it('is null, not an error, when there is no published release yet', async () => {
    const { fn } = fakeFetch({
      [RELEASES_URL]: new Response('{"message":"Not Found"}', { status: 404 }),
      [RELEASES_PAGE_URL]: redirectTo('https://github.com/hotsauce-suite/hotsauce/releases'),
    })
    expect(await fetchLatestRelease(fn)).toBeNull()
  })

  it('ignores a tag that isn’t a plain version', async () => {
    const { fn } = fakeFetch({
      [RELEASES_URL]: new Response(JSON.stringify({ tag_name: 'nightly' }), { status: 200 }),
    })
    expect(await fetchLatestRelease(fn)).toBeNull()
  })
})
