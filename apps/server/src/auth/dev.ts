import { z } from 'zod'
import {
  type Authenticator,
  domainNotAllowed,
  isAllowedEmailDomain,
  nameFromEmail,
  type Principal,
  toPrincipal,
} from './principal.js'

export const DEV_USER_HEADER = 'x-hearth-dev-user'

const Email = z.email()
const DEV_USER_ID = 'dev:'

/** Trusts a header naming the user. Only wired when AUTH_MODE=dev, which config refuses in production. */
export class DevAuth implements Authenticator {
  readonly #allowedDomains: readonly string[]
  readonly #adminEmails: readonly string[]

  constructor(opts: { allowedDomains: readonly string[]; adminEmails: readonly string[] }) {
    this.#allowedDomains = opts.allowedDomains
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

  #principalFor(header: string | null | undefined): Principal | null {
    const email = header?.trim().toLowerCase()
    if (!email || !Email.safeParse(email).success) return null
    if (!isAllowedEmailDomain(email, this.#allowedDomains)) {
      throw domainNotAllowed(email, this.#allowedDomains)
    }
    return toPrincipal(
      { userId: `${DEV_USER_ID}${email}`, email, name: nameFromEmail(email) },
      this.#adminEmails,
    )
  }
}
