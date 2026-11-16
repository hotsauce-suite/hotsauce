import { createHash, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Principal } from '../auth/index.js'
import {
  MAX_CLIENTS,
  MAX_CONNECTIONS_PER_MEMBER,
  type OAuthClient,
  OAuthStore,
  REFRESH_GRACE_MS,
} from './store.js'

const alice: Principal = {
  userId: 'u_alice',
  email: 'alice@example.test',
  name: 'Alice',
  handle: 'alice',
  isAdmin: false,
}
const REDIRECT = 'https://tool.example/cb'

let dir: string
let now: number
let store: OAuthStore

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'oauth-store-'))
  now = Date.parse('2026-11-15T12:00:00Z')
  store = new OAuthStore(dir, { now: () => now })
})
afterEach(async () => {
  await store.idle()
  await rm(dir, { recursive: true, force: true })
})

async function connect(client: OAuthClient, who = alice) {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const code = store.issueCode({ client, redirectUri: REDIRECT, challenge, principal: who })
  return store.exchangeCode({ code, clientId: client.id, verifier })
}

describe('OAuthStore', () => {
  it('keeps a new registration when the registry is full of clients that once connected', async () => {
    const first = await store.registerClient({ redirectUris: [REDIRECT], name: 'first' })
    const pair = await connect(first)
    // Fill up with clients that connected and were later disconnected.
    for (let i = 1; i < MAX_CLIENTS; i++) {
      now += 1000
      const c = await store.registerClient({ redirectUris: [REDIRECT], name: `c${i}` })
      const p = await connect(c)
      await store.revokeToken(p.refresh_token)
    }
    now += 1000
    const fresh = await store.registerClient({ redirectUris: [REDIRECT], name: 'fresh' })
    expect(await store.registeredClient(fresh.id)).not.toBeNull()
    // The one with a live connection is kept; the oldest idle one went.
    expect(await store.registeredClient(first.id)).not.toBeNull()
    expect((await store.verifyAccess(pair.access_token)).ok).toBe(true)
  }, 60_000)

  it('drops the connection used longest ago past the per-member limit', async () => {
    const client = await store.registerClient({ redirectUris: [REDIRECT] })
    const first = await connect(client)
    for (let i = 0; i < MAX_CONNECTIONS_PER_MEMBER; i++) {
      now += 1000
      await connect(client)
    }
    expect(await store.list(alice)).toHaveLength(MAX_CONNECTIONS_PER_MEMBER)
    expect((await store.verifyAccess(first.access_token)).ok).toBe(false)
  })

  it('a retry inside the grace window keeps the connection; a replay after it ends it', async () => {
    const client = await store.registerClient({ redirectUris: [REDIRECT] })
    const first = await connect(client)
    const second = await store.refresh({ refreshToken: first.refresh_token, clientId: client.id })
    await expect(
      store.refresh({ refreshToken: first.refresh_token, clientId: client.id }),
    ).rejects.toThrow(/just replaced/)
    expect((await store.verifyAccess(second.access_token)).ok).toBe(true)
    now += REFRESH_GRACE_MS + 1
    await expect(
      store.refresh({ refreshToken: first.refresh_token, clientId: client.id }),
    ).rejects.toThrow(/already used/)
    expect((await store.verifyAccess(second.access_token)).ok).toBe(false)
  })

  it('an access token expires after an hour', async () => {
    const client = await store.registerClient({ redirectUris: [REDIRECT] })
    const pair = await connect(client)
    now += 3600 * 1000 + 1
    expect(await store.verifyAccess(pair.access_token)).toEqual({ ok: false, reason: 'expired' })
  })

  it('stores only hashes of tokens', async () => {
    const client = await store.registerClient({ redirectUris: [REDIRECT] })
    const pair = await connect(client)
    await store.idle()
    const { readFile } = await import('node:fs/promises')
    const text = await readFile(path.join(dir, 'oauth', 'oauth.json'), 'utf8')
    expect(text).not.toContain(pair.access_token)
    expect(text).not.toContain(pair.refresh_token)
  })

  it('an unreadable file refuses every connection and is never replaced', async () => {
    await mkdir(path.join(dir, 'oauth'), { recursive: true })
    await writeFile(path.join(dir, 'oauth', 'oauth.json'), '{ not json')
    const broken = new OAuthStore(dir)
    expect(await broken.verifyAccess('hto_anything')).toEqual({ ok: false, reason: 'unknown' })
    await expect(broken.registerClient({ redirectUris: [REDIRECT] })).rejects.toThrow()
    const { readFile } = await import('node:fs/promises')
    expect(await readFile(path.join(dir, 'oauth', 'oauth.json'), 'utf8')).toBe('{ not json')
  })
})
