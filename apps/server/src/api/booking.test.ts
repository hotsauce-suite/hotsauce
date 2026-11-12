import { describe, expect, it } from 'vitest'
import { clientIp } from './booking.js'

describe('clientIp', () => {
  const from = (headers: Record<string, string>) => clientIp((n) => headers[n])
  it('uses Fly’s header, and counts IPv6 per /64', () => {
    expect(from({ 'fly-client-ip': '203.0.113.9' })).toBe('203.0.113.9')
    expect(from({ 'fly-client-ip': '2001:db8:1:2:aaaa::1' })).toBe('2001:db8:1:2::/64')
    expect(from({ 'fly-client-ip': '2001:db8:1:2:bbbb:cccc:dddd:eeee' })).toBe('2001:db8:1:2::/64')
    expect(from({ 'fly-client-ip': '2001:db8::1' })).toBe('2001:db8:0:0::/64')
    expect(from({ 'x-forwarded-for': '198.51.100.1, 10.0.0.1' })).toBe('198.51.100.1')
    expect(from({})).toBeNull()
  })
})
