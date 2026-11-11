import { afterEach, describe, expect, it, vi } from 'vitest'
import { HearthError } from '../errors.js'
import { ClerkAuth, type ClerkClientLike, type ClerkUserLike } from './clerk.js'

function user(email: string, extra: Partial<ClerkUserLike> = {}): ClerkUserLike {
  return {
    primaryEmailAddressId: 'e1',
    emailAddresses: [
      { id: 'e0', emailAddress: 'secondary@example.test' },
      { id: 'e1', emailAddress: email },
    ],
    firstName: 'Jo',
    lastName: 'Smith',
    ...extra,
  }
}

function fakeClerk(opts: { userId: string | null; user?: ClerkUserLike | Error }) {
  const deleted: string[] = []
  const getUser = vi.fn(async (id: string) => {
    if (opts.user instanceof Error) throw opts.user
    if (!opts.user || deleted.includes(id)) {
      throw Object.assign(new Error('not found'), { status: 404 })
    }
    return opts.user
  })
  const authenticateRequest = vi.fn(async () =>
    opts.userId
      ? { isAuthenticated: true, toAuth: () => ({ userId: opts.userId }) }
      : { isAuthenticated: false, toAuth: () => ({ userId: null }) },
  )
  const clerk: ClerkClientLike = {
    authenticateRequest,
    users: {
      getUser,
      deleteUser: async (id: string) => {
        deleted.push(id)
      },
    },
  }
  return { clerk, deleted, getUser, authenticateRequest }
}

function authWith(clerk: ClerkClientLike) {
  return new ClerkAuth({
    clerk,
    allowedDomains: ['example.test'],
    adminEmails: ['morgan@example.test'],
    authorizedParties: ['https://hearth.example'],
  })
}

const request = () =>
  new Request('http://localhost/api/me', { headers: { authorization: 'Bearer t' } })

afterEach(() => {
  vi.useRealTimers()
})

describe('ClerkAuth', () => {
  it('returns null when Clerk says the request is signed out', async () => {
    const { clerk, getUser } = fakeClerk({ userId: null })
    expect(await authWith(clerk).authenticate(request())).toBeNull()
    expect(getUser).not.toHaveBeenCalled()
  })

  it('passes authorizedParties to Clerk', async () => {
    const { clerk, authenticateRequest } = fakeClerk({ userId: null })
    await authWith(clerk).authenticate(request())
    expect(authenticateRequest).toHaveBeenCalledWith(expect.any(Request), {
      authorizedParties: ['https://hearth.example'],
    })
  })

  it('builds a principal from the primary email and real name', async () => {
    const { clerk } = fakeClerk({ userId: 'user_1', user: user('Morgan@Example.test') })
    expect(await authWith(clerk).authenticate(request())).toEqual({
      userId: 'user_1',
      email: 'morgan@example.test',
      name: 'Jo Smith',
      handle: 'morgan',
      isAdmin: true,
    })
  })

  it('falls back to a name from the email when Clerk has none', async () => {
    const u = user('jo.smith@example.test', { firstName: null, lastName: null })
    const { clerk } = fakeClerk({ userId: 'user_1', user: u })
    expect((await authWith(clerk).authenticate(request()))?.name).toBe('Jo Smith')
  })

  it('deletes the Clerk user and throws domain_not_allowed for an outside domain', async () => {
    const { clerk, deleted } = fakeClerk({ userId: 'user_x', user: user('eve@gmail.com') })
    const attempt = authWith(clerk).authenticate(request())
    await expect(attempt).rejects.toBeInstanceOf(HearthError)
    await expect(attempt).rejects.toMatchObject({ code: 'domain_not_allowed', status: 403 })
    expect(deleted).toEqual(['user_x'])
  })

  it('treats a subdomain as an outside domain', async () => {
    const { clerk, deleted } = fakeClerk({
      userId: 'user_x',
      user: user('eve@eng.example.test'),
    })
    await expect(authWith(clerk).authenticate(request())).rejects.toMatchObject({
      code: 'domain_not_allowed',
    })
    expect(deleted).toEqual(['user_x'])
  })

  it('checks the primary address, not any address on the account', async () => {
    const u = user('eve@gmail.com') // the secondary address is in-domain
    const { clerk, deleted } = fakeClerk({ userId: 'user_x', user: u })
    await expect(authWith(clerk).authenticate(request())).rejects.toMatchObject({
      code: 'domain_not_allowed',
    })
    expect(deleted).toEqual(['user_x'])
  })

  it('deletes a user with no primary email', async () => {
    const u = user('jo@example.test', { primaryEmailAddressId: null })
    const { clerk, deleted } = fakeClerk({ userId: 'user_x', user: u })
    await expect(authWith(clerk).authenticate(request())).rejects.toMatchObject({
      code: 'domain_not_allowed',
    })
    expect(deleted).toEqual(['user_x'])
  })

  it('returns null for a still-valid token whose user was already deleted', async () => {
    const { clerk } = fakeClerk({ userId: 'user_gone' })
    expect(await authWith(clerk).authenticate(request())).toBeNull()
  })

  it('propagates other Clerk API failures', async () => {
    const { clerk } = fakeClerk({ userId: 'user_1', user: new Error('clerk down') })
    await expect(authWith(clerk).authenticate(request())).rejects.toThrow('clerk down')
  })

  it('caches the user for five minutes, keyed by userId', async () => {
    vi.useFakeTimers()
    const { clerk, getUser } = fakeClerk({ userId: 'user_1', user: user('jo@example.test') })
    const auth = authWith(clerk)

    await auth.authenticate(request())
    await auth.authenticate(request())
    expect(getUser).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(5 * 60 * 1000 - 1)
    await auth.authenticate(request())
    expect(getUser).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(2)
    await auth.authenticate(request())
    expect(getUser).toHaveBeenCalledTimes(2)
  })
})

describe('ClerkAuth.principalForUser', () => {
  it('loads the member by id, and is null once they are gone from Clerk', async () => {
    const { clerk } = fakeClerk({ userId: null, user: user('jo@example.test') })
    const principal = await authWith(clerk).principalForUser('user_1')
    expect(principal).toMatchObject({
      userId: 'user_1',
      email: 'jo@example.test',
      name: 'Jo Smith',
    })
    const gone = fakeClerk({ userId: null })
    expect(await authWith(gone.clerk).principalForUser('user_1')).toBeNull()
  })

  it('is null for a member banned or locked in Clerk', async () => {
    for (const flag of [{ banned: true }, { locked: true }]) {
      const { clerk } = fakeClerk({ userId: null, user: user('jo@example.test', flag) })
      expect(await authWith(clerk).principalForUser('user_1')).toBeNull()
    }
  })

  it('applies the domain lock', async () => {
    const { clerk, deleted } = fakeClerk({ userId: null, user: user('eve@example.com') })
    await expect(authWith(clerk).principalForUser('user_1')).rejects.toMatchObject({
      code: 'domain_not_allowed',
    })
    expect(deleted).toEqual(['user_1'])
  })
})
