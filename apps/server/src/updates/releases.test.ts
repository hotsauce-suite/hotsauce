import { describe, expect, it } from 'vitest'
import {
  fetchImageDigest,
  fetchLatestRelease,
  imageDigestUrl,
  RELEASES_PAGE_URL,
  RELEASES_URL,
} from './releases.js'

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

  it('treats a redirect anywhere but a release as a failure', async () => {
    const { fn } = fakeFetch({
      [RELEASES_URL]: rateLimited(),
      [RELEASES_PAGE_URL]: redirectTo('https://github.com/login?return_to=%2Freleases'),
    })
    await expect(fetchLatestRelease(fn)).rejects.toThrow(
      /releases page: redirected to https:\/\/github.com\/login/,
    )
  })
})

// docs/PLAN-pinned-images.md R2, R3.
describe('fetchImageDigest', () => {
  const DIGEST = `sha256:${'a1'.repeat(32)}`
  const url = imageDigestUrl('0.17.0')

  it('reads the digest the release recorded, from its download (no API limit)', async () => {
    expect(url).toBe(
      'https://github.com/hotsauce-suite/hotsauce/releases/download/v0.17.0/image-digest.txt',
    )
    const { fn, calls } = fakeFetch({ [url]: new Response(`${DIGEST}\n`, { status: 200 }) })
    expect(await fetchImageDigest('0.17.0', fn)).toBe(DIGEST)
    // GitHub answers a download with a redirect to its file host, which must be followed.
    expect(calls[0]?.init?.redirect ?? 'follow').toBe('follow')
  })

  it('fails when the release recorded none, so nothing is installed', async () => {
    const { fn } = fakeFetch({ [url]: new Response('Not Found', { status: 404 }) })
    await expect(fetchImageDigest('0.17.0', fn)).rejects.toThrow(/recorded no image.*404/)
  })

  it('fails on anything but one sha256 digest', async () => {
    for (const body of ['latest', `${DIGEST} extra`, 'sha256:XYZ', `sha512:${'a'.repeat(128)}`]) {
      const { fn } = fakeFetch({ [url]: new Response(body, { status: 200 }) })
      await expect(fetchImageDigest('0.17.0', fn)).rejects.toThrow(/isn’t an image digest/)
    }
  })
})
