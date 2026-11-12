import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { newId } from '@hearth/format'
import { z } from 'zod'
import type { Principal } from '../auth/index.js'
import { HearthError } from '../errors.js'
import { KeyedMutex } from '../git/mutex.js'

/** Every access token starts with this, so a request can tell a token from a Clerk session. */
export const TOKEN_PREFIX = 'hth_'
export const MAX_TOKENS_PER_MEMBER = 20
export const MAX_TOKEN_NAME = 80
// lastUsedAt is kept in memory on every use and written at most this often per token.
const LAST_USED_WRITE_MS = 60 * 60 * 1000

const Stored = z.object({
  id: z.string(),
  name: z.string(),
  /** SHA-256 of the whole token, hex. The token itself is never stored. */
  hash: z.string(),
  hint: z.string(),
  userId: z.string(),
  email: z.string(),
  memberName: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
})
type StoredToken = z.infer<typeof Stored>
const State = z.object({ tokens: z.array(Stored).default([]) })
type State = z.infer<typeof State>

/** What a member sees about one of their tokens. */
export interface TokenSummary {
  id: string
  name: string
  /** The token's last four characters, so a member can tell which one is which. */
  hint: string
  createdAt: string
  lastUsedAt: string | null
}

export interface TokenOwner {
  id: string
  name: string
  userId: string
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function mintToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
}

/**
 * Personal access tokens (ARCHITECTURE §8.1). A credential, so never in Git, and not in
 * index.sqlite, which is a disposable cache: it lives on the volume at
 * `DATA_DIR/tokens/tokens.json`. Losing the file revokes every token.
 */
export class TokenStore {
  readonly #file: string
  readonly #lock = new KeyedMutex()
  readonly #lastWritten = new Map<string, number>()
  #loading: Promise<State> | null = null
  #pending: Promise<void> = Promise.resolve()

  constructor(dataDir: string) {
    this.#file = path.join(dataDir, 'tokens', 'tokens.json')
  }

  async list(principal: Principal): Promise<TokenSummary[]> {
    const tokens = (await this.#load()).tokens.filter((t) => t.userId === principal.userId)
    return tokens.map(summary)
  }

  /** Mints a token for the member; the returned `token` is the only time it is ever seen. */
  async create(principal: Principal, rawName: string): Promise<TokenSummary & { token: string }> {
    const name = rawName.replace(/\s+/g, ' ').trim()
    if (name === '' || name.length > MAX_TOKEN_NAME) {
      throw new HearthError('bad_request', `A token name is 1 to ${MAX_TOKEN_NAME} characters`)
    }
    const token = mintToken()
    let created: StoredToken | null = null
    await this.#update((s) => {
      const mine = s.tokens.filter((t) => t.userId === principal.userId)
      if (mine.length >= MAX_TOKENS_PER_MEMBER) {
        throw new HearthError(
          'bad_request',
          `You have ${MAX_TOKENS_PER_MEMBER} tokens already. Revoke one you no longer use first.`,
        )
      }
      created = {
        id: newId(),
        name,
        hash: hashToken(token),
        hint: token.slice(-4),
        userId: principal.userId,
        email: principal.email,
        memberName: principal.name,
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
      }
      s.tokens.push(created)
    })
    // biome-ignore lint/style/noNonNullAssertion: set inside the update, which threw otherwise
    return { ...summary(created!), token }
  }

  /** Revokes one of the member's own tokens; anyone else's (or an unknown id) is not_found. */
  async revoke(principal: Principal, id: string): Promise<void> {
    await this.#update((s) => {
      const before = s.tokens.length
      s.tokens = s.tokens.filter((t) => !(t.id === id && t.userId === principal.userId))
      if (s.tokens.length === before) throw new HearthError('not_found', 'No such token')
    })
    this.#lastWritten.delete(id)
  }

  /** The token's owner, or null for a token that is unknown or revoked. Records the use. */
  async verify(token: string): Promise<TokenOwner | null> {
    if (!token.startsWith(TOKEN_PREFIX)) return null
    const hash = hashToken(token)
    let state: State
    try {
      state = await this.#load()
    } catch (err) {
      console.error(`tokens: refusing every token until the store can be read: ${err}`)
      return null
    }
    const found = state.tokens.find((t) => t.hash === hash)
    if (!found) return null
    this.#recordUse(found)
    return { id: found.id, name: found.name, userId: found.userId }
  }

  #recordUse(token: StoredToken): void {
    const now = Date.now()
    token.lastUsedAt = new Date(now).toISOString()
    if (now - (this.#lastWritten.get(token.id) ?? 0) < LAST_USED_WRITE_MS) return
    this.#lastWritten.set(token.id, now)
    // The in-memory state already has it; this only persists it. A failure costs a timestamp.
    this.#pending = this.#update(() => {}).catch((err: unknown) => {
      console.error(`tokens: could not record a use of ${token.id}: ${err}`)
    })
  }

  /** Resolves once a last-use write started by `verify` has finished (shutdown and tests). */
  async idle(): Promise<void> {
    await this.#pending
  }

  /**
   * The tokens on disk, read once. A missing file is no tokens. An unreadable one is an error
   * that isn't cached: `verify` treats it as no match (fail closed), and writes refuse rather
   * than replace the file with an empty list.
   */
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
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { tokens: [] }
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
      const next: State = { tokens: state.tokens.map((t) => ({ ...t })) }
      change(next)
      await mkdir(path.dirname(this.#file), { recursive: true, mode: 0o700 })
      await writeFile(`${this.#file}.tmp`, JSON.stringify(next), { mode: 0o600 })
      await rename(`${this.#file}.tmp`, this.#file)
      this.#loading = Promise.resolve(next)
    })
  }
}

function summary(t: StoredToken): TokenSummary {
  return { id: t.id, name: t.name, hint: t.hint, createdAt: t.createdAt, lastUsedAt: t.lastUsedAt }
}
