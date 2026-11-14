import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DESKTOP, firePrompt, IPAD_AS_MAC, IPHONE, PIXEL, pretend } from '../test/devices'
import {
  dismissInstallBar,
  installBarDismissed,
  installContext,
  resetInstallPrompt,
  useInstallPrompt,
} from './install'

// docs/PLAN-install-and-settings.md, I1 and I2.

afterEach(() => {
  vi.restoreAllMocks()
  act(() => resetInstallPrompt())
})

describe('installContext', () => {
  it('knows an iPhone, an iPad that says it is a Mac, an Android phone and a computer', () => {
    pretend({ ua: IPHONE, touch: 5 })
    expect(installContext()).toEqual({ isMobile: true, isIOS: true, isInstalled: false })
    pretend({ ua: IPAD_AS_MAC, touch: 5 })
    expect(installContext()).toMatchObject({ isMobile: true, isIOS: true })
    pretend({ ua: PIXEL, touch: 5 })
    expect(installContext()).toMatchObject({ isMobile: true, isIOS: false })
    pretend({ ua: DESKTOP })
    expect(installContext()).toMatchObject({ isMobile: false, isIOS: false })
  })

  it('counts a finger on a narrow screen as a tablet whatever the browser says', () => {
    pretend({ ua: DESKTOP, queries: ['(pointer: coarse)', '(max-width: 1024px)'] })
    expect(installContext().isMobile).toBe(true)
  })

  it('knows the installed app by its display mode or Safari’s navigator.standalone', () => {
    pretend({ ua: PIXEL, queries: ['(display-mode: standalone)'] })
    expect(installContext().isInstalled).toBe(true)
    pretend({ ua: IPHONE })
    Object.defineProperty(navigator, 'standalone', { value: true, configurable: true })
    try {
      expect(installContext().isInstalled).toBe(true)
    } finally {
      Object.defineProperty(navigator, 'standalone', { value: undefined, configurable: true })
    }
  })
})

describe('useInstallPrompt', () => {
  it('catches the browser’s prompt, shows it once, and counts an accepted install', async () => {
    pretend({ ua: PIXEL })
    const { result } = renderHook(() => useInstallPrompt())
    expect(result.current.canPrompt).toBe(false)
    expect(await result.current.prompt()).toBe('unavailable')

    const event = firePrompt('accepted')
    expect(event.defaultPrevented).toBe(true)
    expect(result.current.canPrompt).toBe(true)

    let outcome = ''
    await act(async () => {
      outcome = await result.current.prompt()
    })
    expect(outcome).toBe('accepted')
    expect(event.prompt).toHaveBeenCalledTimes(1)
    expect(result.current.canPrompt).toBe(false)
    expect(result.current.isInstalled).toBe(true)
  })

  it('a prompt caught before anyone asked still counts', () => {
    firePrompt()
    const { result } = renderHook(() => useInstallPrompt())
    expect(result.current.canPrompt).toBe(true)
  })

  it('appinstalled marks it installed', () => {
    const { result } = renderHook(() => useInstallPrompt())
    act(() => {
      window.dispatchEvent(new Event('appinstalled'))
    })
    expect(result.current.isInstalled).toBe(true)
  })
})

describe('dismissing the bar', () => {
  it('is remembered, and storage that throws doesn’t break anything', () => {
    expect(installBarDismissed()).toBe(false)
    dismissInstallBar()
    expect(installBarDismissed()).toBe(true)
    localStorage.clear()
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })
    expect(() => dismissInstallBar()).not.toThrow()
    expect(installBarDismissed()).toBe(false)
  })
})
