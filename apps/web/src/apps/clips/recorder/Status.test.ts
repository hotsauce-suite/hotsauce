import { describe, expect, it } from 'vitest'
import { describeShare, deviceName } from './Status'

describe('describeShare', () => {
  it('names the kind of share, and the window or tab when Chrome gives a readable name', () => {
    expect(describeShare('monitor', 'screen:1:0')).toBe('Entire screen')
    expect(describeShare('window', 'Pricing – Figma')).toBe('A window: Pricing – Figma')
    expect(describeShare('browser', 'Hearth Docs')).toBe('A Chrome tab: Hearth Docs')
    expect(describeShare('window', 'window:4423:0')).toBe('A window')
    expect(describeShare(null, null)).toBe('Your screen')
  })
})

describe('deviceName', () => {
  it('drops Chrome’s USB ids and falls back when there is no label', () => {
    const track = (label: string) => ({ label }) as MediaStreamTrack
    expect(deviceName(track('MacBook Pro Microphone (Built-in)'), 'Mic')).toBe(
      'MacBook Pro Microphone (Built-in)',
    )
    expect(deviceName(track('Logitech BRIO (046d:085e)'), 'Camera')).toBe('Logitech BRIO')
    expect(deviceName(track(''), 'Camera')).toBe('Camera')
    expect(deviceName(undefined, 'Microphone')).toBe('Microphone')
  })
})
