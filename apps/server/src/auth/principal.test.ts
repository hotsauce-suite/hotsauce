import { describe, expect, it } from 'vitest'
import {
  deriveHandle,
  isAllowedEmailDomain,
  nameFromEmail,
  signInAllowance,
  toPrincipal,
} from './principal.js'

describe('deriveHandle', () => {
  it.each([
    ['ada@example.test', 'ada'],
    ['Ada@Example.test', 'ada'],
    ['ada.lovelace@example.test', 'ada-lovelace'],
    ['ada+hearth@example.test', 'ada-hearth'],
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
    expect(nameFromEmail('ada.lovelace@example.test')).toBe('Ada Lovelace')
    expect(nameFromEmail('jo@example.test')).toBe('Jo')
  })
})

describe('isAllowedEmailDomain', () => {
  const allowed = ['example.test']

  it('allows an exact domain match', () => {
    expect(isAllowedEmailDomain('ada@example.test', allowed)).toBe(true)
  })

  it('is case-insensitive on both sides', () => {
    expect(isAllowedEmailDomain('ada@Example.TEST', allowed)).toBe(true)
    expect(isAllowedEmailDomain('ada@example.test', ['EXAMPLE.test'])).toBe(true)
  })

  it('blocks Clerk test-mode addresses, which Clerk verifies without sending email', () => {
    expect(isAllowedEmailDomain('anyone+clerk_test@example.test', allowed)).toBe(false)
    expect(isAllowedEmailDomain('a+CLERK_TEST_x@example.test', allowed)).toBe(false)
    expect(isAllowedEmailDomain('ada+notes@example.test', allowed)).toBe(true)
  })

  it('blocks other domains, subdomains and lookalikes', () => {
    expect(isAllowedEmailDomain('mallory@gmail.com', allowed)).toBe(false)
    expect(isAllowedEmailDomain('ada@eng.example.test', allowed)).toBe(false)
    expect(isAllowedEmailDomain('ada@example.test.evil.io', allowed)).toBe(false)
    expect(isAllowedEmailDomain('ada@notexample.test', allowed)).toBe(false)
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
    const p = toPrincipal({ userId: 'u1', email: 'Ada.Lovelace@example.test', name: 'M' }, [
      'ADA.lovelace@example.test',
    ])
    expect(p).toEqual({
      userId: 'u1',
      email: 'ada.lovelace@example.test',
      name: 'M',
      handle: 'ada-lovelace',
      isAdmin: true,
    })
  })

  it('is not admin unless listed', () => {
    const p = toPrincipal({ userId: 'u2', email: 'jo@example.test', name: 'Jo' }, [])
    expect(p.isAdmin).toBe(false)
  })
})

describe('signInAllowance', () => {
  const domains = ['example.test']
  const emails = ['jo@partner.org', 'Sam@Gmail.com']

  it('calls an allowed domain a member, even when also invited', () => {
    expect(signInAllowance('ann@example.test', domains, ['ann@example.test'])).toBe('member')
  })

  it('calls an exact invited address invited, ignoring case', () => {
    expect(signInAllowance('JO@partner.org', domains, emails)).toBe('invited')
    expect(signInAllowance('sam@gmail.com', domains, emails)).toBe('invited')
  })

  it('refuses the rest of an invited person’s domain, look-alikes and test addresses', () => {
    expect(signInAllowance('eve@partner.org', domains, emails)).toBeNull()
    expect(signInAllowance('jo@partner.org.evil.com', domains, emails)).toBeNull()
    expect(signInAllowance('xjo@partner.org', domains, emails)).toBeNull()
    expect(
      signInAllowance('jo+clerk_test@partner.org', domains, ['jo+clerk_test@partner.org']),
    ).toBeNull()
    expect(signInAllowance('', domains, emails)).toBeNull()
    // U+212A KELVIN SIGN lowercases to an ASCII "k".
    expect(signInAllowance('\u212Aim@partner.org', domains, ['kim@partner.org'])).toBeNull()
  })

  it('refuses everyone outside the domains when nobody is invited', () => {
    expect(signInAllowance('jo@partner.org', domains)).toBeNull()
  })
})

describe('deriveHandle, qualified', () => {
  it('adds the domain so an invited person can’t take a member’s handle', () => {
    expect(deriveHandle('ada@gmail.com', { qualified: true })).toBe('ada-gmail-com')
    expect(deriveHandle('ada@gmail.com')).toBe('ada')
  })

  it('toPrincipal gives invited people the qualified handle', () => {
    const p = toPrincipal({ userId: 'u', email: 'Jo@Partner.org', name: 'Jo' }, [], {
      invited: true,
    })
    expect(p.handle).toBe('jo-partner-org')
  })
})
