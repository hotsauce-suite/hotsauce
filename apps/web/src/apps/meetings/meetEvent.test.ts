import { describe, expect, it } from 'vitest'
import { meetCallCode } from './meetEvent'

describe('meetCallCode', () => {
  it('reads a call’s code from its Meet link, and nothing else', () => {
    expect(meetCallCode('https://meet.google.com/abc-defg-hij')).toBe('abc-defg-hij')
    expect(meetCallCode('https://meet.google.com/abc-defg-hij/?authuser=1')).toBe('abc-defg-hij')
    expect(meetCallCode('https://meet.google.com/lookup/xyz')).toBeNull()
    expect(meetCallCode('https://evil.example/abc-defg-hij')).toBeNull()
    expect(meetCallCode('not a url')).toBeNull()
    expect(meetCallCode(undefined)).toBeNull()
  })
})
