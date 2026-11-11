import { describe, expect, it } from 'vitest'
import {
  DictationStore,
  deviceTokenFrom,
  hashDeviceToken,
  newDeviceToken,
  normalizeWords,
  TEAM_WORDS_SEED,
} from './store.js'

const ALICE = { userId: 'u_alice', email: 'alice@example.test' }

describe('device tokens', () => {
  it('are hdt_ plus 43 url-safe characters, different every time', () => {
    const a = newDeviceToken()
    expect(a).toMatch(/^hdt_[A-Za-z0-9_-]{43}$/)
    expect(newDeviceToken()).not.toBe(a)
  })

  it('hash to sha256 hex', () => {
    expect(hashDeviceToken('hdt_x')).toBe(
      '06daa48a9156d72da1ef0c4cc84c4e49f611308b684936f805356480b9cac28f',
    )
    expect(hashDeviceToken('hdt_x')).not.toBe(hashDeviceToken('hdt_y'))
  })

  it('are recognised only as a Bearer hdt_ header', () => {
    expect(deviceTokenFrom('Bearer hdt_abc-_1')).toBe('hdt_abc-_1')
    expect(deviceTokenFrom('bearer hdt_abc')).toBeNull()
    expect(deviceTokenFrom('Bearer eyJhbGciOi.x.y')).toBeNull()
    expect(deviceTokenFrom('Token hdt_abc')).toBeNull()
    expect(deviceTokenFrom(null)).toBeNull()
  })
})

describe('DictationStore', () => {
  it('keeps only the hash, finds the device by token, and stamps its use', () => {
    const store = new DictationStore(':memory:')
    const { device, token } = store.createDevice(ALICE, 'Morgan’s MacBook')
    expect(device.lastUsedAt).toBeNull()
    const used = store.useToken(token, new Date('2026-11-09T12:00:00Z'))
    expect(used).toMatchObject({
      id: device.id,
      email: ALICE.email,
      lastUsedAt: '2026-11-09T12:00:00.000Z',
    })
    expect(store.listDevices(ALICE.userId)[0]?.lastUsedAt).toBe('2026-11-09T12:00:00.000Z')
    expect(store.useToken(`${token}x`)).toBeNull()
  })

  it('revokes a member’s own device only', () => {
    const store = new DictationStore(':memory:')
    const { device, token } = store.createDevice(ALICE, 'Mac')
    expect(() => store.revokeDevice('u_bob', device.id)).toThrow(/No such device/)
    store.revokeDevice(ALICE.userId, device.id)
    expect(store.useToken(token)).toBeNull()
    expect(store.listDevices(ALICE.userId)).toEqual([])
    expect(() => store.revokeDevice(ALICE.userId, device.id)).toThrow(/No such device/)
  })

  it('keeps a member’s devices when their email changes', () => {
    const store = new DictationStore(':memory:')
    store.createDevice(ALICE, 'Mac')
    expect(store.listDevices(ALICE.userId)).toHaveLength(1)
    expect(store.listDevices(ALICE.email)).toHaveLength(0)
  })

  it('revokes every device of a user', () => {
    const store = new DictationStore(':memory:')
    const a = store.createDevice(ALICE, 'one').token
    const b = store.createDevice(ALICE, 'two').token
    store.revokeAllForUser(ALICE.userId)
    expect(store.useToken(a)).toBeNull()
    expect(store.useToken(b)).toBeNull()
  })

  it('seeds the team words once and keeps each list in order', () => {
    const store = new DictationStore(':memory:')
    expect(store.words('team')).toEqual(TEAM_WORDS_SEED)
    expect(store.setWords(ALICE.userId, [' Zeta ', 'alpha', 'ZETA', ''])).toEqual(['Zeta', 'alpha'])
    expect(store.words(ALICE.userId)).toEqual(['Zeta', 'alpha'])
    expect(store.words('bob@example.test')).toEqual([])
  })

  it('refuses an over-long list', () => {
    const store = new DictationStore(':memory:')
    expect(() =>
      store.setWords(
        'team',
        Array.from({ length: 201 }, (_, i) => `w${i}`),
      ),
    ).toThrow(/at most 200/)
  })
})

describe('normalizeWords', () => {
  it('collapses spaces and drops case-insensitive repeats', () => {
    expect(normalizeWords(['Acme  Bio', 'acme bio', 'Clerk'])).toEqual(['Acme Bio', 'Clerk'])
  })
})
