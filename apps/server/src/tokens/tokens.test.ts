import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Authenticator, Principal } from '../auth/index.js'
import { DevAuth } from '../auth/index.js'
import { TokenAuth } from './auth.js'
import { hashToken, MAX_TOKENS_PER_MEMBER, TokenStore } from './store.js'

const alice: Principal = {
  userId: 'user_alice',
  email: 'alice@example.test',
  name: 'Alice',
  handle: 'alice',
  isAdmin: false,
}
const bob: Principal = { ...alice, userId: 'user_bob', email: 'bob@example.test', handle: 'bob' }

let dir: string
let store: TokenStore

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hearth-tokens-'))
  store = new TokenStore(dir)
})

afterEach(async () => {
  await store.idle()
  await rm(dir, { recursive: true, force: true })
})

describe('TokenStore', () => {
  it('mints a token shown once, stores only its hash, and verifies it', async () => {
    const created = await store.create(alice, '  Claude   Code ')
    expect(created.name).toBe('Claude Code')
    expect(created.token).toMatch(/^hth_[A-Za-z0-9_-]{43}$/)
    const file = await readFile(join(dir, 'tokens', 'tokens.json'), 'utf8')
    expect(file).not.toContain(created.token)
    expect(file).toContain(hashToken(created.token))
    expect(await store.verify(created.token)).toEqual({
      id: created.id,
      name: 'Claude Code',
      userId: 'user_alice',
    })
    expect(await store.verify(`${created.token}x`)).toBeNull()
    expect(await store.verify('not-a-token')).toBeNull()
  })

  it('survives a restart, and a revoked token is gone for good', async () => {
    const created = await store.create(alice, 'laptop')
    const reopened = new TokenStore(dir)
    expect(await reopened.verify(created.token)).not.toBeNull()
    await reopened.revoke(alice, created.id)
    expect(await reopened.verify(created.token)).toBeNull()
    expect(await new TokenStore(dir).verify(created.token)).toBeNull()
    await reopened.idle()
  })

  it('lists and revokes only the member’s own tokens', async () => {
    const mine = await store.create(alice, 'mine')
    await store.create(bob, 'his')
    expect((await store.list(alice)).map((t) => t.name)).toEqual(['mine'])
    await expect(store.revoke(bob, mine.id)).rejects.toMatchObject({ code: 'not_found' })
    expect(await store.verify(mine.token)).not.toBeNull()
  })

  it('caps tokens per member and validates names', async () => {
    for (let i = 0; i < MAX_TOKENS_PER_MEMBER; i++) await store.create(alice, `t${i}`)
    await expect(store.create(alice, 'one more')).rejects.toMatchObject({ code: 'bad_request' })
    await expect(store.create(bob, ' ')).rejects.toMatchObject({ code: 'bad_request' })
    await expect(store.create(bob, 'x'.repeat(81))).rejects.toMatchObject({ code: 'bad_request' })
    expect(await store.list(bob)).toEqual([])
  })

  it('records the last use, writing it at most hourly', async () => {
    const created = await store.create(alice, 'cli')
    await store.verify(created.token)
    const [listed] = await store.list(alice)
    expect(listed?.lastUsedAt).toEqual(expect.any(String))
  })

  it('starts with no tokens when the file is unreadable (fail closed)', async () => {
    const created = await store.create(alice, 'cli')
    await writeFile(join(dir, 'tokens', 'tokens.json'), '{not json')
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const broken = new TokenStore(dir)
    expect(await broken.verify(created.token)).toBeNull()
    expect(errors).toHaveBeenCalled()
    // A write refuses instead of replacing the file with an empty list.
    await expect(broken.create(alice, 'new')).rejects.toThrow(/unreadable/)
    expect(await readFile(join(dir, 'tokens', 'tokens.json'), 'utf8')).toBe('{not json')
    errors.mockRestore()
  })
})

describe('TokenAuth', () => {
  function inner(principal: Principal | null) {
    const auth: Authenticator = {
      authenticate: vi.fn(async () => ({ ...alice, userId: 'session' })),
      principalForUser: vi.fn(async () => principal),
    }
    return auth
  }
  const req = (authorization?: string) =>
    new Request('http://localhost/api/me', {
      headers: authorization ? { authorization } : {},
    })

  it('turns a token into its member, marked as a token, without asking the inner auth', async () => {
    const { token, id } = await store.create(alice, 'Claude Code')
    const base = inner(alice)
    const principal = await new TokenAuth(base, store).authenticate(req(`Bearer ${token}`))
    expect(principal).toEqual({
      ...alice,
      via: { kind: 'token', tokenId: id, tokenName: 'Claude Code' },
    })
    expect(base.authenticate).not.toHaveBeenCalled()
    expect(base.principalForUser).toHaveBeenCalledWith('user_alice')
  })

  it('is unauthenticated for an unknown token, never falling through to the session auth', async () => {
    const base = inner(alice)
    expect(await new TokenAuth(base, store).authenticate(req('Bearer hth_bogus'))).toBeNull()
    expect(base.authenticate).not.toHaveBeenCalled()
  })

  it('is unauthenticated once the member no longer exists', async () => {
    const { token } = await store.create(alice, 'old')
    expect(await new TokenAuth(inner(null), store).authenticate(req(`Bearer ${token}`))).toBeNull()
  })

  it('passes sessions and other bearer tokens to the inner auth', async () => {
    const base = inner(alice)
    const auth = new TokenAuth(base, store)
    expect((await auth.authenticate(req('Bearer eyJhbGciOi.clerk.jwt')))?.userId).toBe('session')
    expect((await auth.authenticate(req()))?.userId).toBe('session')
    expect(base.authenticate).toHaveBeenCalledTimes(2)
  })

  it('works with DevAuth user ids, and keeps the domain lock', async () => {
    const dev = new DevAuth({ allowedDomains: ['example.test'], adminEmails: [] })
    expect((await dev.principalForUser('dev:alice@example.test'))?.email).toBe('alice@example.test')
    expect(await dev.principalForUser('user_123')).toBeNull()
    await expect(dev.principalForUser('dev:eve@example.com')).rejects.toMatchObject({
      code: 'domain_not_allowed',
    })
  })
})
