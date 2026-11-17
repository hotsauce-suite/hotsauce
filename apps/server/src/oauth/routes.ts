import type { Context } from 'hono'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { cors } from 'hono/cors'
import { createMiddleware } from 'hono/factory'
import { clientIp } from '../api/booking.js'
import type { AppEnv } from '../api/env.js'
import { sessionOnly } from '../api/tokens.js'
import type { Config } from '../config.js'
import { HotsauceError } from '../errors.js'
import { type ClientMetadataResolver, isMetadataUrl } from './clientMetadata.js'
import { ConnectionAccess, type OAuthClient, OAuthError, type OAuthStore } from './store.js'

export interface OAuthDeps {
  config: Pick<Config, 'PUBLIC_URL' | 'PRODUCT_NAME'>
  oauth: OAuthStore
  clientMetadata: ClientMetadataResolver
}

/** The issuer: the server's own address, with no trailing slash (RFC 8414 §2). */
export function issuerOf(config: Pick<Config, 'PUBLIC_URL'>): string {
  return config.PUBLIC_URL.replace(/\/+$/, '')
}

/** The one resource connections are for: the MCP endpoint (RFC 8707). */
export function resourceOf(config: Pick<Config, 'PUBLIC_URL'>): string {
  return `${issuerOf(config)}/mcp`
}

export function resourceMetadataUrl(config: Pick<Config, 'PUBLIC_URL'>): string {
  // RFC 9728 §3.1: the well-known path with the resource's own path (`/mcp`) after it.
  return `${issuerOf(config)}/.well-known/oauth-protected-resource/mcp`
}

/** Registrations from one address per hour: enough for any real tool, not enough to flood. */
export const REGISTRATIONS_PER_HOUR = 30
const OAUTH_MAX_BODY = 16 * 1024

/** Client metadata and token requests are small; nothing larger is read (§8.4). */
export function oauthBodyLimit() {
  return bodyLimit({
    maxSize: OAUTH_MAX_BODY,
    onError: (c) =>
      c.json({ error: 'invalid_request', error_description: 'The request is too large' }, 413),
  })
}

/**
 * The AI tools whose return address proves who they are: only these show their own name as fact
 * on the Allow page. Any other client's name is its own claim, shown as such (§8.4).
 */
const KNOWN_HOSTS: Record<string, string> = {
  'claude.ai': 'Claude',
  'claude.com': 'Claude',
  'chatgpt.com': 'ChatGPT',
  'chat.openai.com': 'ChatGPT',
  'grok.com': 'Grok',
}

/** The tool a return address belongs to, when it is one we know, else null. */
export function knownToolFor(redirectUri: string): string | null {
  const host = new URL(redirectUri).hostname.toLowerCase()
  return KNOWN_HOSTS[host] ?? null
}

const anyOrigin = cors({ origin: '*', allowMethods: ['GET', 'POST', 'OPTIONS'], maxAge: 86400 })

/**
 * Discovery (ARCHITECTURE §8.4): RFC 9728 protected resource metadata for `/mcp`, and RFC 8414
 * authorization server metadata. Open to every origin; they hold nothing secret.
 */
export function oauthWellKnownRoutes(deps: OAuthDeps) {
  const issuer = issuerOf(deps.config)
  const resource = () => ({
    resource: resourceOf(deps.config),
    authorization_servers: [issuer],
    bearer_methods_supported: ['header'],
    scopes_supported: ['mcp'],
    resource_name: deps.config.PRODUCT_NAME,
  })
  const server = () => ({
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['mcp'],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  })
  return new Hono<AppEnv>()
    .use('*', anyOrigin)
    .get('/oauth-protected-resource', (c) => c.json(resource()))
    .get('/oauth-protected-resource/mcp', (c) => c.json(resource()))
    .get('/oauth-authorization-server', (c) => c.json(server()))
}

/** The parts a client talks to without a session: registration, tokens, revocation. */
export function oauthServerRoutes(deps: OAuthDeps) {
  const { oauth } = deps
  const registrations = new Map<string, number[]>()
  const tooMany = (ip: string): boolean => {
    const now = Date.now()
    const recent = (registrations.get(ip) ?? []).filter((t) => now - t < 3_600_000)
    if (registrations.size > 10_000) registrations.clear()
    if (recent.length >= REGISTRATIONS_PER_HOUR) return true
    registrations.set(ip, [...recent, now])
    return false
  }
  return new Hono<AppEnv>()
    .use('*', anyOrigin)
    .post('/register', async (c) => {
      if (tooMany(clientIp((n) => c.req.header(n)) ?? 'unknown')) {
        c.header('Retry-After', '3600')
        return c.json(
          { error: 'too_many_requests', error_description: 'Too many registrations; try later' },
          429,
        )
      }
      const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
      if (!body || typeof body !== 'object') {
        return oauthError(c, new OAuthError('invalid_client_metadata', 'Send JSON client metadata'))
      }
      const uris = body.redirect_uris
      if (!Array.isArray(uris) || !uris.every((u) => typeof u === 'string')) {
        return oauthError(c, new OAuthError('invalid_redirect_uri', 'redirect_uris is required'))
      }
      // A client asking for a client secret is registered as public anyway, and the answer says
      // so (RFC 7591 §3.2.1 lets the server replace requested values).
      try {
        const client = await oauth.registerClient({ redirectUris: uris, name: body.client_name })
        c.header('Cache-Control', 'no-store')
        return c.json(
          {
            client_id: client.id,
            client_id_issued_at: Math.floor(Date.now() / 1000),
            client_name: client.name,
            redirect_uris: client.redirectUris,
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: 'none',
          },
          201,
        )
      } catch (err) {
        if (err instanceof OAuthError) return oauthError(c, err)
        throw err
      }
    })
    .post('/token', async (c) => {
      const p = await readParams(c)
      c.header('Cache-Control', 'no-store')
      c.header('Pragma', 'no-cache')
      try {
        const clientId = p.client_id
        if (!clientId) throw new OAuthError('invalid_client', 'client_id is required', 401)
        if (p.resource !== undefined && !resourceOk(deps, p.resource)) {
          throw new OAuthError(
            'invalid_target',
            'This server only issues tokens for its MCP endpoint',
          )
        }
        if (p.grant_type === 'authorization_code') {
          if (!p.code || !p.code_verifier) {
            throw new OAuthError('invalid_request', 'code and code_verifier are required')
          }
          return c.json(
            await oauth.exchangeCode({
              code: p.code,
              clientId,
              ...(p.redirect_uri ? { redirectUri: p.redirect_uri } : {}),
              verifier: p.code_verifier,
            }),
          )
        }
        if (!p.grant_type) throw new OAuthError('invalid_request', 'grant_type is required')
        if (p.grant_type === 'refresh_token') {
          if (!p.refresh_token) throw new OAuthError('invalid_request', 'refresh_token is required')
          return c.json(await oauth.refresh({ refreshToken: p.refresh_token, clientId }))
        }
        throw new OAuthError('unsupported_grant_type', 'Use authorization_code or refresh_token')
      } catch (err) {
        if (err instanceof OAuthError) return oauthError(c, err)
        throw err
      }
    })
    .post('/revoke', async (c) => {
      const p = await readParams(c)
      // RFC 7009 §2.2: an unknown token is still a 200.
      if (p.token) await oauth.revokeToken(p.token)
      return c.body(null, 200)
    })
}

/**
 * The Allow page's calls and Settings → Connected apps, under the signed-in `/api`. Every one
 * needs a browser session: an access token or a connection can never approve another connection.
 */
export function oauthApiRoutes(deps: OAuthDeps) {
  const { oauth } = deps
  return new Hono<AppEnv>()
    .basePath('/oauth')
    .get('/authorize', async (c) => {
      sessionOnly(c.get('principal'))
      const req = await checkAuthorization(deps, new URL(c.req.url).searchParams)
      const known = knownToolFor(req.redirectUri)
      return c.json({
        clientName: known ?? req.client.name,
        clientId: req.client.id,
        redirectHost: new URL(req.redirectUri).host,
        verified: known !== null,
        cancelUrl: redirectWith(deps, req.redirectUri, {
          error: 'access_denied',
          state: req.state,
        }),
      })
    })
    .post('/authorize', async (c) => {
      const principal = sessionOnly(c.get('principal'))
      // Only the Allow page itself can press Allow: JSON (no simple cross-site form or text/plain
      // request) from this server's own origin.
      if (!(c.req.header('content-type') ?? '').includes('application/json')) {
        throw new HotsauceError('bad_request', 'Send JSON', { status: 415 })
      }
      const origin = c.req.header('origin')
      const site = c.req.header('sec-fetch-site')
      if (origin !== new URL(issuerOf(deps.config)).origin || (site && site !== 'same-origin')) {
        throw new HotsauceError('forbidden', 'Allow only from this server’s own page')
      }
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
      const params = new URLSearchParams()
      for (const [k, v] of Object.entries(body)) if (typeof v === 'string') params.set(k, v)
      const req = await checkAuthorization(deps, params)
      // What the member chose on the Allow page; an older page sends nothing, which is `full`.
      const access = ConnectionAccess.safeParse(body.access ?? 'full')
      if (!access.success) {
        throw new HotsauceError('bad_request', 'access must be "full" or "team-read"')
      }
      const code = oauth.issueCode({
        client: req.client,
        redirectUri: req.redirectUri,
        challenge: req.challenge,
        principal,
        access: access.data,
      })
      c.header('Cache-Control', 'no-store')
      return c.json({ redirect: redirectWith(deps, req.redirectUri, { code, state: req.state }) })
    })
    .get('/connections', async (c) => c.json(await oauth.list(sessionOnly(c.get('principal')))))
    .delete('/connections/:id', async (c) => {
      const removed = await oauth.disconnect(sessionOnly(c.get('principal')), c.req.param('id'))
      if (!removed) throw new HotsauceError('not_found', 'No such connection')
      return c.body(null, 204)
    })
}

/**
 * On `/mcp`: a 401 says where to sign in (RFC 9728 §5.1), and that a token it got was bad, so a
 * client refreshes or starts the sign-in again.
 */
export function mcpChallenge(deps: Pick<OAuthDeps, 'config'>) {
  return createMiddleware<AppEnv>(async (c, next) => {
    await next()
    if (c.res.status !== 401) return
    const sentToken = /^Bearer\s+\S+/i.test(c.req.header('authorization') ?? '')
    const parts = [
      ...(sentToken ? ['error="invalid_token"'] : []),
      `resource_metadata="${resourceMetadataUrl(deps.config)}"`,
    ]
    c.res.headers.set('WWW-Authenticate', `Bearer ${parts.join(', ')}`)
    c.res.headers.set('Access-Control-Expose-Headers', 'WWW-Authenticate')
  })
}

interface AuthorizationRequest {
  client: OAuthClient
  redirectUri: string
  challenge: string
  state: string | undefined
}

/**
 * Checks an authorization request (OAuth 2.1 §4.1.1). Every problem is a 400 shown on the Allow
 * page, never a redirect: a request with a bad client or redirect URI must not send the browser
 * anywhere, and the rest are mistakes in the client a person can report.
 */
async function checkAuthorization(
  deps: OAuthDeps,
  p: URLSearchParams,
): Promise<AuthorizationRequest> {
  const clientId = p.get('client_id') ?? ''
  if (!clientId) throw bad('This link is missing its client_id.')
  const client = isMetadataUrl(clientId)
    ? await deps.clientMetadata.resolve(clientId)
    : await deps.oauth.registeredClient(clientId)
  if (!client) throw bad('This app isn’t registered with this server. Try connecting again.')
  const asked = p.get('redirect_uri')
  const redirectUri = asked ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : null)
  if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
    throw bad('This app asked to return to an address it didn’t register.')
  }
  if (p.get('response_type') !== 'code') throw bad('Only response_type=code is supported.')
  const challenge = p.get('code_challenge') ?? ''
  if (!/^[A-Za-z0-9_-]{43}$/.test(challenge) || p.get('code_challenge_method') !== 'S256') {
    throw bad('This app must use PKCE with S256.')
  }
  const resource = p.get('resource')
  if (resource !== null && !resourceOk(deps, resource)) {
    throw bad('This app asked for access to a different server.')
  }
  const state = p.get('state') ?? undefined
  return { client, redirectUri, challenge, state }
}

function resourceOk(deps: Pick<OAuthDeps, 'config'>, resource: string): boolean {
  const trimmed = resource.replace(/\/+$/, '')
  return trimmed === resourceOf(deps.config) || trimmed === issuerOf(deps.config)
}

function redirectWith(
  deps: Pick<OAuthDeps, 'config'>,
  redirectUri: string,
  params: Record<string, string | undefined>,
): string {
  const url = new URL(redirectUri)
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v)
  // RFC 9207: the issuer, so a client talking to several servers can't be confused.
  url.searchParams.set('iss', issuerOf(deps.config))
  return url.toString()
}

function bad(message: string): HotsauceError {
  return new HotsauceError('bad_request', message)
}

function oauthError(c: Context, err: OAuthError): Response {
  return c.json({ error: err.error, error_description: err.description }, err.status as 400 | 401)
}

/** Form-encoded (the standard) or JSON parameters, as strings. */
async function readParams(c: Context): Promise<Record<string, string | undefined>> {
  const type = c.req.header('content-type') ?? ''
  const out: Record<string, string | undefined> = {}
  if (type.includes('application/json')) {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    for (const [k, v] of Object.entries(body)) if (typeof v === 'string') out[k] = v
    return out
  }
  const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
  for (const [k, v] of Object.entries(body)) if (typeof v === 'string') out[k] = v
  return out
}
