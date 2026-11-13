import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { MacAppDownloads, releaseAsset } from './macApp.js'

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
