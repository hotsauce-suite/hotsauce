import type { Authenticator, Principal } from '../auth/index.js'
import { HotsauceError } from '../errors.js'
import { ACCESS_PREFIX, type OAuthStore } from '../oauth/store.js'
import { TOKEN_PREFIX, type TokenStore } from './store.js'

const BEARER = /^Bearer\s+(\S+)\s*$/i

/**
 * Accepts a personal access token (`Authorization: Bearer hth_…`) in front of the configured
 * authenticator. A token request never reaches it: an unknown or revoked token is simply
 * unauthenticated. A known one is the member it was made for, as they are now.
 */
export class TokenAuth implements Authenticator {
  readonly #inner: Authenticator
  readonly #tokens: Pick<TokenStore, 'verify'>
  readonly #oauth: Pick<OAuthStore, 'verifyAccess'> | null

  constructor(
    inner: Authenticator,
    tokens: Pick<TokenStore, 'verify'>,
    oauth: Pick<OAuthStore, 'verifyAccess'> | null = null,
  ) {
    this.#inner = inner
    this.#tokens = tokens
    this.#oauth = oauth
  }

  async authenticate(req: Request): Promise<Principal | null> {
    const token = BEARER.exec(req.headers.get('authorization') ?? '')?.[1]
    if (token?.startsWith(ACCESS_PREFIX)) return this.#connection(req, token)
    if (token === undefined || !token.startsWith(TOKEN_PREFIX)) return this.#inner.authenticate(req)
    const owner = await this.#tokens.verify(token)
    if (!owner) return null
    const principal = await this.#inner.principalForUser(owner.userId)
    if (!principal) return null
    return { ...principal, via: { kind: 'token', tokenId: owner.id, tokenName: owner.name } }
  }

  /**
   * An app connected through sign-in (ARCHITECTURE §8.4): its access token is for the MCP
   * endpoint only, so anywhere else it is no credential at all.
   */
  async #connection(req: Request, token: string): Promise<Principal | null> {
    if (!this.#oauth || !isMcpPath(req.url)) return null
    const found = await this.#oauth.verifyAccess(token)
    if (!found.ok) return null
    const principal = await this.#inner.principalForUser(found.userId)
    if (!principal) return null
    return {
      ...principal,
      via: {
        kind: 'token',
        tokenId: found.connectionId,
        tokenName: found.clientName,
        ...(found.access === 'team-read' ? { access: 'team-read' as const } : {}),
      },
    }
  }

  principalForUser(userId: string): Promise<Principal | null> {
    return this.#inner.principalForUser(userId)
  }

  recordExistingMembers(): Promise<void> {
    return this.#inner.recordExistingMembers?.() ?? Promise.resolve()
  }

  createSignInTicket(userId: string): Promise<string> {
    if (!this.#inner.createSignInTicket) {
      throw new HotsauceError('not_found', 'Signing in the Mac app is not available on this server')
    }
    return this.#inner.createSignInTicket(userId)
  }
}

function isMcpPath(url: string): boolean {
  const { pathname } = new URL(url, 'http://localhost')
  return pathname === '/mcp' || pathname === '/mcp/'
}
