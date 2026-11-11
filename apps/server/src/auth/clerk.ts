import {
  type Authenticator,
  domainNotAllowed,
  isAllowedEmailDomain,
  nameFromEmail,
  type Principal,
  toPrincipal,
} from './principal.js'

/** The slice of `@clerk/backend`'s ClerkClient we use; the real client satisfies it structurally. */
export interface ClerkClientLike {
  authenticateRequest(
    request: Request,
    options: { authorizedParties: string[] },
  ): Promise<{ isAuthenticated: boolean; toAuth(): { userId: string | null } | null }>
  users: {
    getUser(userId: string): Promise<ClerkUserLike>
    deleteUser(userId: string): Promise<unknown>
  }
}

export interface ClerkUserLike {
  primaryEmailAddressId: string | null
  emailAddresses: ReadonlyArray<{ id: string; emailAddress: string }>
  firstName: string | null
  lastName: string | null
  /** Banned or locked in the Clerk dashboard: treated as gone, so their access tokens stop too. */
  banned?: boolean
  locked?: boolean
}

const USER_CACHE_TTL_MS = 5 * 60 * 1000

interface CachedUser {
  email: string
  name: string
  expiresAt: number
}

export class ClerkAuth implements Authenticator {
  readonly #clerk: ClerkClientLike
  readonly #allowedDomains: readonly string[]
  readonly #adminEmails: readonly string[]
  readonly #authorizedParties: string[]
  readonly #users = new Map<string, CachedUser>()

  constructor(opts: {
    clerk: ClerkClientLike
    allowedDomains: readonly string[]
    adminEmails: readonly string[]
    /** Origins allowed in the token's `azp` claim; empty skips the check. */
    authorizedParties: string[]
  }) {
    this.#clerk = opts.clerk
    this.#allowedDomains = opts.allowedDomains
    this.#adminEmails = opts.adminEmails
    this.#authorizedParties = opts.authorizedParties
  }

  async authenticate(req: Request): Promise<Principal | null> {
    const state = await this.#clerk.authenticateRequest(req, {
      authorizedParties: this.#authorizedParties,
    })
    if (!state.isAuthenticated) return null
    const userId = state.toAuth()?.userId
    if (!userId) return null

    return this.principalForUser(userId)
  }

  async principalForUser(userId: string): Promise<Principal | null> {
    const user = await this.#loadUser(userId)
    if (!user) return null
    return toPrincipal({ userId, email: user.email, name: user.name }, this.#adminEmails)
  }

  async #loadUser(userId: string): Promise<CachedUser | null> {
    const cached = this.#users.get(userId)
    if (cached && cached.expiresAt > Date.now()) return cached

    let user: ClerkUserLike
    try {
      user = await this.#clerk.users.getUser(userId)
    } catch (err) {
      // A user we just deleted for the domain lock can still hold an unexpired session token.
      if (isNotFound(err)) return null
      throw err
    }

    if (user.banned || user.locked) return null

    const email =
      user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId)?.emailAddress ?? ''
    if (!isAllowedEmailDomain(email, this.#allowedDomains)) {
      await this.#clerk.users.deleteUser(userId)
      throw domainNotAllowed(email || userId, this.#allowedDomains)
    }

    const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || nameFromEmail(email)
    const entry = { email, name, expiresAt: Date.now() + USER_CACHE_TTL_MS }
    this.#users.set(userId, entry)
    return entry
  }
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'status' in err && err.status === 404
}
