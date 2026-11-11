import { describe, expect, it } from 'vitest'
import { RateLimiter } from './rate-limit.js'

describe('RateLimiter', () => {
  it('allows `limit` hits per window per key, then again once the window moves', () => {
    const limiter = new RateLimiter(2, 1000)
    expect(limiter.take('a', 0)).toBe(true)
    expect(limiter.take('a', 10)).toBe(true)
    expect(limiter.take('a', 20)).toBe(false)
    expect(limiter.take('b', 20)).toBe(true)
    expect(limiter.take('a', 1001)).toBe(true)
  })
})
