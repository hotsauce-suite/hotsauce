import { createHash, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../../src/app.js'
import { loadConfig } from '../../src/config.js'
import { createServices, type Services } from '../../src/services.js'
import { makeTempDir, removeDir } from '../helpers/git.js'

const ALICE = 'alice@example.test'
const BOB = 'bob@example.test'
const BASE = 'https://office.example.test'
const REDIRECT = 'https://claude.example/api/mcp/auth_callback'

let root: string
let services: Services
let app: ReturnType<typeof createApp>

beforeEach(async () => {
  root = await makeTempDir('hotsauce-oauth-')
  const config = loadConfig({
    NODE_ENV: 'test',
    AUTH_MODE: 'dev',
    HOST_KIND: 'local',
    DATA_DIR: join(root, 'data'),
    LOCAL_HOST_DIR: join(root, 'remotes'),
    ALLOWED_EMAIL_DOMAINS: 'example.test',
    WEBHOOK_SECRET: 'test-webhook-secret',
    PUBLIC_URL: BASE,
  })
  services = createServices(config)
  await services.spaces.ensureTeamSpace()
  app = createApp(services)
})

afterEach(async () => {
  await services.oauth.idle()
  services.index.close()
  await removeDir(root)
})

async function call(
  method: string,
  path: string,
  opts: { as?: string; token?: string; json?: unknown; form?: Record<string, string> } = {},
): Promise<Response> {
  const headers: Record<string, string> = {}
  if (opts.as) headers['x-hearth-dev-user'] = opts.as
  if (opts.token) headers.authorization = `Bearer ${opts.token}`
  let body: string | undefined
  if (opts.json !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(opts.json)
  } else if (opts.form) {
    headers['content-type'] = 'application/x-www-form-urlencoded'
    body = new URLSearchParams(opts.form).toString()
  }
  return app.request(`${BASE}${path}`, { method, headers, ...(body ? { body } : {}) })
}

function pkce() {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

async function register(redirectUris = [REDIRECT], name = 'Claude') {
  const res = await call('POST', '/oauth/register', {
    json: { redirect_uris: redirectUris, client_name: name },
  })
  expect(res.status, await res.clone().text()).toBe(201)
  return (await res.json()) as { client_id: string }
}

function authorizeParams(clientId: string, challenge: string, extra: Record<string, string> = {}) {
  return {
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'st-1',
    resource: `${BASE}/mcp`,
    ...extra,
  }
}

/** Register, press Allow as `as`, and exchange the code: a connected app's first tokens. */
async function connectApp(as = ALICE, name = 'Claude') {
  const { client_id } = await register([REDIRECT], name)
  const { verifier, challenge } = pkce()
  const allow = await call('POST', '/api/oauth/authorize', {
    as,
    json: authorizeParams(client_id, challenge),
  })
  expect(allow.status, await allow.clone().text()).toBe(200)
  const redirect = new URL(((await allow.json()) as { redirect: string }).redirect)
  const code = redirect.searchParams.get('code') ?? ''
  const res = await call('POST', '/oauth/token', {
    form: {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id,
      redirect_uri: REDIRECT,
      resource: `${BASE}/mcp`,
    },
  })
  expect(res.status, await res.clone().text()).toBe(200)
  const tokens = (await res.json()) as {
    access_token: string
    refresh_token: string
    expires_in: number
  }
  return { client_id, tokens, code, verifier }
}

async function mcpClient(token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: async (input, init) => app.request(new Request(input, init)),
  })
  const client = new Client({ name: 'claude-ai', version: '1.0.0' })
  await client.connect(transport)
  return client
}

describe('discovery (R1, R2)', () => {
  it('serves protected resource metadata at both paths, open to any origin', async () => {
    for (const path of [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp',
    ]) {
      const res = await app.request(`${BASE}${path}`, {
        headers: { origin: 'https://chatgpt.com' },
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('access-control-allow-origin')).toBe('*')
      expect(await res.json()).toEqual({
        resource: `${BASE}/mcp`,
        authorization_servers: [BASE],
        bearer_methods_supported: ['header'],
        scopes_supported: ['mcp'],
        resource_name: expect.any(String),
      })
    }
  })

  it('serves authorization server metadata', async () => {
    const res = await call('GET', '/.well-known/oauth-authorization-server')
    expect(await res.json()).toMatchObject({
      issuer: BASE,
      authorization_endpoint: `${BASE}/oauth/authorize`,
      token_endpoint: `${BASE}/oauth/token`,
      registration_endpoint: `${BASE}/oauth/register`,
      revocation_endpoint: `${BASE}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      client_id_metadata_document_supported: true,
    })
  })

  it('a 401 from /mcp names the resource metadata, and a bad token as invalid_token', async () => {
    const anon = await call('POST', '/mcp', { json: {} })
    expect(anon.status).toBe(401)
    expect(anon.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`,
    )
    const bad = await call('POST', '/mcp', { token: 'hto_nope', json: {} })
    expect(bad.status).toBe(401)
    expect(bad.headers.get('www-authenticate')).toContain('error="invalid_token"')
  })
})

describe('client registration (R3)', () => {
  it('registers a public client and refuses bad redirect URIs', async () => {
    const res = await call('POST', '/oauth/register', {
      json: { redirect_uris: [REDIRECT, 'http://localhost:7777/cb'], client_name: 'Claude\nCode' },
    })
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({
      client_id: expect.any(String),
      client_name: 'Claude Code',
      redirect_uris: [REDIRECT, 'http://localhost:7777/cb'],
      token_endpoint_auth_method: 'none',
    })
    for (const uris of [[], ['http://evil.example/cb'], ['https://a.example/cb#x'], 'nope']) {
      const bad = await call('POST', '/oauth/register', { json: { redirect_uris: uris } })
      expect(bad.status).toBe(400)
      expect(((await bad.json()) as { error: string }).error).toBe('invalid_redirect_uri')
    }
    const confidential = await call('POST', '/oauth/register', {
      json: { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'client_secret_basic' },
    })
    // Asked for a secret: registered as a public client anyway, and told so.
    expect(confidential.status).toBe(201)
    expect(await confidential.json()).toMatchObject({ token_endpoint_auth_method: 'none' })
    const long = await call('POST', '/oauth/register', {
      json: { redirect_uris: [`https://a.example/${'x'.repeat(2100)}`] },
    })
    expect(long.status).toBe(400)
    const huge = await call('POST', '/oauth/register', {
      json: { redirect_uris: [REDIRECT], client_name: 'x'.repeat(20_000) },
    })
    expect(huge.status).toBe(413)
  })

  it('limits registrations from one address', async () => {
    const statuses: number[] = []
    for (let i = 0; i < 31; i++) {
      const res = await app.request(`${BASE}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'fly-client-ip': '203.0.113.9' },
        body: JSON.stringify({ redirect_uris: [REDIRECT] }),
      })
      statuses.push(res.status)
    }
    expect(statuses.slice(0, 30).every((st) => st === 201)).toBe(true)
    expect(statuses[30]).toBe(429)
  })
})

describe('the Allow page (R5)', () => {
  it('checks a request for a signed-in member and refuses tokens and bad requests', async () => {
    const { client_id } = await register()
    const { challenge } = pkce()
    const qs = new URLSearchParams(authorizeParams(client_id, challenge)).toString()
    const ok = await call('GET', `/api/oauth/authorize?${qs}`, { as: ALICE })
    expect(ok.status).toBe(200)
    const body = (await ok.json()) as {
      clientName: string
      redirectHost: string
      cancelUrl: string
    }
    expect(body.clientName).toBe('Claude')
    expect(body.redirectHost).toBe('claude.example')
    const cancel = new URL(body.cancelUrl)
    expect(cancel.searchParams.get('error')).toBe('access_denied')
    expect(cancel.searchParams.get('state')).toBe('st-1')
    expect(cancel.searchParams.get('iss')).toBe(BASE)

    expect((await call('GET', `/api/oauth/authorize?${qs}`)).status).toBe(401)
    const created = await call('POST', '/api/tokens', { as: ALICE, json: { name: 'x' } })
    const { token } = (await created.json()) as { token: string }
    expect((await call('GET', `/api/oauth/authorize?${qs}`, { token })).status).toBe(403)

    const cases: Record<string, string>[] = [
      { client_id: 'unknown' },
      { redirect_uri: 'https://evil.example/cb' },
      { response_type: 'token' },
      { code_challenge_method: 'plain' },
      { code_challenge: 'short' },
      { resource: 'https://other.example/mcp' },
    ]
    for (const extra of cases) {
      const bad = new URLSearchParams(authorizeParams(client_id, challenge, extra)).toString()
      const res = await call('GET', `/api/oauth/authorize?${bad}`, { as: ALICE })
      expect(res.status, JSON.stringify(extra)).toBe(400)
    }
  })

  it('Allow answers the redirect with a code, the state and the issuer', async () => {
    const { client_id } = await register()
    const { challenge } = pkce()
    const res = await call('POST', '/api/oauth/authorize', {
      as: ALICE,
      json: authorizeParams(client_id, challenge),
    })
    const url = new URL(((await res.json()) as { redirect: string }).redirect)
    expect(`${url.origin}${url.pathname}`).toBe(REDIRECT)
    expect(url.searchParams.get('code')).toMatch(/^htc_/)
    expect(url.searchParams.get('state')).toBe('st-1')
    expect(url.searchParams.get('iss')).toBe(BASE)
  })
})

describe('tokens (R6, R7)', () => {
  it('a connected app uses /mcp as the member, and only /mcp', async () => {
    const { tokens } = await connectApp()
    expect(tokens.access_token).toMatch(/^hto_/)
    expect(tokens.refresh_token).toMatch(/^htr_/)
    expect(tokens.expires_in).toBe(3600)
    const client = await mcpClient(tokens.access_token)
    const { tools } = await client.listTools()
    expect(tools.length).toBeGreaterThan(10)
    const spaces = await client.callTool({ name: 'list_spaces', arguments: {} })
    expect(JSON.stringify(spaces)).toContain('alice')
    await client.close()
    // Anywhere else it is no credential.
    expect((await call('GET', '/api/tokens', { token: tokens.access_token })).status).toBe(401)
    expect((await call('GET', '/api/me', { token: tokens.access_token })).status).toBe(401)
  })

  it('a failed check uses the code up; a reused code revokes what it made', async () => {
    const { client_id } = await register()
    const other = await register()
    const codeFor = async (challenge: string) => {
      const allow = await call('POST', '/api/oauth/authorize', {
        as: ALICE,
        json: authorizeParams(client_id, challenge),
      })
      return (
        new URL(((await allow.json()) as { redirect: string }).redirect).searchParams.get('code') ??
        ''
      )
    }
    const exchange = (code: string, form: Record<string, string>) =>
      call('POST', '/oauth/token', {
        form: { grant_type: 'authorization_code', code, client_id, ...form },
      })
    for (const bad of [
      (v: string) => ({ code_verifier: pkce().verifier, _: v }),
      (v: string) => ({ code_verifier: v, client_id: other.client_id }),
      (v: string) => ({ code_verifier: v, redirect_uri: 'https://x.example' }),
    ]) {
      const { verifier, challenge } = pkce()
      const code = await codeFor(challenge)
      const { _, ...form } = { _: '', ...bad(verifier) }
      const res = await exchange(code, form)
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: string }).error).toBe('invalid_grant')
      // The right verifier afterwards is too late.
      expect((await exchange(code, { code_verifier: verifier })).status).toBe(400)
    }
    const { verifier, challenge } = pkce()
    const code = await codeFor(challenge)
    const good = await exchange(code, { code_verifier: verifier })
    expect(good.status).toBe(200)
    expect(good.headers.get('cache-control')).toBe('no-store')
    const { access_token } = (await good.json()) as { access_token: string }
    expect((await call('POST', '/mcp', { token: access_token, json: {} })).status).not.toBe(401)
    // The code again: refused, and the connection it made is gone.
    expect((await exchange(code, { code_verifier: verifier })).status).toBe(400)
    expect((await call('POST', '/mcp', { token: access_token, json: {} })).status).toBe(401)
  })

  it('refresh rotates the pair; a retry of the old token is refused but keeps the connection', async () => {
    const { client_id, tokens } = await connectApp()
    const refresh = (refresh_token: string, id = client_id) =>
      call('POST', '/oauth/token', {
        json: { grant_type: 'refresh_token', refresh_token, client_id: id },
      })
    const res = await refresh(tokens.refresh_token)
    expect(res.status).toBe(200)
    const next = (await res.json()) as { access_token: string; refresh_token: string }
    expect(next.refresh_token).not.toBe(tokens.refresh_token)
    // The old access token is replaced; the new one works.
    expect((await call('POST', '/mcp', { token: tokens.access_token, json: {} })).status).toBe(401)
    expect((await refresh(next.refresh_token, 'someone-else')).status).toBe(400)
    // Two refreshes at once: the loser is refused, and the winner's tokens still work.
    expect((await refresh(tokens.refresh_token)).status).toBe(400)
    expect((await call('POST', '/mcp', { token: next.access_token, json: {} })).status).not.toBe(
      401,
    )
    expect((await refresh(next.refresh_token)).status).toBe(200)
  })

  it('a token request without grant_type is invalid_request', async () => {
    const res = await call('POST', '/oauth/token', { form: { client_id: 'x' } })
    expect(((await res.json()) as { error: string }).error).toBe('invalid_request')
  })

  it('refuses unknown grants and a token for another resource', async () => {
    const { client_id } = await connectApp()
    const res = await call('POST', '/oauth/token', {
      form: { grant_type: 'password', client_id },
    })
    expect(((await res.json()) as { error: string }).error).toBe('unsupported_grant_type')
    const target = await call('POST', '/oauth/token', {
      form: { grant_type: 'refresh_token', client_id, refresh_token: 'x', resource: 'https://x' },
    })
    expect(((await target.json()) as { error: string }).error).toBe('invalid_target')
  })

  it('stops working for a member who is no longer allowed in', async () => {
    const { tokens } = await connectApp('carol@elsewhere.test').then(
      () => {
        throw new Error('an outsider could connect')
      },
      () => connectApp(ALICE),
    )
    expect((await call('POST', '/mcp', { token: tokens.access_token, json: {} })).status).not.toBe(
      401,
    )
  })
})

describe('Connected apps (R8)', () => {
  it('lists the member’s own connections and disconnects one at once', async () => {
    const a = await connectApp(ALICE, 'Claude')
    await connectApp(ALICE, 'ChatGPT')
    await connectApp(BOB, 'Grok')
    const res = await call('GET', '/api/oauth/connections', { as: ALICE })
    const list = (await res.json()) as { id: string; clientName: string; redirectHost: string }[]
    expect(list.map((c) => c.clientName).sort()).toEqual(['ChatGPT', 'Claude'])
    expect(list[0]?.redirectHost).toBe('claude.example')
    const claude = list.find((c) => c.clientName === 'Claude')
    // Bob can't see or end Alice's.
    expect((await call('DELETE', `/api/oauth/connections/${claude?.id}`, { as: BOB })).status).toBe(
      404,
    )
    // A connection can't manage connections.
    expect(
      (await call('GET', '/api/oauth/connections', { token: a.tokens.access_token })).status,
    ).toBe(401)
    expect(
      (await call('DELETE', `/api/oauth/connections/${claude?.id}`, { as: ALICE })).status,
    ).toBe(204)
    expect((await call('POST', '/mcp', { token: a.tokens.access_token, json: {} })).status).toBe(
      401,
    )
    const after = (await (await call('GET', '/api/oauth/connections', { as: ALICE })).json()) as {
      clientName: string
    }[]
    expect(after.map((c) => c.clientName)).toEqual(['ChatGPT'])
  })

  it('a client can revoke its own token (RFC 7009)', async () => {
    const { tokens } = await connectApp()
    const res = await call('POST', '/oauth/revoke', { form: { token: tokens.refresh_token } })
    expect(res.status).toBe(200)
    expect((await call('POST', '/mcp', { token: tokens.access_token, json: {} })).status).toBe(401)
    expect((await call('POST', '/oauth/revoke', { form: { token: 'nope' } })).status).toBe(200)
  })
})

describe('the MCP SDK’s own OAuth client (R1–R7 together)', () => {
  it('discovers, registers, signs in and connects', async () => {
    let authUrl: URL | null = null
    let info: OAuthClientInformationMixed | undefined
    let saved: OAuthTokens | undefined
    let verifier = ''
    const provider: OAuthClientProvider = {
      get redirectUrl() {
        return REDIRECT
      },
      get clientMetadata(): OAuthClientMetadata {
        return { client_name: 'claude-ai', redirect_uris: [REDIRECT] }
      },
      clientInformation: () => info,
      saveClientInformation: (i) => {
        info = i
      },
      tokens: () => saved,
      saveTokens: (t) => {
        saved = t
      },
      redirectToAuthorization: (url) => {
        authUrl = url
      },
      saveCodeVerifier: (v) => {
        verifier = v
      },
      codeVerifier: () => verifier,
    }
    const fetchApp = async (input: string | URL | Request, init?: RequestInit) =>
      app.request(new Request(input, init))
    const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
      authProvider: provider,
      fetch: fetchApp,
    })
    const client = new Client({ name: 'claude-ai', version: '1.0.0' })
    await expect(client.connect(transport)).rejects.toThrow(/Unauthorized/)
    expect(authUrl).not.toBeNull()
    // biome-ignore lint/style/noNonNullAssertion: checked above
    const asked = authUrl!
    expect(`${asked.origin}${asked.pathname}`).toBe(`${BASE}/oauth/authorize`)
    // What the Allow page does when Alice presses Allow.
    const allow = await call('POST', '/api/oauth/authorize', {
      as: ALICE,
      json: Object.fromEntries(asked.searchParams),
    })
    const code =
      new URL(((await allow.json()) as { redirect: string }).redirect).searchParams.get('code') ??
      ''
    await transport.finishAuth(code)
    const again = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
      authProvider: provider,
      fetch: fetchApp,
    })
    const connected = new Client({ name: 'claude-ai', version: '1.0.0' })
    await connected.connect(again)
    expect((await connected.listTools()).tools.length).toBeGreaterThan(10)
    await connected.close()
  })
})
