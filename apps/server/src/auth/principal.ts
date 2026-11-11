import { HearthError } from '../errors.js'

export interface Principal {
  userId: string
  email: string
  name: string
  handle: string
  isAdmin: boolean
  /** Set when the request came with a personal access token rather than a session (ARCHITECTURE §8.1). */
  via?: { kind: 'token'; tokenId: string; tokenName: string }
}

export interface Authenticator {
  /** Null when the request carries no valid session. Throws `domain_not_allowed` for outsiders. */
  authenticate(req: Request): Promise<Principal | null>
  /**
   * The member with this user id as they are now, or null when they no longer exist. Access
   * tokens are re-checked with it on every use, so a removed member's tokens stop working.
   */
  principalForUser(userId: string): Promise<Principal | null>
}

function splitEmail(email: string): { local: string; domain: string } {
  const at = email.lastIndexOf('@')
  return { local: email.slice(0, at), domain: email.slice(at + 1) }
}

/** Email local part, lowercased; anything outside [a-z0-9-] becomes a single hyphen. */
export function deriveHandle(email: string): string {
  return splitEmail(email)
    .local.toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** "morgan.holland@x" → "Morgan Holland". Used when no real name is known. */
export function nameFromEmail(email: string): string {
  return splitEmail(email)
    .local.split(/[._+-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

/** Exact, case-insensitive domain match. Subdomains are not allowed. */
export function isAllowedEmailDomain(email: string, allowedDomains: readonly string[]): boolean {
  if (!email.includes('@')) return false
  // Clerk's test mode verifies any `+clerk_test` address with a fixed code and sends no email, so
  // such an address proves nothing about who owns the mailbox.
  if (/\+clerk_test/i.test(splitEmail(email).local)) return false
  const domain = splitEmail(email).domain.toLowerCase()
  return allowedDomains.some((d) => d.toLowerCase() === domain)
}

/** The domain-lock refusal. Its message is shown on the sign-in page, so it says what is allowed. */
export function domainNotAllowed(email: string, allowedDomains: readonly string[]): HearthError {
  const domains = allowedDomains.join(' or ')
  return new HearthError(
    'domain_not_allowed',
    `${email} is not allowed. Sign in with your ${domains} account.`,
  )
}

export function toPrincipal(
  user: { userId: string; email: string; name: string },
  adminEmails: readonly string[],
): Principal {
  const email = user.email.toLowerCase()
  return {
    userId: user.userId,
    email,
    name: user.name,
    handle: deriveHandle(email),
    isAdmin: adminEmails.some((a) => a.toLowerCase() === email),
  }
}
