import { z } from 'zod'
import {
  type Authenticator,
  domainNotAllowed,
  nameFromEmail,
  type Principal,
  signInAllowance,
  toPrincipal,
} from './principal.js'

export const DEV_USER_HEADER = 'x-hearth-dev-user'

const Email = z.email()
const DEV_USER_ID = 'dev:'

/** Trusts a header naming the user. Only wired when AUTH_MODE=dev, which config refuses in production. */
export class DevAuth implements Authenticator {
  readonly #allowedDomains: readonly string[]
  readonly #allowedEmails: readonly string[]
  readonly #adminEmails: readonly string[]

  constructor(opts: {
    allowedDomains: readonly string[]
    allowedEmails?: readonly string[]
    adminEmails: readonly string[]
  }) {
    this.#allowedDomains = opts.allowedDomains
    this.#allowedEmails = opts.allowedEmails ?? []
    this.#adminEmails = opts.adminEmails
  }

  async authenticate(req: Request): Promise<Principal | null> {
    return this.#principalFor(req.headers.get(DEV_USER_HEADER))
  }

  /** Dev user ids are `dev:<email>`. */
  async principalForUser(userId: string): Promise<Principal | null> {
    return userId.startsWith(DEV_USER_ID)
      ? this.#principalFor(userId.slice(DEV_USER_ID.length))
      : null
  }

  /** Dev sign-in has no secret: the ticket is the dev user id, which the web app signs in as. */
  async createSignInTicket(userId: string): Promise<string> {
    return userId
  }

  #principalFor(header: string | null | undefined): Principal | null {
    const email = header?.trim().toLowerCase()
    if (!email || !Email.safeParse(email).success) return null
    const allowance = signInAllowance(email, this.#allowedDomains, this.#allowedEmails)
    if (allowance === null) throw domainNotAllowed(email, this.#allowedDomains)
    return toPrincipal(
      { userId: `${DEV_USER_ID}${email}`, email, name: nameFromEmail(email) },
      this.#adminEmails,
      { invited: allowance === 'invited' },
    )
  }
}
