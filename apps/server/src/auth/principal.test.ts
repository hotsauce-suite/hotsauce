import { describe, expect, it } from 'vitest'
import { deriveHandle, isAllowedEmailDomain, nameFromEmail, toPrincipal } from './principal.js'

describe('deriveHandle', () => {
  it.each([
    ['morgan@example.test', 'morgan'],
    ['Morgan@Example.test', 'morgan'],
    ['morgan.holland@example.test', 'morgan-holland'],
    ['morgan+hearth@example.test', 'morgan-hearth'],
    ['a..b__c@example.test', 'a-b-c'],
    ['a--b@example.test', 'a-b'],
    ['.jo.@example.test', 'jo'],
    ['-jo-@example.test', 'jo'],
    ['zoë@example.test', 'zo'],
    ['r2-d2@example.test', 'r2-d2'],
  ])('%s → %s', (email, handle) => {
    expect(deriveHandle(email)).toBe(handle)
  })
})

describe('nameFromEmail', () => {
  it('title-cases the local part words', () => {
    expect(nameFromEmail('morgan.holland@example.test')).toBe('Morgan Holland')
    expect(nameFromEmail('jo@example.test')).toBe('Jo')
  })
})

describe('isAllowedEmailDomain', () => {
  const allowed = ['example.test']

  it('allows an exact domain match', () => {
    expect(isAllowedEmailDomain('morgan@example.test', allowed)).toBe(true)
  })

  it('is case-insensitive on both sides', () => {
    expect(isAllowedEmailDomain('morgan@Example.TEST', allowed)).toBe(true)
    expect(isAllowedEmailDomain('morgan@example.test', ['EXAMPLE.test'])).toBe(true)
  })

  it('blocks Clerk test-mode addresses, which Clerk verifies without sending email', () => {
    expect(isAllowedEmailDomain('anyone+clerk_test@example.test', allowed)).toBe(false)
    expect(isAllowedEmailDomain('a+CLERK_TEST_x@example.test', allowed)).toBe(false)
    expect(isAllowedEmailDomain('morgan+notes@example.test', allowed)).toBe(true)
  })

  it('blocks other domains, subdomains and lookalikes', () => {
    expect(isAllowedEmailDomain('mallory@gmail.com', allowed)).toBe(false)
    expect(isAllowedEmailDomain('morgan@eng.example.test', allowed)).toBe(false)
    expect(isAllowedEmailDomain('morgan@example.test.evil.io', allowed)).toBe(false)
    expect(isAllowedEmailDomain('morgan@notexample.test', allowed)).toBe(false)
    expect(isAllowedEmailDomain('example.test@evil.io', allowed)).toBe(false)
  })

  it('blocks strings without a domain', () => {
    expect(isAllowedEmailDomain('', allowed)).toBe(false)
    expect(isAllowedEmailDomain('example.test', allowed)).toBe(false)
  })

  it('accepts any of several allowed domains', () => {
    expect(isAllowedEmailDomain('a@example.org', ['example.test', 'example.org'])).toBe(true)
  })
})

describe('toPrincipal', () => {
  it('lowercases the email, derives the handle and checks admins case-insensitively', () => {
    const p = toPrincipal({ userId: 'u1', email: 'Morgan.Holland@example.test', name: 'M' }, [
      'MORGAN.holland@example.test',
    ])
    expect(p).toEqual({
      userId: 'u1',
      email: 'morgan.holland@example.test',
      name: 'M',
      handle: 'morgan-holland',
      isAdmin: true,
    })
  })

  it('is not admin unless listed', () => {
    const p = toPrincipal({ userId: 'u2', email: 'jo@example.test', name: 'Jo' }, [])
    expect(p.isAdmin).toBe(false)
  })
})
