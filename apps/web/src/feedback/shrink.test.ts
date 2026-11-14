import { describe, expect, it } from 'vitest'
import { fitWidth, MAX_SHOT_WIDTH, shrinkImage } from './shrink'

// docs/PLAN-feedback-screenshots.md S8.

const blob = (size: number, type: string) => new Blob([new Uint8Array(size)], { type })

describe('fitWidth', () => {
  it('keeps small pictures and scales wide ones to 2000 px, keeping the shape', () => {
    expect(fitWidth(1200, 800)).toEqual({ width: 1200, height: 800 })
    expect(fitWidth(4000, 3000)).toEqual({ width: MAX_SHOT_WIDTH, height: 1500 })
  })
})

describe('shrinkImage', () => {
  const draw = (sizes: Record<string, number>) => {
    const calls: { width: number; height: number; type: string }[] = []
    return {
      calls,
      tools: {
        measure: async () => ({ width: 3000, height: 1500 }),
        encode: async (size: { width: number; height: number }, type: string) => {
          calls.push({ ...size, type })
          return blob(sizes[type] ?? 1, type)
        },
      },
    }
  }

  it('leaves a small, narrow picture alone', async () => {
    const original = blob(1000, 'image/png')
    const { calls, tools } = draw({})
    const out = await shrinkImage(original, {
      ...tools,
      measure: async () => ({ width: 800, height: 600 }),
    })
    expect(out).toBe(original)
    expect(calls).toEqual([])
  })

  it('redraws a wide picture at 2000 px as a PNG', async () => {
    const { calls, tools } = draw({ 'image/png': 900_000 })
    const out = await shrinkImage(blob(3_000_000, 'image/png'), tools)
    expect(out.type).toBe('image/png')
    expect(calls).toEqual([{ width: 2000, height: 1000, type: 'image/png' }])
  })

  it('uses a JPEG when the PNG is big and the JPEG smaller', async () => {
    const { tools } = draw({ 'image/png': 2_400_000, 'image/jpeg': 600_000 })
    const out = await shrinkImage(blob(4_000_000, 'image/png'), tools)
    expect(out.type).toBe('image/jpeg')
  })

  it('sends the original when it cannot be read as a picture', async () => {
    const original = blob(10, 'image/heic')
    const out = await shrinkImage(original, {
      measure: async () => {
        throw new Error('cannot decode')
      },
      encode: async () => blob(1, 'image/png'),
    })
    expect(out).toBe(original)
  })
})
