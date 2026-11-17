import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  AUDIO_BITS,
  CAMERA_BITS,
  DISPLAY_MAX,
  SCREEN_BITS_MAX,
  SCREEN_BITS_MIN,
  screenBitrate,
} from './media'

describe('screenBitrate', () => {
  it('gives a 1080p screen about 3.7 Mbit/s and a Retina one the 7 Mbit/s ceiling', () => {
    expect(screenBitrate({ width: 1920, height: 1080, frameRate: 30 })).toBe(3_732_480)
    expect(screenBitrate({ width: 2463, height: 1600, frameRate: 30 })).toBe(7_000_000)
  })

  it('falls back to the largest capture size when the browser says nothing', () => {
    expect(screenBitrate({})).toBe(
      screenBitrate({ width: DISPLAY_MAX.width, height: DISPLAY_MAX.height, frameRate: 30 }),
    )
  })

  it('always stays between the floor and the ceiling, and grows with the picture', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 8000 }),
        fc.integer({ min: 1, max: 5000 }),
        fc.integer({ min: 1, max: 120 }),
        (width, height, frameRate) => {
          const bits = screenBitrate({ width, height, frameRate })
          expect(bits).toBeGreaterThanOrEqual(SCREEN_BITS_MIN)
          expect(bits).toBeLessThanOrEqual(SCREEN_BITS_MAX)
          expect(screenBitrate({ width: width + 100, height, frameRate })).toBeGreaterThanOrEqual(
            bits,
          )
        },
      ),
    )
  })

  it("fits an hour at the ceiling, with the camera, in the server's 4 GB a clip", () => {
    // MAX_CLIP_BYTES in apps/server/src/clips/service.ts.
    const bytes = ((SCREEN_BITS_MAX + CAMERA_BITS + AUDIO_BITS) * 3600) / 8
    expect(bytes).toBeLessThan(4 * 1024 ** 3)
  })
})
