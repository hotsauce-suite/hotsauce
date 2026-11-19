import { afterEach, describe, expect, it, vi } from 'vitest'
import { BURST_COUNT, pepperBurst, pepperShower, SHOWER_COUNT, SHOWER_MS } from './peppers'

afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('pepper shower (E1)', () => {
  it('drops peppers above everything, ignoring the pointer, and cleans up after itself', () => {
    vi.useFakeTimers()
    const layer = pepperShower({ reducedMotion: false })
    expect(layer?.getAttribute('aria-hidden')).toBe('true')
    expect(layer?.className).toBe('egg-layer')
    expect(document.querySelectorAll('.egg-pepper')).toHaveLength(SHOWER_COUNT)
    vi.advanceTimersByTime(SHOWER_MS + 400)
    expect(document.querySelector('[data-testid="pepper-shower"]')).toBeNull()
  })

  it('with reduced motion shows one still badge instead', () => {
    pepperShower({ reducedMotion: true })
    expect(document.querySelectorAll('.egg-pepper')).toHaveLength(0)
    expect(document.querySelector('.egg-badge')?.textContent).toContain('Spicy')
  })
})

describe('pepper burst (E5)', () => {
  it('bursts a few peppers from the click', () => {
    pepperBurst(100, 200, { reducedMotion: false })
    const peppers = document.querySelectorAll<HTMLElement>('.egg-pepper')
    expect(peppers).toHaveLength(BURST_COUNT)
    expect(peppers[0]?.style.left).toBe('92px')
  })

  it('does nothing with reduced motion', () => {
    expect(pepperBurst(100, 200, { reducedMotion: true })).toBeNull()
    expect(document.querySelector('.egg-pepper')).toBeNull()
  })
})
