import { createHmac } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitHubHost } from './github.js'

type Call = { method: string; url: string; body: unknown; auth: string | null }

/** Stubs global fetch with a router over `${method} ${path}` (path includes the query string). */
function fakeGitHub(routes: Record<string, () => Response>): Call[] {
  const calls: Call[] = []
  vi.stubGlobal('fetch', async (input: string, init: RequestInit) => {
    const url = new URL(input)
    const method = init.method ?? 'GET'
    const headers = new Headers(init.headers)
    calls.push({
      method,
      url: url.pathname + url.search,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      auth: headers.get('authorization'),
    })
    const route = routes[`${method} ${url.pathname}${url.search}`]
    return route ? route() : new Response('{"message":"Not Found"}', { status: 404 })
  })
  return calls
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
const host = () => new GitHubHost({ org: 'acme-hotsauce', credential: async () => 'tok-123' })

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

/** What hosts said in their error responses: logged on the server, never sent to clients. */
function hostLog() {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
  return () => spy.mock.calls.map((c) => c.join(' ')).join('\n')
}

describe('GitHubHost REST', () => {
  it('creates a missing repo as private and returns a token-bearing clone URL', async () => {
    const calls = fakeGitHub({
      'POST /orgs/acme-hotsauce/repos': () => json(201, { name: 'team' }),
    })
    const { cloneUrl } = await host().ensureRepo('team')
    expect(cloneUrl).toBe('https://x-access-token:tok-123@github.com/acme-hotsauce/team.git')
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /repos/acme-hotsauce/team',
      'POST /orgs/acme-hotsauce/repos',
    ])
    expect(calls[1]?.body).toEqual({ name: 'team', private: true, auto_init: false })
    expect(calls[0]?.auth).toBe('Bearer tok-123')
  })

  it('accepts a 422 only when the repo turns out to exist', async () => {
    let gets = 0
    fakeGitHub({
      'GET /repos/acme-hotsauce/team': () => (gets++ === 0 ? json(404, {}) : json(200, {})),
      'POST /orgs/acme-hotsauce/repos': () => json(422, { message: 'name already exists' }),
    })
    await expect(host().ensureRepo('team')).resolves.toMatchObject({ cloneUrl: expect.any(String) })

    fakeGitHub({
      'POST /orgs/acme-hotsauce/repos': () => json(422, { message: 'Validation Failed' }),
    })
    const logged = hostLog()
    await expect(host().ensureRepo('team')).rejects.toMatchObject({
      code: 'host_error',
      message: 'GitHub: create repo team failed (422)',
    })
    expect(logged()).toContain('Validation Failed')
  })

  it('does not recreate an existing repo', async () => {
    const calls = fakeGitHub({ 'GET /repos/acme-hotsauce/team': () => json(200, { name: 'team' }) })
    await host().ensureRepo('team')
    expect(calls).toHaveLength(1)
  })

  it('reports host errors by status, logging the response body', async () => {
    fakeGitHub({ 'GET /repos/acme-hotsauce/team': () => json(401, { message: 'Bad credentials' }) })
    const logged = hostLog()
    await expect(host().ensureRepo('team')).rejects.toMatchObject({
      code: 'host_error',
      message: 'GitHub: get repo team failed (401)',
    })
    expect(logged()).toContain('Bad credentials')
  })

  it('creates a webhook once, then updates the one with the same URL', async () => {
    const hookUrl = 'https://hearth.example/api/webhooks/git'
    const hooksPath = 'GET /repos/acme-hotsauce/team/hooks?per_page=100'
    let calls = fakeGitHub({
      [hooksPath]: () => json(200, [{ id: 7, config: { url: 'https://other.example/hook' } }]),
      'POST /repos/acme-hotsauce/team/hooks': () => json(201, { id: 8 }),
    })
    await host().ensureWebhook('team', hookUrl, 's3cret')
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST'])
    expect(calls[1]?.body).toMatchObject({
      name: 'web',
      events: ['push'],
      config: { url: hookUrl, content_type: 'json', secret: 's3cret' },
    })

    calls = fakeGitHub({
      [hooksPath]: () => json(200, [{ id: 8, config: { url: hookUrl } }]),
      'PATCH /repos/acme-hotsauce/team/hooks/8': () => json(200, { id: 8 }),
    })
    await host().ensureWebhook('team', hookUrl, 's3cret')
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      hooksPath,
      'PATCH /repos/acme-hotsauce/team/hooks/8',
    ])
  })

  it('adds a collaborator with push permission', async () => {
    const calls = fakeGitHub({
      'PUT /repos/acme-hotsauce/team/collaborators/alice': () =>
        new Response(null, { status: 204 }),
    })
    await host().addCollaborator('team', 'alice')
    expect(calls[0]?.body).toEqual({ permission: 'push' })
  })

  it('refuses deleteRepo in production', async () => {
    const calls = fakeGitHub({})
    vi.stubEnv('NODE_ENV', 'production')
    await expect(host().deleteRepo('team')).rejects.toMatchObject({ code: 'forbidden' })
    expect(calls).toHaveLength(0)
  })
})

describe('GitHubHost.parseWebhook', () => {
  const secret = 'webhook-secret'
  const body = JSON.stringify({ ref: 'refs/heads/main', repository: { name: 'team' } })
  const sign = (b: string, s = secret) =>
    `sha256=${createHmac('sha256', s).update(b).digest('hex')}`

  it('accepts a correctly signed push', () => {
    const headers = { 'X-Hub-Signature-256': sign(body), 'X-GitHub-Event': 'push' }
    expect(host().parseWebhook(headers, body, secret)).toEqual({
      repo: 'team',
      ref: 'refs/heads/main',
    })
  })

  it('rejects a bad or missing signature, and non-push events', () => {
    const h = host()
    expect(
      h.parseWebhook(
        { 'x-hub-signature-256': sign(body, 'other'), 'x-github-event': 'push' },
        body,
        secret,
      ),
    ).toBeNull()
    expect(h.parseWebhook({ 'x-github-event': 'push' }, body, secret)).toBeNull()
    expect(
      h.parseWebhook(
        { 'x-hub-signature-256': sign(body).slice(7), 'x-github-event': 'push' },
        body,
        secret,
      ),
    ).toBeNull()
    expect(
      h.parseWebhook({ 'x-hub-signature-256': sign(body), 'x-github-event': 'ping' }, body, secret),
    ).toBeNull()
  })
})
