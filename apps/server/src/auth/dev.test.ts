import { describe, expect, it } from 'vitest'
import { HearthError } from '../errors.js'
import { DEV_USER_HEADER, DevAuth } from './dev.js'

const auth = new DevAuth({
  allowedDomains: ['example.test'],
  adminEmails: ['morgan@example.test'],
})

function req(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/me', { headers })
}

describe('DevAuth', () => {
  it('returns null without the header', async () => {
    expect(await auth.authenticate(req())).toBeNull()
  })

  it('returns null for an empty or malformed header', async () => {
    expect(await auth.authenticate(req({ [DEV_USER_HEADER]: '   ' }))).toBeNull()
    expect(await auth.authenticate(req({ [DEV_USER_HEADER]: 'not-an-email' }))).toBeNull()
    expect(await auth.authenticate(req({ [DEV_USER_HEADER]: 'a@b@example.test' }))).toBeNull()
  })

  it('builds a principal from the email, trimmed and lowercased', async () => {
    const p = await auth.authenticate(req({ [DEV_USER_HEADER]: '  Jo.Smith@Example.test ' }))
    expect(p).toEqual({
      userId: 'dev:jo.smith@example.test',
      email: 'jo.smith@example.test',
      name: 'Jo Smith',
      handle: 'jo-smith',
      isAdmin: false,
    })
  })

  it('marks admins from adminEmails', async () => {
    const p = await auth.authenticate(req({ [DEV_USER_HEADER]: 'morgan@example.test' }))
    expect(p?.isAdmin).toBe(true)
  })

  it('applies the domain lock', async () => {
    const attempt = auth.authenticate(req({ [DEV_USER_HEADER]: 'eve@eng.example.test' }))
    await expect(attempt).rejects.toBeInstanceOf(HearthError)
    await expect(attempt).rejects.toMatchObject({ code: 'domain_not_allowed', status: 403 })
  })

  it('tells the outsider which domain to sign in with', async () => {
    const attempt = auth.authenticate(req({ [DEV_USER_HEADER]: 'visitor@example.com' }))
    await expect(attempt).rejects.toThrow(
      'visitor@example.com is not allowed. Sign in with your example.test account.',
    )
  })
})
