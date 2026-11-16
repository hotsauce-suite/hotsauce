import { describe, expect, it } from 'vitest'
import { videoIdentity } from './ClipPage'
import { cutAt, keptMs, middleCuts, normalizeCuts, trimEnd, trimStart, withTrim } from './cuts'

const D = 10_000

describe('the trim editor’s cuts', () => {
  it('reads the start and end trims and the middle cuts', () => {
    const cuts = normalizeCuts(
      [
        { startMs: 0, endMs: 1000 },
        { startMs: 4000, endMs: 5000 },
        { startMs: 9000, endMs: D },
      ],
      D,
    )
    expect(trimStart(cuts)).toBe(1000)
    expect(trimEnd(cuts, D)).toBe(9000)
    expect(middleCuts(cuts, D)).toEqual([{ startMs: 4000, endMs: 5000 }])
    expect(keptMs(cuts, D)).toBe(7000)
    expect(cutAt(cuts, 4500)).toEqual({ startMs: 4000, endMs: 5000 })
    expect(cutAt(cuts, 5000)).toBeUndefined()
  })

  it('moves the handles, keeping the middle cuts and at least a second between them', () => {
    const cuts = [{ startMs: 4000, endMs: 5000 }]
    expect(withTrim(cuts, D, 2000, 8000)).toEqual([
      { startMs: 0, endMs: 2000 },
      { startMs: 4000, endMs: 5000 },
      { startMs: 8000, endMs: D },
    ])
    // The start can't pass the end.
    const crossed = withTrim([], D, 7000, 6500)
    expect(trimEnd(crossed, D) - trimStart(crossed)).toBeGreaterThanOrEqual(1000)
    // Back to the ends: no trim.
    expect(withTrim(cuts, D, 0, D)).toEqual(cuts)
  })
})

describe('videoIdentity', () => {
  it('ignores signatures but sees a new file or a new edit', () => {
    const a = '/api/clips/media/X/edited?exp=1&sig=a&v=1'
    expect(videoIdentity(a)).toBe(videoIdentity('/api/clips/media/X/edited?exp=2&sig=b&v=1'))
    expect(videoIdentity(a)).not.toBe(videoIdentity('/api/clips/media/X/edited?exp=1&sig=a&v=2'))
    expect(videoIdentity('https://r2.example/b/clips/X/video.webm?X-Amz-Signature=1')).not.toBe(
      videoIdentity('https://r2.example/b/clips/X/edited-1.mp4?X-Amz-Signature=1'),
    )
  })
})
