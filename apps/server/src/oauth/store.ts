import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { newId } from '@hotsauce/format'
import { z } from 'zod'
import type { Principal } from '../auth/index.js'
import { KeyedMutex } from '../git/mutex.js'

/** A connection's access token: works on `/mcp` only, for an hour. */
export const ACCESS_PREFIX = 'hto_'
/** A connection's refresh token: swaps for a new pair, once. */
export const REFRESH_PREFIX = 'htr_'
export const ACCESS_TTL_S = 60 * 60
export const CODE_TTL_MS = 5 * 60 * 1000
export const MAX_CONNECTIONS_PER_MEMBER = 20
export const MAX_CLIENTS = 500
export const MAX_CLIENT_NAME = 80
export const MAX_REDIRECT_URIS = 10
export const MAX_REDIRECT_URI_LENGTH = 2000
/**
 * A refresh token replaced this recently and presented again is a client's retry or two parallel
 * refreshes, not a theft: refused, but the connection is kept.
 */
export const REFRESH_GRACE_MS = 30 * 1000
// Old refresh tokens kept per connection, so presenting one again is caught as a replay.
const OLD_REFRESH_KEPT = 5
const LAST_USED_WRITE_MS = 60 * 60 * 1000

/** An OAuth error as RFC 6749 §5.2 spells it; the routes turn it into a 400/401 JSON answer. */
export class OAuthError extends Error {
  constructor(
    readonly error: string,
    readonly description: string,
    readonly status = 400,
  ) {
    super(description)
  }
}

const StoredClient = z.object({
  id: z.string(),
  name: z.string(),
  redirectUris: z.array(z.string()),
  createdAt: z.string(),
  lastConnectedAt: z.string().nullable(),
})
type StoredClient = z.infer<typeof StoredClient>

/**
 * What a connection may reach: `full` is everything the member sees; `team-read` is the team
 * space only, read only, for a tool many people share (ARCHITECTURE §8.5).
 */
export const ConnectionAccess = z.enum(['full', 'team-read'])
export type ConnectionAccess = z.infer<typeof ConnectionAccess>

const StoredConnection = z.object({
  id: z.string(),
  userId: z.string(),
  email: z.string(),
  clientId: z.string(),
  clientName: z.string(),
  redirectHost: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  accessHash: z.string(),
  accessExpiresAt: z.string(),
  refreshHash: z.string(),
  oldRefreshHashes: z.array(z.string()).default([]),
  /** When the refresh token was last rotated (the grace window for retries). */
  rotatedAt: z.string().nullable().default(null),
  /** What the member allowed: everything they see, or the team space read only (§8.5). */
  access: ConnectionAccess.default('full'),
})
type StoredConnection = z.infer<typeof StoredConnection>

const State = z.object({
  clients: z.array(StoredClient).default([]),
  connections: z.array(StoredConnection).default([]),
})
type State = z.infer<typeof State>

/** A client a sign-in can be for: registered here, or described by its metadata document. */
export interface OAuthClient {
  id: string
  name: string
  redirectUris: string[]
}

/** What a member sees about one of their connections (Settings → Connected apps). */
export interface ConnectionSummary {
  id: string
  clientName: string
  redirectHost: string
  createdAt: string
  lastUsedAt: string | null
  access: ConnectionAccess
}

export interface TokenPair {
  access_token: string
  token_type: 'Bearer'
  expires_in: number
  refresh_token: string
  scope: string
}

export type AccessCheck =
  | {
      ok: true
      connectionId: string
      clientName: string
      userId: string
      access: ConnectionAccess
    }
  | { ok: false; reason: 'unknown' | 'expired' }

interface PendingCode {
  clientId: string
  clientName: string
  redirectUri: string
  challenge: string
  userId: string
  email: string
  access: ConnectionAccess
  expiresAt: number
  used: boolean
  /** Set once exchanged, so a replayed code can revoke what it issued. */
  connectionId?: string
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

/**
 * The hash a connection keeps of one of its tokens. A team-only connection's is salted with its
 * access, so a release that doesn't know team-only (a rollback) never matches it and refuses the
 * connection, rather than reading it as one with full access (ARCHITECTURE §8.5).
 */
function tokenHash(token: string, access: ConnectionAccess): string {
  return access === 'team-read' ? hashSecret(`team-read:${token}`) : hashSecret(token)
}

function mint(prefix: string): string {
  return `${prefix}${randomBytes(32).toString('base64url')}`
}

/** PKCE S256 (RFC 7636 §4.6): base64url(sha256(verifier)) is the challenge. */
export function pkceMatches(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false
  const computed = Buffer.from(createHash('sha256').update(verifier).digest('base64url'))
  const expected = Buffer.from(challenge)
  return computed.length === expected.length && timingSafeEqual(computed, expected)
}

/**
 * A redirect URI a client may use: `https`, or `http` on the loopback host (desktop clients),
 * absolute, with no fragment and no credentials.
 */
export function validRedirectUri(raw: string): boolean {
  if (raw.length > MAX_REDIRECT_URI_LENGTH) return false
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.hash !== '' || raw.includes('#') || url.username || url.password) return false
  if (url.protocol === 'https:') return true
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
}

/** One line, no control characters, at most 80 characters; empty becomes the fallback. */
export function cleanClientName(raw: unknown, fallback: string): string {
  const name =
    typeof raw === 'string'
      ? raw
          .replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, MAX_CLIENT_NAME)
      : ''
  return name || fallback
}

/**
 * OAuth clients and member connections for the MCP server (ARCHITECTURE §8.4). Credentials, so
 * never in Git or the index: `DATA_DIR/oauth/oauth.json`, holding only hashes of tokens.
 * Authorization codes live in memory for five minutes.
 */
export class OAuthStore {
  readonly #file: string
  readonly #lock = new KeyedMutex()
  readonly #codes = new Map<string, PendingCode>()
  readonly #lastWritten = new Map<string, number>()
  readonly #now: () => number
  #loading: Promise<State> | null = null
  #pending: Promise<void> = Promise.resolve()

  constructor(dataDir: string, opts: { now?: () => number } = {}) {
    this.#file = path.join(dataDir, 'oauth', 'oauth.json')
    this.#now = opts.now ?? Date.now
  }

  /** Dynamic client registration (RFC 7591): a public client with its redirect URIs. */
  async registerClient(meta: { redirectUris: string[]; name?: unknown }): Promise<OAuthClient> {
    const { redirectUris } = meta
    if (redirectUris.length === 0 || redirectUris.length > MAX_REDIRECT_URIS) {
      throw new OAuthError(
        'invalid_redirect_uri',
        `Register 1 to ${MAX_REDIRECT_URIS} redirect URIs`,
      )
    }
    for (const uri of redirectUris) {
      if (!validRedirectUri(uri)) {
        throw new OAuthError(
          'invalid_redirect_uri',
          'Redirect URIs must be https (or http on localhost) with no fragment',
        )
      }
    }
    const client: StoredClient = {
      id: newId(),
      name: cleanClientName(meta.name, 'An AI tool'),
      redirectUris: [...new Set(redirectUris)],
      createdAt: new Date(this.#now()).toISOString(),
      lastConnectedAt: null,
    }
    await this.#update((s) => {
      s.clients.push(client)
      if (s.clients.length > MAX_CLIENTS) {
        // Never the client just registered. Clients with no live connection go first, then the
        // one connected (or registered) longest ago.
        const live = new Set(s.connections.map((c) => c.clientId))
        const order = s.clients
          .filter((c) => c.id !== client.id)
          .sort(
            (a, b) =>
              Number(live.has(a.id)) - Number(live.has(b.id)) ||
              (a.lastConnectedAt ?? a.createdAt).localeCompare(b.lastConnectedAt ?? b.createdAt),
          )
        const drop = new Set(order.slice(0, s.clients.length - MAX_CLIENTS).map((c) => c.id))
        s.clients = s.clients.filter((c) => !drop.has(c.id))
      }
    })
    return { id: client.id, name: client.name, redirectUris: client.redirectUris }
  }

  /** A client registered here, or null. (Metadata-document clients are resolved by the caller.) */
  async registeredClient(id: string): Promise<OAuthClient | null> {
    const found = (await this.#load()).clients.find((c) => c.id === id)
    return found ? { id: found.id, name: found.name, redirectUris: found.redirectUris } : null
  }

  /** A one-time code for a member who pressed Allow; the PKCE challenge is checked at exchange. */
  issueCode(input: {
    client: OAuthClient
    redirectUri: string
    challenge: string
    principal: Principal
    /** Defaults to `full`, as every connection was before §8.5. */
    access?: ConnectionAccess
  }): string {
    this.#sweepCodes()
    const code = mint('htc_')
    this.#codes.set(hashSecret(code), {
      clientId: input.client.id,
      clientName: input.client.name,
      redirectUri: input.redirectUri,
      challenge: input.challenge,
      userId: input.principal.userId,
      email: input.principal.email,
      access: input.access ?? 'full',
      expiresAt: this.#now() + CODE_TTL_MS,
      used: false,
    })
    return code
  }

  /** The authorization_code grant: a new connection and its first token pair. */
  async exchangeCode(input: {
    code: string
    clientId: string
    /** Optional in OAuth 2.1; when sent it must be the one the code was issued for. */
    redirectUri?: string
    verifier: string
  }): Promise<TokenPair> {
    const key = hashSecret(input.code)
    const pending = this.#codes.get(key)
    if (!pending || pending.expiresAt < this.#now()) {
      this.#codes.delete(key)
      throw new OAuthError('invalid_grant', 'The code is unknown or has expired')
    }
    if (pending.used) {
      // A code presented twice was stolen or replayed: revoke what it issued (RFC 6749 §4.1.2).
      this.#codes.delete(key)
      if (pending.connectionId) await this.#remove(pending.connectionId)
      throw new OAuthError('invalid_grant', 'The code was already used')
    }
    // A failed check uses the code up too (OAuth 2.1 §4.1.3): the client starts again.
    if (pending.clientId !== input.clientId) {
      this.#codes.delete(key)
      throw new OAuthError('invalid_grant', 'The code was issued to another client')
    }
    if (input.redirectUri !== undefined && pending.redirectUri !== input.redirectUri) {
      this.#codes.delete(key)
      throw new OAuthError('invalid_grant', 'redirect_uri does not match the authorization request')
    }
    if (!pkceMatches(input.verifier, pending.challenge)) {
      this.#codes.delete(key)
      throw new OAuthError('invalid_grant', 'The PKCE code_verifier does not match')
    }
    pending.used = true
    const access = mint(ACCESS_PREFIX)
    const refresh = mint(REFRESH_PREFIX)
    const now = new Date(this.#now()).toISOString()
    const connection: StoredConnection = {
      id: newId(),
      userId: pending.userId,
      email: pending.email,
      clientId: pending.clientId,
      clientName: pending.clientName,
      redirectHost: new URL(pending.redirectUri).host,
      createdAt: now,
      lastUsedAt: now,
      accessHash: tokenHash(access, pending.access),
      accessExpiresAt: new Date(this.#now() + ACCESS_TTL_S * 1000).toISOString(),
      refreshHash: tokenHash(refresh, pending.access),
      oldRefreshHashes: [],
      rotatedAt: null,
      access: pending.access,
    }
    pending.connectionId = connection.id
    await this.#update((s) => {
      s.connections.push(connection)
      const mine = s.connections
        .filter((c) => c.userId === connection.userId)
        .sort((a, b) => (a.lastUsedAt ?? a.createdAt).localeCompare(b.lastUsedAt ?? b.createdAt))
      const excess = mine.length - MAX_CONNECTIONS_PER_MEMBER
      if (excess > 0) {
        const drop = new Set(mine.slice(0, excess).map((c) => c.id))
        s.connections = s.connections.filter((c) => !drop.has(c.id))
      }
      const client = s.clients.find((c) => c.id === connection.clientId)
      if (client) client.lastConnectedAt = now
    })
    return pair(access, refresh)
  }

  /** The refresh_token grant: rotates the pair; an old refresh token again revokes everything. */
  async refresh(input: { refreshToken: string; clientId: string }): Promise<TokenPair> {
    const hashFor = (c: StoredConnection) => tokenHash(input.refreshToken, c.access)
    const access = mint(ACCESS_PREFIX)
    const refresh = mint(REFRESH_PREFIX)
    let outcome = 'unknown' as 'ok' | 'replay' | 'retry' | 'unknown' | 'client'
    await this.#update((s) => {
      const current = s.connections.find((c) => c.refreshHash === hashFor(c))
      if (!current) {
        const replayed = s.connections.find((c) => c.oldRefreshHashes.includes(hashFor(c)))
        if (!replayed) return
        const justRotated =
          replayed.oldRefreshHashes[0] === hashFor(replayed) &&
          replayed.rotatedAt !== null &&
          this.#now() - Date.parse(replayed.rotatedAt) < REFRESH_GRACE_MS
        if (justRotated) {
          outcome = 'retry'
          return
        }
        s.connections = s.connections.filter((c) => c.id !== replayed.id)
        outcome = 'replay'
        return
      }
      if (current.clientId !== input.clientId) {
        outcome = 'client'
        return
      }
      current.oldRefreshHashes = [current.refreshHash, ...current.oldRefreshHashes].slice(
        0,
        OLD_REFRESH_KEPT,
      )
      current.refreshHash = tokenHash(refresh, current.access)
      current.accessHash = tokenHash(access, current.access)
      current.accessExpiresAt = new Date(this.#now() + ACCESS_TTL_S * 1000).toISOString()
      current.lastUsedAt = new Date(this.#now()).toISOString()
      current.rotatedAt = current.lastUsedAt
      outcome = 'ok'
    })
    if (outcome === 'ok') return pair(access, refresh)
    if (outcome === 'client') {
      throw new OAuthError('invalid_grant', 'The refresh token was issued to another client')
    }
    if (outcome === 'retry') {
      throw new OAuthError(
        'invalid_grant',
        'That refresh token was just replaced by another request; use the newer tokens',
      )
    }
    if (outcome === 'replay') {
      throw new OAuthError(
        'invalid_grant',
        'That refresh token was already used, so the connection was ended. Connect again.',
      )
    }
    throw new OAuthError('invalid_grant', 'The refresh token is unknown or was revoked')
  }

  /** An access token's connection, `expired`, or `unknown` (also for an unreadable store). */
  async verifyAccess(token: string): Promise<AccessCheck> {
    if (!token.startsWith(ACCESS_PREFIX)) return { ok: false, reason: 'unknown' }
    let state: State
    try {
      state = await this.#load()
    } catch (err) {
      console.error(`oauth: refusing every connection until the store can be read: ${err}`)
      return { ok: false, reason: 'unknown' }
    }
    const found = state.connections.find((c) => c.accessHash === tokenHash(token, c.access))
    if (!found) return { ok: false, reason: 'unknown' }
    if (Date.parse(found.accessExpiresAt) <= this.#now()) return { ok: false, reason: 'expired' }
    this.#recordUse(found)
    return {
      ok: true,
      connectionId: found.id,
      clientName: found.clientName,
      userId: found.userId,
      access: found.access,
    }
  }

  /** RFC 7009: a client dropping its own access or refresh token ends that connection. */
  async revokeToken(token: string): Promise<void> {
    await this.#update((s) => {
      s.connections = s.connections.filter((c) => {
        const hash = tokenHash(token, c.access)
        return c.accessHash !== hash && c.refreshHash !== hash
      })
    })
  }

  async list(principal: Principal): Promise<ConnectionSummary[]> {
    return (await this.#load()).connections
      .filter((c) => c.userId === principal.userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((c) => ({
        id: c.id,
        clientName: c.clientName,
        redirectHost: c.redirectHost,
        createdAt: c.createdAt,
        lastUsedAt: c.lastUsedAt,
        access: c.access,
      }))
  }

  /** Ends one of the member's own connections; anyone else's is reported as missing. */
  async disconnect(principal: Principal, id: string): Promise<boolean> {
    let removed = false
    await this.#update((s) => {
      const before = s.connections.length
      s.connections = s.connections.filter((c) => !(c.id === id && c.userId === principal.userId))
      removed = s.connections.length < before
    })
    return removed
  }

  /** Resolves once a last-use write started by `verifyAccess` has finished (tests, shutdown). */
  async idle(): Promise<void> {
    await this.#pending
  }

  async #remove(id: string): Promise<void> {
    await this.#update((s) => {
      s.connections = s.connections.filter((c) => c.id !== id)
    })
  }

  #sweepCodes(): void {
    const now = this.#now()
    for (const [key, code] of this.#codes) {
      // A used code is kept until it expires, so a replay within its life is caught.
      if (code.expiresAt < now) this.#codes.delete(key)
    }
  }

  #recordUse(connection: StoredConnection): void {
    const now = this.#now()
    connection.lastUsedAt = new Date(now).toISOString()
    if (now - (this.#lastWritten.get(connection.id) ?? 0) < LAST_USED_WRITE_MS) return
    this.#lastWritten.set(connection.id, now)
    this.#pending = this.#update((s) => {
      const found = s.connections.find((c) => c.id === connection.id)
      if (found) found.lastUsedAt = connection.lastUsedAt
    }).catch((err: unknown) => {
      console.error(`oauth: could not record a use of ${connection.id}: ${err}`)
    })
  }

  #load(): Promise<State> {
    this.#loading ??= this.#read().catch((err: unknown) => {
      this.#loading = null
      throw err
    })
    return this.#loading
  }

  async #read(): Promise<State> {
    let text: string
    try {
      text = await readFile(this.#file, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { clients: [], connections: [] }
      throw err
    }
    try {
      return State.parse(JSON.parse(text))
    } catch (err) {
      throw new Error(`${this.#file} is unreadable: ${err}`)
    }
  }

  #update(change: (s: State) => void): Promise<void> {
    return this.#lock.run('state', async () => {
      const state = await this.#load()
      const next: State = {
        clients: state.clients.map((c) => ({ ...c, redirectUris: [...c.redirectUris] })),
        connections: state.connections.map((c) => ({
          ...c,
          oldRefreshHashes: [...c.oldRefreshHashes],
        })),
      }
      change(next)
      await mkdir(path.dirname(this.#file), { recursive: true, mode: 0o700 })
      await writeFile(`${this.#file}.tmp`, JSON.stringify(next), { mode: 0o600 })
      await rename(`${this.#file}.tmp`, this.#file)
      this.#loading = Promise.resolve(next)
    })
  }
}

function pair(access: string, refresh: string): TokenPair {
  return {
    access_token: access,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_S,
    refresh_token: refresh,
    scope: 'mcp',
  }
}
