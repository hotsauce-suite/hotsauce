// The hotsauce.work worker: the landing page, and the live demo at demo.hotsauce.work
// (docs/PLAN-live-demo.md). ASSETS is faked; it records which file each request asked for.
import { describe, expect, it } from 'vitest'
import { newestMacTag } from './mac-download.js'
import worker from './worker.js'

function env() {
  const asked = []
  return {
    asked,
    ASSETS: {
      async fetch(req) {
        const path = new URL(req.url).pathname
        asked.push(path)
        return new Response(`file ${path}`, { status: path.includes('missing') ? 404 : 200 })
      },
    },
  }
}

const get = (url, e, headers = {}) => worker.fetch(new Request(url, { headers }), e)

describe('demo.hotsauce.work', () => {
  it('serves app routes from the demo build, files from /demo/', async () => {
    const e = env()
    await get('https://demo.hotsauce.work/tasks', e)
    await get('https://demo.hotsauce.work/people/dana@acme.com', e)
    await get('https://demo.hotsauce.work/assets/index-abc.js', e)
    await get('https://demo.hotsauce.work/mockServiceWorker.js', e)
    expect(e.asked).toEqual([
      '/demo/',
      '/demo/',
      '/demo/assets/index-abc.js',
      '/demo/mockServiceWorker.js',
    ])
  })

  it('may only be framed by hotsauce.work', async () => {
    const res = await get('https://demo.hotsauce.work/tasks', env())
    expect(res.headers.get('content-security-policy')).toContain(
      "frame-ancestors 'self' https://hotsauce.work",
    )
    expect(res.headers.get('x-frame-options')).toBeNull()
  })

  it('never caches the app shell or the mock worker, and caches hashed assets for good', async () => {
    const e = env()
    expect((await get('https://demo.hotsauce.work/', e)).headers.get('cache-control')).toBe(
      'no-cache',
    )
    expect(
      (await get('https://demo.hotsauce.work/mockServiceWorker.js', e)).headers.get(
        'cache-control',
      ),
    ).toBe('no-cache')
    expect(
      (await get('https://demo.hotsauce.work/assets/a-1.js', e)).headers.get('cache-control'),
    ).toContain('immutable')
  })
})

describe('hotsauce.work', () => {
  it('keeps the landing page unframeable', async () => {
    const res = await get('https://hotsauce.work/', env())
    expect(res.headers.get('x-frame-options')).toBe('DENY')
  })

  it('does not serve the demo build at /demo/', async () => {
    const e = env()
    await get('https://hotsauce.work/demo/index.html', e)
    expect(e.asked).not.toContain('/demo/index.html')
  })

  it('serves the install guide, script and llms.txt as text to read inline, never stale', async () => {
    for (const [path, type] of [
      ['/install.md', 'text/markdown; charset=utf-8'],
      ['/install.sh', 'text/plain; charset=utf-8'],
      ['/llms.txt', 'text/plain; charset=utf-8'],
    ]) {
      const res = await get(`https://hotsauce.work${path}`, env())
      expect(res.headers.get('content-type')).toBe(type)
      expect(res.headers.get('content-disposition')).toBe('inline')
      expect(res.headers.get('cache-control')).toBe('no-cache')
    }
    const page = await get('https://hotsauce.work/', env())
    expect(page.headers.get('content-disposition')).toBeNull()
  })

  it('sends www to the bare domain', async () => {
    const res = await get('https://www.hotsauce.work/x', env())
    expect(res.status).toBe(301)
    expect(res.headers.get('location')).toBe('https://hotsauce.work/x')
  })
})

describe('which version is live', () => {
  it('names the deployed commit on every host, so a deploy can check it went live', async () => {
    const e = { ...env(), SITE_VERSION: 'abc123' }
    for (const url of ['https://hotsauce.work/', 'https://demo.hotsauce.work/tasks']) {
      expect((await get(url, e)).headers.get('x-site-version')).toBe('abc123')
    }
  })

  it('says nothing when the deploy gave no version', async () => {
    expect((await get('https://hotsauce.work/', env())).headers.has('x-site-version')).toBe(false)
  })
})

describe('the Mac app download (docs/PLAN-mac-download.md)', () => {
  const releases = [
    { tag_name: 'v0.34.1', prerelease: false },
    { tag_name: 'mac-app-111', prerelease: true },
    { tag_name: 'mac-app-140', prerelease: true, draft: true },
    { tag_name: 'mac-app-99', prerelease: true },
    { tag_name: 'mac-app', prerelease: true },
  ]
  function github({ down = false, info = { version: '0.29.2', build: '111' } } = {}) {
    const calls = []
    return {
      calls,
      async fetch(u) {
        calls.push(u)
        if (down) return new Response('rate limited', { status: 403 })
        if (u.includes('/releases?')) return Response.json(releases)
        if (u.endsWith('/mac-app-111/mac-app.json')) return Response.json(info)
        return new Response('missing', { status: 404 })
      },
    }
  }
  function memoryCache() {
    const m = new Map()
    return {
      async match(req) {
        const hit = m.get(req.url)
        return hit ? new Response(hit) : undefined
      },
      async put(req, res) {
        m.set(req.url, await res.text())
      },
    }
  }

  it('picks the newest published build, never a draft or a Hotsauce release', () => {
    expect(newestMacTag(releases)).toBe('mac-app-111')
    expect(newestMacTag([{ tag_name: 'v1.0.0' }])).toBeNull()
    expect(newestMacTag('nonsense')).toBeNull()
  })

  it('sends /download/mac to the newest build of the disk image', async () => {
    const gh = github()
    const res = await get('https://hotsauce.work/download/mac', { ...env(), fetch: gh.fetch })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(
      'https://github.com/hotsauce-suite/hotsauce/releases/download/mac-app-111/Hotsauce.dmg',
    )
  })

  it('says which version the download is, for the page to show', async () => {
    const gh = github()
    const res = await get('https://hotsauce.work/download/mac.json', { ...env(), fetch: gh.fetch })
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(await res.json()).toEqual({
      version: '0.29.2',
      build: '111',
      url: 'https://hotsauce.work/download/mac',
      minimumMacOS: '14.0',
    })
  })

  it('asks GitHub once per ten minutes, not once per visitor', async () => {
    const gh = github()
    const e = { ...env(), fetch: gh.fetch, cache: memoryCache() }
    await get('https://hotsauce.work/download/mac.json', e)
    await get('https://hotsauce.work/download/mac', e)
    await get('https://hotsauce.work/download/mac.json', e)
    expect(gh.calls).toHaveLength(2)
  })

  it('still offers a download, with no number, when GitHub is unreachable', async () => {
    const gh = github({ down: true })
    const e = { ...env(), fetch: gh.fetch }
    const res = await get('https://hotsauce.work/download/mac', e)
    expect(res.headers.get('location')).toBe(
      'https://github.com/hotsauce-suite/hotsauce/releases/download/mac-app/Hotsauce.dmg',
    )
    expect((await (await get('https://hotsauce.work/download/mac.json', e)).json()).version).toBe(
      null,
    )
  })

  it('ignores a version file that names no plain version', async () => {
    const gh = github({ info: { version: '<script>', build: '111' } })
    const res = await get('https://hotsauce.work/download/mac.json', { ...env(), fetch: gh.fetch })
    expect((await res.json()).version).toBeNull()
  })
})
