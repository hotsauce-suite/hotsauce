import { describe, expect, it } from 'vitest'
import { isPageMessage } from './protocol'

describe('isPageMessage', () => {
  it('accepts the page’s hello and capture requests', () => {
    expect(isPageMessage({ source: 'hearth-page', type: 'hello', id: '1' })).toBe(true)
    expect(isPageMessage({ source: 'hearth-page', type: 'capture-meet', id: '2' })).toBe(true)
    const forCall = { source: 'hearth-page', type: 'capture-meet', id: '3', code: 'abc-defg-hij' }
    expect(isPageMessage(forCall)).toBe(true)
    expect(isPageMessage({ source: 'hearth-page', type: 'link-saved', id: 's', ok: true })).toBe(
      true,
    )
    expect(isPageMessage({ source: 'hearth-page', type: 'may-save', id: 'm' })).toBe(true)
  })

  it('ignores everything else posted to the window', () => {
    expect(isPageMessage(null)).toBe(false)
    expect(isPageMessage('hello')).toBe(false)
    expect(isPageMessage({ source: 'hearth-extension', type: 'hello', id: '1' })).toBe(false)
    expect(isPageMessage({ source: 'hearth-page', type: 'hello' })).toBe(false)
    expect(isPageMessage({ source: 'hearth-page', type: 'other', id: '1' })).toBe(false)
    expect(isPageMessage({ source: 'hearth-page', type: 'link-saved', id: 's' })).toBe(false)
    expect(isPageMessage({ source: 'hearth-page', type: 'capture-meet', id: '4', code: 7 })).toBe(
      false,
    )
  })
})
