import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { authenticateDevice } from '../dictation/device-auth.js'
import { DictationStore } from '../dictation/store.js'
import { HotsauceError } from '../errors.js'
import { clerkGoogleGrant } from '../meetings/calendar/google.js'
import { TokenAuth } from '../tokens/auth.js'
import { TokenStore } from '../tokens/store.js'
import { ClerkAuth, type ClerkClientLike, type ClerkUserLike } from './clerk.js'
import { IdentityLedger, instanceOf } from './identities.js'

const dirs: string[] = []
async function dataDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'hotsauce-identities-'))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const DEV = instanceOf('sk_test_one')
const PROD = instanceOf('sk_live_two')
const seen = (email: string, instance = DEV, verified = true) => ({ email, verified, instance })

describe('IdentityLedger (I1, I2, I3)', () => {
  it('I1: a member id is the first sign-in id a person was seen with, and stays', () => {
    const ledger = new IdentityLedger()
    expect(ledger.resolve('user_old', seen('ada@example.test'))).toBe('user_old')
    expect(ledger.resolve('user_old', seen('ada@example.test'))).toBe('user_old')
    expect(ledger.resolve('user_other', seen('bo@example.test'))).toBe('user_other')
  })

  it('I2: a new sign-in id with the same verified email is the same member', () => {
    const log: string[] = []
    const ledger = new IdentityLedger({ log: (m) => log.push(m) })
    ledger.resolve('user_old', seen('ada@example.test'))
    expect(ledger.resolve('user_new', seen('Ada@Example.test', PROD))).toBe('user_old')
    expect(ledger.authIdFor('user_old', PROD)).toBe('user_new')
    expect(ledger.authIdFor('user_old', DEV)).toBe('user_old')
    expect(log.join('\n')).toMatch(/ada@example\.test has a new account id/)
  })

  it('I2: going back to the old instance is still the same member (rollback)', () => {
    const ledger = new IdentityLedger()
    ledger.resolve('user_old', seen('ada@example.test'))
    ledger.resolve('user_new', seen('ada@example.test', PROD))
    expect(ledger.resolve('user_old', seen('ada@example.test'))).toBe('user_old')
  })

  it("I3: a new id with an unverified email can't become an existing member", () => {
    const ledger = new IdentityLedger()
    ledger.resolve('user_old', seen('ada@example.test'))
    expect(() => ledger.resolve('user_new', seen('ada@example.test', PROD, false))).toThrow(
      HotsauceError,
    )
    expect(ledger.authIdFor('user_old', PROD)).toBeNull()
  })

  it('a changed email follows the sign-in id, not the other way round', () => {
    const ledger = new IdentityLedger()
    ledger.resolve('user_a', seen('ada@example.test'))
    expect(ledger.resolve('user_a', seen('ada.l@example.test'))).toBe('user_a')
    expect(ledger.emailOf('user_a')).toBe('ada.l@example.test')
    // The address she left is free for someone new.
    expect(ledger.resolve('user_b', seen('ada@example.test'))).toBe('user_b')
  })

  it('I4: survives a restart, and refuses to start from a file it cannot read', async () => {
    const dir = await dataDir()
    const first = new IdentityLedger({ dataDir: dir })
    first.resolve('user_old', seen('ada@example.test'))
    first.markListed(DEV)
    const second = new IdentityLedger({ dataDir: dir })
    expect(second.resolve('user_new', seen('ada@example.test', PROD))).toBe('user_old')
    expect(second.wasListed(DEV)).toBe(true)
    expect(second.wasListed(PROD)).toBe(false)
    expect(second.memberCount()).toBe(1)

    const file = path.join(dir, 'identities', 'identities.json')
    expect(await readFile(file, 'utf8')).not.toMatch(/sk_/)
    await writeFile(file, '{ not json')
    expect(() => new IdentityLedger({ dataDir: dir })).toThrow(/unreadable/)
  })

  it('I2: however ids arrive, one verified email is one member (many random orders)', () => {
    // A small seeded generator: the same orders every run, no extra dependency.
    let seed = 20261117
    const next = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % n
    }
    const instances = [DEV, PROD, 'third']
    for (let run = 0; run < 300; run++) {
      const ledger = new IdentityLedger({ log: () => {} })
      const memberOf = new Map<number, string>()
      for (let step = 0; step < 1 + next(40); step++) {
        const person = next(5)
        const instance = instances[next(3)] as string
        // One account per person per instance, as a sign-in provider gives.
        const member = ledger.resolve(
          `user_${instance}_${person}`,
          seen(`p${person}@example.test`, instance),
        )
        expect(memberOf.get(person) ?? member).toBe(member)
        memberOf.set(person, member)
      }
      expect(new Set(memberOf.values()).size).toBe(memberOf.size)
    }
  })
})

// ── A sign-in instance, and moving from one to another ───────────────────────

function account(email: string, verified = true): ClerkUserLike {
  return {
    primaryEmailAddressId: 'e1',
    emailAddresses: [
      {
        id: 'e1',
        emailAddress: email,
        verification: { status: verified ? 'verified' : 'unverified' },
      },
    ],
    firstName: null,
    lastName: null,
  }
}

/** A stand-in Clerk instance: its accounts, and which of them the next request is signed in as. */
function fakeInstance(accounts: Record<string, ClerkUserLike>) {
  const state = { signedInAs: null as string | null, tokenAskedFor: [] as string[] }
  const clerk: ClerkClientLike & {
    users: {
      getUserOauthAccessToken(id: string, p: 'google'): Promise<{ data: [{ token: string }] }>
    }
  } = {
    authenticateRequest: async () => ({
      isAuthenticated: state.signedInAs !== null,
      toAuth: () => ({ userId: state.signedInAs }),
    }),
    users: {
      getUser: async (id) => {
        const found = accounts[id]
        if (!found) throw Object.assign(new Error('not found'), { status: 404 })
        return found
      },
      deleteUser: async (id) => {
        delete accounts[id]
      },
      getUserList: async ({ emailAddress, limit = 10, offset = 0 }) => ({
        data: Object.entries(accounts)
          .filter(
            ([, u]) =>
              !emailAddress || emailAddress.includes(u.emailAddresses[0]?.emailAddress ?? ''),
          )
          .slice(offset, offset + limit)
          .map(([id, u]) => ({ id, ...u })),
      }),
      getUserOauthAccessToken: async (id) => {
        state.tokenAskedFor.push(id)
        return { data: [{ token: 'google-token' }] }
      },
    },
    signInTokens: { createSignInToken: async ({ userId }) => ({ token: `ticket:${userId}` }) },
  }
  return { clerk, state, accounts }
}

function authOn(
  instance: ReturnType<typeof fakeInstance>,
  identities: IdentityLedger,
  secretKey: string,
  log: string[] = [],
) {
  return new ClerkAuth({
    clerk: instance.clerk,
    allowedDomains: ['example.test'],
    allowedEmails: ['guest@elsewhere.test'],
    adminEmails: [],
    authorizedParties: [],
    identities,
    instance: instanceOf(secretKey),
    log: (m) => log.push(m),
  })
}

const request = () => new Request('http://localhost/api/me')

describe('moving sign-in to another instance (I5 to I9)', () => {
  it('I5: at startup every existing account goes on record, once, and nobody is removed', async () => {
    const dev = fakeInstance({
      user_ada: account('ada@example.test'),
      user_bo: account('bo@example.test'),
      user_stranger: account('someone@elsewhere.example'),
    })
    const ledger = new IdentityLedger({ log: () => {} })
    const log: string[] = []
    const auth = authOn(dev, ledger, 'sk_test_one', log)
    await auth.recordExistingMembers()
    expect(ledger.memberCount()).toBe(2)
    expect(Object.keys(dev.accounts)).toContain('user_stranger')
    expect(log.at(-1)).toMatch(/2 members on record, 2 with an account in this sign-in instance/)

    dev.accounts.user_cy = account('cy@example.test')
    await auth.recordExistingMembers()
    expect(ledger.memberCount()).toBe(2)
  })

  it('I6: after the move a member signs in with a new id and is the same member', async () => {
    const ledger = new IdentityLedger({ log: () => {} })
    const dev = fakeInstance({ user_old: account('ada@example.test') })
    await authOn(dev, ledger, 'sk_test_one').recordExistingMembers()

    const prod = fakeInstance({ user_new: account('ada@example.test') })
    const auth = authOn(prod, ledger, 'sk_live_two')
    prod.state.signedInAs = 'user_new'
    const principal = await auth.authenticate(request())
    expect(principal).toMatchObject({ userId: 'user_old', email: 'ada@example.test' })
    expect(await auth.principalForUser('user_old')).toEqual(principal)
    // Calls to the sign-in provider use its own id for her.
    expect(await auth.createSignInTicket('user_old')).toBe('ticket:user_new')
    const grant = clerkGoogleGrant(
      prod.clerk,
      () => {},
      (id) => ledger.authIdFor(id, instanceOf('sk_live_two')) ?? id,
    )
    // biome-ignore lint/style/noNonNullAssertion: asserted just above
    await grant(principal!)
    expect(prod.state.tokenAskedFor).toEqual(['user_new'])
  })

  it('I7: until she signs in again her token and device are refused, not revoked; then they work', async () => {
    const dir = await dataDir()
    const ledger = new IdentityLedger({ dataDir: dir, log: () => {} })
    const dev = fakeInstance({ user_old: account('ada@example.test') })
    const tokens = new TokenStore(dir)
    const devices = new DictationStore(path.join(dir, 'dictation.sqlite'))
    const before = new TokenAuth(authOn(dev, ledger, 'sk_test_one'), tokens)
    dev.state.signedInAs = 'user_old'
    // biome-ignore lint/style/noNonNullAssertion: signed in
    const ada = (await before.authenticate(request()))!
    const { token } = await tokens.create(ada, 'Laptop')
    const device = devices.createDevice({ userId: ada.userId, email: ada.email }, 'Mac')
    const withToken = () =>
      new Request('http://localhost/api/me', { headers: { authorization: `Bearer ${token}` } })

    // The move: a new instance with no account for her yet.
    const prod = fakeInstance({})
    const after = new TokenAuth(authOn(prod, ledger, 'sk_live_two'), tokens)
    await expect(after.authenticate(withToken())).rejects.toMatchObject({ code: 'unauthorized' })
    await expect(authenticateDevice(after, devices, device.token)).rejects.toMatchObject({
      code: 'unauthorized',
      message: expect.stringMatching(/Sign in again/),
    })
    expect(devices.listDevices(ada.userId)).toHaveLength(1)

    // She signs in once on the new instance.
    prod.accounts.user_new = account('ada@example.test')
    prod.state.signedInAs = 'user_new'
    expect(await after.authenticate(request())).toMatchObject({ userId: ada.userId })
    expect(await after.authenticate(withToken())).toMatchObject({
      userId: ada.userId,
      via: { kind: 'token' },
    })
    expect((await authenticateDevice(after, devices, device.token)).principal.userId).toBe(
      ada.userId,
    )
    devices.close()
  })

  it('I8: an account already made on the new instance is found by email, without a sign-in', async () => {
    const ledger = new IdentityLedger({ log: () => {} })
    ledger.resolve('user_old', seen('ada@example.test', instanceOf('sk_test_one')))
    const prod = fakeInstance({ user_new: account('ada@example.test') })
    const auth = authOn(prod, ledger, 'sk_live_two')
    expect(await auth.principalForUser('user_old')).toMatchObject({ userId: 'user_old' })
  })

  it("I3: an unverified account with a member's email is not that member", async () => {
    const ledger = new IdentityLedger({ log: () => {} })
    ledger.resolve('user_old', seen('ada@example.test', instanceOf('sk_test_one')))
    const prod = fakeInstance({ user_fake: account('ada@example.test', false) })
    const auth = authOn(prod, ledger, 'sk_live_two')
    prod.state.signedInAs = 'user_fake'
    await expect(auth.authenticate(request())).rejects.toMatchObject({ code: 'unauthorized' })
    await expect(auth.principalForUser('user_old')).rejects.toMatchObject({ code: 'unauthorized' })
  })

  it('I9: an account deleted in the same instance is still gone', async () => {
    const ledger = new IdentityLedger({ log: () => {} })
    const dev = fakeInstance({ user_old: account('ada@example.test') })
    const auth = authOn(dev, ledger, 'sk_test_one')
    await auth.recordExistingMembers()
    delete dev.accounts.user_old
    expect(await auth.principalForUser('user_old')).toBeNull()
  })

  it('an id from before the record is taken as the sign-in id it was', async () => {
    const dev = fakeInstance({ user_old: account('ada@example.test') })
    const auth = authOn(dev, new IdentityLedger({ log: () => {} }), 'sk_test_one')
    expect(await auth.principalForUser('user_old')).toMatchObject({ userId: 'user_old' })
    expect(await auth.principalForUser('user_nobody')).toBeNull()
  })
})
