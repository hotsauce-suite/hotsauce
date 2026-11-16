import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isOnline,
  onBackOnline,
  onConnectionChange,
  reportReachable,
  reportUnreachable,
  resetConnectionForTests,
} from './connection'

function setBrowserOnline(online: boolean) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online })
  window.dispatchEvent(new Event(online ? 'online' : 'offline'))
}

describe('connection state (A3.1)', () => {
  let serverUp = true
  beforeEach(() => {
    vi.useFakeTimers()
    serverUp = true
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true })
    resetConnectionForTests(async () => serverUp)
  })
  afterEach(() => {
    vi.useRealTimers()
    resetConnectionForTests(async () => true)
  })

  it('is online by default', () => {
    expect(isOnline()).toBe(true)
  })

  it('goes offline when the browser does, and back once the server answers', async () => {
    const back = vi.fn()
    const off = onBackOnline(back)
    setBrowserOnline(false)
    expect(isOnline()).toBe(false)
    setBrowserOnline(true)
    // Not yet: the network is back but the server hasn't answered.
    expect(isOnline()).toBe(false)
    await vi.waitFor(() => expect(isOnline()).toBe(true))
    expect(back).toHaveBeenCalledTimes(1)
    off()
  })

  it('stays offline when the network is back but the server still doesn’t answer', async () => {
    setBrowserOnline(false)
    serverUp = false
    setBrowserOnline(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(isOnline()).toBe(false)
    serverUp = true
    await vi.advanceTimersByTimeAsync(5_000)
    expect(isOnline()).toBe(true)
  })

  it('goes offline when a request can’t connect and checks the server until it answers', async () => {
    const change = vi.fn()
    const off = onConnectionChange(change)
    serverUp = false
    reportUnreachable()
    expect(isOnline()).toBe(false)
    expect(change).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(isOnline()).toBe(false)
    serverUp = true
    await vi.advanceTimersByTimeAsync(5_000)
    expect(isOnline()).toBe(true)
    expect(change).toHaveBeenCalledTimes(2)
    off()
  })

  it('any answer from the server means online again', () => {
    reportUnreachable()
    reportReachable()
    expect(isOnline()).toBe(true)
  })
})
