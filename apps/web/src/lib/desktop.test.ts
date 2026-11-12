import { afterEach, describe, expect, it } from 'vitest'
import { desktopCallback, isDesktopState, safeReturnPath, takeDesktopTicket } from './desktop'

describe('desktop sign-in helpers', () => {
  afterEach(() => {
    delete (window as { webkit?: unknown }).webkit
  })

  it('accepts only a long URL-safe state', () => {
    expect(isDesktopState('a'.repeat(43))).toBe(true)
    expect(isDesktopState('short')).toBe(false)
    expect(isDesktopState(null)).toBe(false)
    expect(isDesktopState(`${'a'.repeat(40)}&ticket=x`)).toBe(false)
  })

  it('hands the ticket back on the app scheme, encoded', () => {
    expect(desktopCallback('s'.repeat(32), 'a b&c')).toBe(
      `hearth://auth/callback?state=${'s'.repeat(32)}&ticket=a+b%26c`,
    )
  })

  it('takes the ticket only from the Mac app, never from the page', async () => {
    expect(await takeDesktopTicket()).toBeNull()
    Object.assign(window, {
      webkit: { messageHandlers: { hearthTicket: { postMessage: async () => 'tkt_1' } } },
    })
    expect(await takeDesktopTicket()).toBe('tkt_1')
    Object.assign(window, {
      webkit: { messageHandlers: { hearthTicket: { postMessage: async () => null } } },
    })
    expect(await takeDesktopTicket()).toBeNull()
  })

  it('returns only to paths on this site', () => {
    expect(safeReturnPath('/desktop/connect?state=x')).toBe('/desktop/connect?state=x')
    expect(safeReturnPath('//evil.com')).toBe('/today')
    expect(safeReturnPath('https://evil.com')).toBe('/today')
    expect(safeReturnPath(undefined)).toBe('/today')
  })
})
