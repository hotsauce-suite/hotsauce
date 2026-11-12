import { createClerkClient } from '@clerk/backend'
import type { Config } from '../config.js'
import { ClerkAuth } from './clerk.js'
import { DevAuth } from './dev.js'
import type { Authenticator } from './principal.js'

export { ClerkAuth, type ClerkClientLike, type ClerkUserLike } from './clerk.js'
export { DEV_USER_HEADER, DevAuth } from './dev.js'
export {
  type Authenticator,
  deriveHandle,
  isAllowedEmailDomain,
  type Principal,
  signInAllowance,
} from './principal.js'

export type AuthConfig = Pick<
  Config,
  | 'NODE_ENV'
  | 'AUTH_MODE'
  | 'CLERK_SECRET_KEY'
  | 'CLERK_PUBLISHABLE_KEY'
  | 'ALLOWED_EMAIL_DOMAINS'
  | 'ALLOWED_EMAILS'
  | 'ADMIN_EMAILS'
  | 'PUBLIC_URL'
>

export function createAuthenticator(config: AuthConfig): Authenticator {
  const allowedDomains = config.ALLOWED_EMAIL_DOMAINS
  const allowedEmails = config.ALLOWED_EMAILS
  const adminEmails = config.ADMIN_EMAILS
  if (config.AUTH_MODE === 'dev') return new DevAuth({ allowedDomains, allowedEmails, adminEmails })
  // Setup mode: nobody can sign in until the wizard has saved the sign-in keys.
  if (config.AUTH_MODE === 'setup') {
    return { authenticate: async () => null, principalForUser: async () => null }
  }

  if (!config.CLERK_SECRET_KEY) throw new Error('CLERK_SECRET_KEY is required when AUTH_MODE=clerk')
  const clerk = createClerkClient({
    secretKey: config.CLERK_SECRET_KEY,
    ...(config.CLERK_PUBLISHABLE_KEY ? { publishableKey: config.CLERK_PUBLISHABLE_KEY } : {}),
  })
  return new ClerkAuth({
    clerk,
    allowedDomains,
    allowedEmails,
    adminEmails,
    authorizedParties: authorizedParties(config),
  })
}

/** Origins a session token may come from: the app itself, plus the Vite dev server in development. */
export function authorizedParties(config: Pick<Config, 'NODE_ENV' | 'PUBLIC_URL'>): string[] {
  const origins = [new URL(config.PUBLIC_URL).origin]
  if (config.NODE_ENV === 'development') origins.push(VITE_DEV_ORIGIN)
  return origins
}

const VITE_DEV_ORIGIN = 'http://localhost:5173'
