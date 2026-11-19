import { HotsauceError } from '../errors.js'
import { IdentityLedger } from './identities.js'
import {
  type Authenticator,
  domainNotAllowed,
  nameFromEmail,
  type Principal,
  signInAllowance,
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
    /** Used to find a member's account by email, and to record every account once at startup. */
    getUserList?(params: {
      emailAddress?: string[]
      limit?: number
      offset?: number
      orderBy?: '+created_at'
    }): Promise<{ data: ReadonlyArray<ClerkUserLike & { id: string }> }>
  }
  signInTokens?: {
    createSignInToken(params: {
      userId: string
      expiresInSeconds: number
    }): Promise<{ token: string }>
  }
}

/** A desktop sign-in ticket is used within seconds of being made; Clerk's tokens are single use. */
export const SIGN_IN_TICKET_SECONDS = 60

export interface ClerkUserLike {
  primaryEmailAddressId: string | null
  emailAddresses: ReadonlyArray<{
    id: string
    emailAddress: string
    /** Clerk's proof the person holds the mailbox (an emailed code, or Google vouching for it). */
    verification?: { status: string } | null
  }>
  firstName: string | null
  lastName: string | null
  /** Banned or locked in the Clerk dashboard: treated as gone, so their access tokens stop too. */
  banned?: boolean
  locked?: boolean
  /** Their picture at the sign-in service (their Google photo); `hasImage` is false for a placeholder. */
  imageUrl?: string
  hasImage?: boolean
}

const USER_CACHE_TTL_MS = 5 * 60 * 1000
/** How long "this member has no account in this sign-in instance yet" is believed. */
const ABSENT_TTL_MS = 60 * 1000
const LIST_PAGE = 100

interface CachedUser {
  /** Our id for the member (auth/identities.ts), which is what `Principal.userId` carries. */
  member: string
  email: string
  name: string
  invited: boolean
  expiresAt: number
}

export class ClerkAuth implements Authenticator {
  readonly #clerk: ClerkClientLike
  readonly #allowedDomains: readonly string[]
  readonly #allowedEmails: readonly string[]
  readonly #adminEmails: readonly string[]
  readonly #authorizedParties: string[]
  readonly #identities: IdentityLedger
  readonly #instance: string
  readonly #log: (message: string) => void
  readonly #onPhoto: ((email: string, url: string | null) => void) | undefined
  /** Clerk user id → the user as last loaded. */
  readonly #users = new Map<string, CachedUser>()
  /** Member id → until when not to ask Clerk again for an account that wasn't there. */
  readonly #absent = new Map<string, number>()

  constructor(opts: {
    clerk: ClerkClientLike
    allowedDomains: readonly string[]
    /** Exact addresses invited from outside the allowed domains. */
    allowedEmails?: readonly string[]
    adminEmails: readonly string[]
    /** Origins allowed in the token's `azp` claim; empty skips the check. */
    authorizedParties: string[]
    /** Who each member is across sign-in instances; kept in memory when not given (tests). */
    identities?: IdentityLedger
    /** Names this Clerk instance in `identities` (auth/identities.ts `instanceOf`). */
    instance?: string
    log?: (message: string) => void
    /** Told each member's sign-in picture (null: none) whenever their account is read. */
    onPhoto?: (email: string, url: string | null) => void
  }) {
    this.#clerk = opts.clerk
    this.#allowedDomains = opts.allowedDomains
    this.#allowedEmails = opts.allowedEmails ?? []
    this.#adminEmails = opts.adminEmails
    this.#authorizedParties = opts.authorizedParties
    this.#log = opts.log ?? console.log
    this.#identities = opts.identities ?? new IdentityLedger({ log: this.#log })
    this.#instance = opts.instance ?? 'default'
    this.#onPhoto = opts.onPhoto
  }

  async authenticate(req: Request): Promise<Principal | null> {
    const state = await this.#clerk.authenticateRequest(req, {
      authorizedParties: this.#authorizedParties,
    })
    if (!state.isAuthenticated) return null
    const userId = state.toAuth()?.userId
    if (!userId) return null

    const user = await this.#loadUser(userId)
    return user ? this.#principal(user) : null
  }

  async principalForUser(userId: string): Promise<Principal | null> {
    const user = await this.#loadUser(await this.authIdFor(userId))
    return user ? this.#principal(user) : null
  }

  async createSignInTicket(userId: string): Promise<string> {
    if (!this.#clerk.signInTokens) throw new Error('This Clerk client cannot make sign-in tokens')
    const { token } = await this.#clerk.signInTokens.createSignInToken({
      userId: await this.authIdFor(userId),
      expiresInSeconds: SIGN_IN_TICKET_SECONDS,
    })
    return token
  }

  /**
   * The Clerk user id a member has in this instance, for calls to Clerk. A member known only
   * from another instance (sign-in moved from development to production, say) is looked up by
   * email; until they have an account here this refuses with `unauthorized` rather than saying
   * they are gone, so their devices and connections wait for them instead of being revoked.
   */
  async authIdFor(member: string): Promise<string> {
    const here = this.#identities.authIdFor(member, this.#instance)
    if (here) return here
    const email = this.#identities.emailOf(member)
    // Not a member this record knows: an id from before the record, taken as Clerk's own.
    if (email === null) return member

    const signInAgain = new HotsauceError(
      'unauthorized',
      'Sign in again to reconnect: sign-in for this workspace has moved.',
    )
    if ((this.#absent.get(member) ?? 0) > Date.now()) throw signInAgain
    const found = await this.#clerk.users.getUserList?.({ emailAddress: [email], limit: 10 })
    for (const candidate of found?.data ?? []) {
      // The lookup also matches secondary and unverified addresses; only a verified primary counts.
      const primary = primaryEmail(candidate)
      if (!primary.verified || primary.email.toLowerCase() !== email) continue
      const user = await this.#loadUser(candidate.id).catch(() => null)
      if (user?.member === member) return candidate.id
    }
    this.#absent.set(member, Date.now() + ABSENT_TTL_MS)
    throw signInAgain
  }

  /**
   * Records every account this Clerk instance has, once per instance, so that each member's id
   * is known before sign-in ever moves to another instance. Never removes or refuses anyone.
   */
  async recordExistingMembers(): Promise<void> {
    const list = this.#clerk.users.getUserList?.bind(this.#clerk.users)
    if (list && !this.#identities.wasListed(this.#instance)) {
      for (let offset = 0; ; offset += LIST_PAGE) {
        const { data } = await list({ limit: LIST_PAGE, offset, orderBy: '+created_at' })
        for (const user of data) {
          const primary = primaryEmail(user)
          if (!primary.email) continue
          if (signInAllowance(primary.email, this.#allowedDomains, this.#allowedEmails) === null) {
            continue
          }
          try {
            this.#identities.resolve(user.id, {
              email: primary.email,
              verified: primary.verified,
              instance: this.#instance,
            })
          } catch {
            // An unverified address that matches a member: linked when they verify and sign in.
          }
        }
        if (data.length < LIST_PAGE) break
      }
      this.#identities.markListed(this.#instance)
    }
    this.#log(
      `sign-in: ${this.#identities.memberCount()} members on record, ` +
        `${this.#identities.memberCountIn(this.#instance)} with an account in this sign-in instance`,
    )
  }

  #principal(user: CachedUser): Principal {
    return toPrincipal(
      { userId: user.member, email: user.email, name: user.name },
      this.#adminEmails,
      { invited: user.invited },
    )
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

    const { email, verified } = primaryEmail(user)
    const allowance = signInAllowance(email, this.#allowedDomains, this.#allowedEmails)
    // An invited address only counts once Clerk has verified it: the domain lock leans on
    // Google Workspace vouching for the account, an invite has only the emailed code.
    if (allowance === null || (allowance === 'invited' && !verified)) {
      await this.#clerk.users.deleteUser(userId)
      throw domainNotAllowed(email || userId, this.#allowedDomains)
    }

    const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || nameFromEmail(email)
    // Refuses a new account whose unverified email is already a member's.
    const member = this.#identities.resolve(userId, { email, verified, instance: this.#instance })
    this.#absent.delete(member)
    const entry = {
      member,
      email,
      name,
      invited: allowance === 'invited',
      expiresAt: Date.now() + USER_CACHE_TTL_MS,
    }
    this.#users.set(userId, entry)
    try {
      this.#onPhoto?.(email, user.hasImage && user.imageUrl ? user.imageUrl : null)
    } catch {
      // A photo never stands between a member and signing in.
    }
    return entry
  }
}

function primaryEmail(user: ClerkUserLike): { email: string; verified: boolean } {
  const primary = user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId)
  return {
    email: primary?.emailAddress ?? '',
    // Clerk's proof the person holds the mailbox (an emailed code, or Google vouching for it).
    verified: primary?.verification?.status === 'verified',
  }
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'status' in err && err.status === 404
}
