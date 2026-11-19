import { forgetForYou } from '../apps/for-you/store'
import { forgetPhotos } from '../profile/photo'
import { reloadRailWide } from '../rail/railWide'
import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest'
import { setAuthHeaders, setUnauthorizedHandler } from '../api/client'
import { hotsauceSocket } from '../api/ws'
import { forgetPins } from '../apps/pins'
import { resetConnectionForTests } from '../lib/connection'
import { resetMusicForTests } from '../music/player'
import { resetMockApi, server, TEST_USER } from './mockServer'

// jsdom gaps that CodeMirror and cmdk touch.
if (!Range.prototype.getClientRects) {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList
}
Range.prototype.getBoundingClientRect = () => new DOMRect()
Element.prototype.scrollIntoView = () => {}
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.matchMedia ??= (query: string) =>
  ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  }) as MediaQueryList

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }))

beforeEach(() => {
  resetMockApi()
  setAuthHeaders(() => ({ 'x-hearth-dev-user': TEST_USER }))
})

afterEach(() => {
  cleanup()
  hotsauceSocket.stop()
  setUnauthorizedHandler(null)
  localStorage.clear()
  reloadRailWide()
  forgetPhotos()
  resetMusicForTests()
  forgetPins()
  forgetForYou()
  // A test that cut the network leaves the app "offline"; the next one starts online.
  resetConnectionForTests(async () => true)
})

afterAll(() => server.close())
