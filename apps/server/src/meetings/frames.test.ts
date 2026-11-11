import { describe, expect, it } from 'vitest'
import { audioFrame, parseAudioFrame } from './frames.js'
import { calendarDayIn, clockTimeIn, isoInZone, zonedParts } from './zoned-time.js'

describe('parseAudioFrame', () => {
  it('reads the track byte and keeps the PCM as is', () => {
    const pcm = new Uint8Array([1, 2, 3, 4])
    expect(parseAudioFrame(new Uint8Array([0, 1, 2, 3, 4]))).toEqual({ track: 'me', pcm })
    expect(parseAudioFrame(new Uint8Array([1, 1, 2, 3, 4]))).toEqual({ track: 'them', pcm })
    expect(parseAudioFrame(audioFrame('them', pcm))).toEqual({ track: 'them', pcm })
    expect(parseAudioFrame(new Uint8Array([0]))).toEqual({ track: 'me', pcm: new Uint8Array() })
  })

  it('rejects an unknown track, an empty frame, and odd-length PCM16', () => {
    expect(parseAudioFrame(new Uint8Array([2, 0, 0]))).toEqual({
      error: expect.stringMatching(/track byte/),
    })
    expect(parseAudioFrame(new Uint8Array())).toEqual({
      error: expect.stringMatching(/track byte/),
    })
    expect(parseAudioFrame(new Uint8Array([0, 1, 2, 3]))).toEqual({
      error: expect.stringMatching(/even number/),
    })
  })
})

describe('zoned time', () => {
  const instant = new Date('2026-10-08T02:30:15Z')

  it("writes the instant in the owner's zone with its offset", () => {
    expect(isoInZone(instant, 'America/New_York')).toBe('2026-10-07T22:30:15-04:00')
    expect(isoInZone(instant, 'Asia/Kolkata')).toBe('2026-10-08T08:00:15+05:30')
    expect(isoInZone(instant, 'UTC')).toBe('2026-10-08T02:30:15+00:00')
    expect(zonedParts(new Date('2026-12-01T12:00:00Z'), 'America/New_York').offset).toBe('-05:00')
  })

  it("gives the owner's calendar day and clock time", () => {
    const day = calendarDayIn(instant, 'America/New_York')
    expect([day.getFullYear(), day.getMonth() + 1, day.getDate()]).toEqual([2026, 10, 7])
    expect(clockTimeIn(instant, 'America/New_York')).toBe('10:30 PM')
  })
})
