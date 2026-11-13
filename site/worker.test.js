// The hotsauce.work worker: the landing page, and the live demo at demo.hotsauce.work
// (docs/PLAN-live-demo.md). ASSETS is faked; it records which file each request asked for.
import { describe, expect, it } from 'vitest'
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
