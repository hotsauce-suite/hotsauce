// Phones, tablets and computers for tests of installing the app (lib/install.ts).
import { act } from '@testing-library/react'
import { vi } from 'vitest'

// The real one, so pretending twice in a test doesn't wrap a spy in a spy.
const realMatchMedia = window.matchMedia.bind(window)

export const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
export const IPAD_AS_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'
export const PIXEL =
  'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'
export const DESKTOP =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** Pretends to be a device: its user agent, touch points, and which media queries match. */
export function pretend(device: { ua: string; touch?: number; queries?: string[] }) {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(device.ua)
  // jsdom has no maxTouchPoints to spy on.
  Object.defineProperty(navigator, 'maxTouchPoints', {
    value: device.touch ?? 0,
    configurable: true,
  })
  vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
    ...realMatchMedia(query),
    matches: (device.queries ?? []).includes(query),
  }))
}

export function firePrompt(outcome: 'accepted' | 'dismissed' = 'accepted') {
  const event = new Event('beforeinstallprompt', { cancelable: true }) as Event & {
    prompt: () => Promise<void>
    userChoice: Promise<{ outcome: string }>
  }
  event.prompt = vi.fn(async () => {})
  event.userChoice = Promise.resolve({ outcome })
  act(() => {
    window.dispatchEvent(event)
  })
  return event
}
