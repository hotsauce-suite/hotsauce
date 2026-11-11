import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, HearthApiError } from '../api/client'
import { ImageUrls, safeImageBlob } from './assets'

describe('ImageUrls', () => {
  let next = 0
  const revoked: string[] = []

  beforeEach(() => {
    next = 0
    revoked.length = 0
    // jsdom has no object URLs.
    URL.createObjectURL = vi.fn(() => `blob:test/${++next}`)
    URL.revokeObjectURL = vi.fn((url: string) => void revoked.push(url))
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('fetches a relative image once through the API and returns an object URL', async () => {
    const raw = vi.spyOn(api, 'raw').mockResolvedValue(new Blob(['png']))
    const images = new ImageUrls('team', 'docs/plans/q4.md')

    const first = await images.resolve('../../assets/2026/10/chart-01ABCDEF.png')
    const again = await images.resolve('../../assets/2026/10/chart-01ABCDEF.png')

    expect(first).toBe('blob:test/1')
    expect(again).toBe(first)
    expect(raw).toHaveBeenCalledTimes(1)
    expect(raw).toHaveBeenCalledWith('team', 'assets/2026/10/chart-01ABCDEF.png')
  })

  it('passes external URLs through untouched', async () => {
    const raw = vi.spyOn(api, 'raw')
    const images = new ImageUrls('team', 'docs/a.md')
    expect(await images.resolve('https://example.com/x.png')).toBe('https://example.com/x.png')
    expect(raw).not.toHaveBeenCalled()
  })

  it('revokes every URL it created on release, then loads afresh', async () => {
    vi.spyOn(api, 'raw').mockResolvedValue(new Blob(['png']))
    const images = new ImageUrls('team', 'docs/a.md')
    const a = await images.resolve('a.png')
    const b = await images.resolve('b.png')

    images.release()
    expect(revoked.sort()).toEqual([a, b].sort())

    expect(await images.resolve('a.png')).toBe('blob:test/3')
  })

  it('retries an image that failed to load', async () => {
    const raw = vi
      .spyOn(api, 'raw')
      .mockRejectedValueOnce(new HearthApiError('not_found', 'missing', 404))
      .mockResolvedValue(new Blob(['png']))
    const images = new ImageUrls('team', 'docs/a.md')

    await expect(images.resolve('late.png')).rejects.toThrow('missing')
    expect(await images.resolve('late.png')).toBe('blob:test/1')
    expect(raw).toHaveBeenCalledTimes(2)
  })

  it('shows an SVG as a data: URL, never as a same-origin blob URL', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
    vi.spyOn(api, 'raw').mockResolvedValue(new Blob([svg], { type: 'image/svg+xml' }))
    const images = new ImageUrls('team', 'docs/a.md')
    const url = await images.resolve('../assets/x.svg')
    expect(url.startsWith('data:image/svg+xml;base64,')).toBe(true)
    expect(atob(url.slice(url.indexOf(',') + 1))).toBe(svg)
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })
})

describe('safeImageBlob', () => {
  it('keeps raster images and re-types anything that could render as a page', () => {
    const png = new Blob(['x'], { type: 'image/png' })
    expect(safeImageBlob(png)).toBe(png)
    expect(safeImageBlob(new Blob(['<script>'], { type: 'text/html' })).type).toBe(
      'application/octet-stream',
    )
    expect(safeImageBlob(new Blob(['x'])).type).toBe('application/octet-stream')
  })
})
