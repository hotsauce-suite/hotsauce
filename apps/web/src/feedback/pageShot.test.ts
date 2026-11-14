import { afterEach, describe, expect, it, vi } from 'vitest'
import { capturePage, clearPageShot, openFeedback, PAGE_SHOT_WAIT_MS, pageShot } from './pageShot'

// docs/PLAN-feedback-screenshots.md S5.

const png = () => new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' })

afterEach(() => {
  clearPageShot()
  vi.useRealTimers()
})

describe('capturePage', () => {
  it('keeps the picture for the page it was taken on', async () => {
    const blob = png()
    await capturePage(async () => blob, '/docs')
    expect(pageShot('/docs')).toBe(blob)
    // Reading it doesn't use it up (React may render the form twice).
    expect(pageShot('/docs')).toBe(blob)
    expect(pageShot('/tasks')).toBeNull()
  })

  it('gives up after the wait and throws a late picture away', async () => {
    vi.useFakeTimers()
    let finish: (b: Blob) => void = () => {}
    const slow = new Promise<Blob>((resolve) => {
      finish = resolve
    })
    const done = capturePage(() => slow, '/docs')
    await vi.advanceTimersByTimeAsync(PAGE_SHOT_WAIT_MS)
    await done
    finish(png())
    await vi.advanceTimersByTimeAsync(0)
    expect(pageShot('/docs')).toBeNull()
  })

  it('goes on without a picture when taking it fails', async () => {
    await capturePage(async () => {
      throw new Error('tainted canvas')
    }, '/docs')
    expect(pageShot('/docs')).toBeNull()
  })

  it('replaces the previous picture', async () => {
    await capturePage(async () => png(), '/docs')
    await capturePage(async () => {
      throw new Error('no')
    }, '/docs')
    expect(pageShot('/docs')).toBeNull()
  })
})

describe('openFeedback', () => {
  it('pictures the page, then opens Send feedback from it', async () => {
    const navigate = vi.fn()
    const blob = png()
    await openFeedback(navigate, '/meetings/abc', async () => blob)
    expect(navigate).toHaveBeenCalledWith('/feedback?from=%2Fmeetings%2Fabc')
    expect(pageShot('/meetings/abc')).toBe(blob)
  })

  it('still opens Send feedback when the picture is slow', async () => {
    vi.useFakeTimers()
    const navigate = vi.fn()
    const opened = openFeedback(navigate, '/docs', () => new Promise<Blob>(() => {}))
    await vi.advanceTimersByTimeAsync(PAGE_SHOT_WAIT_MS - 1)
    expect(navigate).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await opened
    expect(navigate).toHaveBeenCalledWith('/feedback?from=%2Fdocs')
  })
})
