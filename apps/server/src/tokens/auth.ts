import type { Authenticator, Principal } from '../auth/index.js'
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

  constructor(inner: Authenticator, tokens: Pick<TokenStore, 'verify'>) {
    this.#inner = inner
    this.#tokens = tokens
  }

  async authenticate(req: Request): Promise<Principal | null> {
    const token = BEARER.exec(req.headers.get('authorization') ?? '')?.[1]
    if (token === undefined || !token.startsWith(TOKEN_PREFIX)) return this.#inner.authenticate(req)
    const owner = await this.#tokens.verify(token)
    if (!owner) return null
    const principal = await this.#inner.principalForUser(owner.userId)
    if (!principal) return null
    return { ...principal, via: { kind: 'token', tokenId: owner.id, tokenName: owner.name } }
  }

  principalForUser(userId: string): Promise<Principal | null> {
    return this.#inner.principalForUser(userId)
  }
}
