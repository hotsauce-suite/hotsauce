import { describe, expect, it } from 'vitest'
import { clock } from './clips.js'

describe('clock', () => {
  it('writes seconds as m:ss, and h:mm:ss past an hour', () => {
    expect(clock(0)).toBe('0:00')
    expect(clock(65.7)).toBe('1:05')
    expect(clock(3599)).toBe('59:59')
    expect(clock(3661)).toBe('1:01:01')
    expect(clock(-3)).toBe('0:00')
  })
})
