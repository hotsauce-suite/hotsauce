import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { assetType, MacAppDownloads, newestMacRelease, releaseAsset } from './macApp.js'

function setup(responses: Array<Response | Error>) {
  const calls: string[] = []
  let clock = Date.now()
  const downloads = new MacAppDownloads({
    cacheDir: path.join(mkdtempSync(path.join(tmpdir(), 'hs-mac-')), 'cache'),
    base: 'https://releases.example.test/mac-app',
    fetchFn: (async (url: string) => {
      calls.push(url)
      const next = responses.shift() ?? new Error('no more responses')
      if (next instanceof Error) throw next
      return next
    }) as unknown as typeof fetch,
    now: () => clock,
    maxAgeMs: 1000,
  })
  return { downloads, calls, advance: (ms: number) => (clock += ms) }
}

describe('releaseAsset', () => {
  it('maps every offered name, old ones too, to the release asset', () => {
    expect(releaseAsset('Hotsauce.dmg')).toBe('Hotsauce.dmg')
    expect(releaseAsset('HearthDictate.zip')).toBe('Hotsauce.zip')
    expect(releaseAsset('Hearth.dmg')).toBe('Hotsauce.dmg')
    expect(releaseAsset('../secret')).toBeNull()
  })

  it('also offers what the newest build is, as JSON', () => {
    expect(releaseAsset('mac-app.json')).toBe('mac-app.json')
    expect(releaseAsset('other.json')).toBeNull()
    expect(assetType('mac-app.json')).toBe('application/json')
    expect(assetType('Hotsauce.dmg')).toBe('application/x-apple-diskimage')
    expect(assetType('Hotsauce.zip')).toBe('application/zip')
  })
})

describe('MacAppDownloads', () => {
  it('fetches once, then serves the copy until it is old', async () => {
    const { downloads, calls, advance } = setup([new Response('dmg-1'), new Response('dmg-2')])
    const first = await downloads.file('Hotsauce.dmg')
    expect(first && readFileSync(first, 'utf8')).toBe('dmg-1')
    await downloads.file('Hotsauce.dmg')
    expect(calls).toEqual(['https://releases.example.test/mac-app/Hotsauce.dmg'])
    advance(2000)
    const again = await downloads.file('Hotsauce.dmg')
    expect(again && readFileSync(again, 'utf8')).toBe('dmg-2')
  })

  it('keeps the old copy when GitHub fails, and has nothing when it never worked', async () => {
    const { downloads, advance } = setup([new Response('dmg-1'), new Error('offline')])
    await downloads.file('Hotsauce.dmg')
    advance(2000)
    const kept = await downloads.file('Hotsauce.dmg')
    expect(kept && readFileSync(kept, 'utf8')).toBe('dmg-1')
    const none = setup([new Response('gone', { status: 404 })])
    expect(await none.downloads.file('Hotsauce.zip')).toBeNull()
  })

  it('fetches the app again when a newer version file arrived after it (M2)', async () => {
    const { downloads, calls } = setup([
      new Response('dmg-1'),
      new Response('{"version":"0.27.0"}'),
      new Response('dmg-2'),
    ])
    await downloads.file('Hotsauce.dmg')
    await new Promise((r) => setTimeout(r, 30))
    await downloads.file('mac-app.json')
    const again = await downloads.file('Hotsauce.dmg')
    expect(again && readFileSync(again, 'utf8')).toBe('dmg-2')
    expect(calls).toHaveLength(3)
  })

  it('waits the usual time before asking again after a failed refresh', async () => {
    const { downloads, calls, advance } = setup([new Response('dmg-1'), new Error('offline')])
    await downloads.file('Hotsauce.dmg')
    advance(2000)
    await downloads.file('Hotsauce.dmg')
    await downloads.file('Hotsauce.dmg')
    expect(calls).toHaveLength(2)
  })

  it('asks GitHub once for two requests at the same time', async () => {
    const { downloads, calls } = setup([new Response('dmg-1')])
    const [a, b] = await Promise.all([
      downloads.file('Hotsauce.dmg'),
      downloads.file('Hotsauce.dmg'),
    ])
    expect(a).toBe(b)
    expect(calls).toHaveLength(1)
  })
})

describe('the newest Mac app build (one immutable release per build)', () => {
  it('picks the highest build, never a draft, else the old shared release', () => {
    const releases = [
      { tag_name: 'v0.29.2' },
      { tag_name: 'mac-app-111' },
      { tag_name: 'mac-app-112', draft: true },
      { tag_name: 'mac-app-99' },
      { tag_name: 'mac-app' },
    ]
    expect(newestMacRelease(releases)).toBe('mac-app-111')
    expect(newestMacRelease([{ tag_name: 'mac-app' }, { tag_name: 'v1.0.0' }])).toBe('mac-app')
    expect(newestMacRelease({ message: 'rate limited' })).toBe('mac-app')
  })

  it('looks the release up once, and fetches every file from it', async () => {
    const calls: string[] = []
    const responses = [
      Response.json([{ tag_name: 'mac-app-111' }, { tag_name: 'mac-app' }]),
      new Response('dmg-111'),
      new Response('{"build":"111"}'),
    ]
    const downloads = new MacAppDownloads({
      cacheDir: path.join(mkdtempSync(path.join(tmpdir(), 'hs-mac-')), 'cache'),
      releasesApi: 'https://api.example.test/releases',
      fetchFn: (async (url: string) => {
        calls.push(url)
        return responses.shift() ?? new Response('', { status: 500 })
      }) as unknown as typeof fetch,
    })
    const dmg = await downloads.file('Hotsauce.dmg')
    expect(dmg && readFileSync(dmg, 'utf8')).toBe('dmg-111')
    await downloads.file('mac-app.json')
    expect(calls).toEqual([
      'https://api.example.test/releases',
      'https://github.com/hotsauce-suite/hotsauce/releases/download/mac-app-111/Hotsauce.dmg',
      'https://github.com/hotsauce-suite/hotsauce/releases/download/mac-app-111/mac-app.json',
    ])
  })

  it('falls back to the old shared release when GitHub can’t be asked', async () => {
    const calls: string[] = []
    const responses: Array<Response | Error> = [new Error('offline'), new Response('dmg-old')]
    const downloads = new MacAppDownloads({
      cacheDir: path.join(mkdtempSync(path.join(tmpdir(), 'hs-mac-')), 'cache'),
      releasesApi: 'https://api.example.test/releases',
      fetchFn: (async (url: string) => {
        calls.push(url)
        const next = responses.shift() ?? new Error('done')
        if (next instanceof Error) throw next
        return next
      }) as unknown as typeof fetch,
    })
    const dmg = await downloads.file('Hotsauce.dmg')
    expect(dmg && readFileSync(dmg, 'utf8')).toBe('dmg-old')
    expect(calls[1]).toBe('https://github.com/hotsauce-suite/hotsauce/releases/download/mac-app/Hotsauce.dmg')
  })
})
