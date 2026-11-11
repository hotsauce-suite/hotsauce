import { createHmac } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ForgejoHost } from './forgejo.js'

const host = () =>
  new ForgejoHost({ url: 'http://forgejo.test/', token: 'tok-456', org: 'acme-hotsauce' })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ForgejoHost', () => {
  it('creates the org once, then the repo, and returns a token-bearing clone URL', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (input: string, init: RequestInit) => {
      const url = new URL(input)
      const key = `${init.method} ${url.pathname}`
      calls.push(key)
      if (key === 'POST /api/v1/orgs') return new Response('{}', { status: 201 })
      if (key === 'POST /api/v1/orgs/acme-hotsauce/repos')
        return new Response('{}', { status: 201 })
      return new Response('{}', { status: 404 })
    })
    const h = host()
    expect(await h.ensureRepo('team')).toEqual({
      cloneUrl: 'http://hearth:tok-456@forgejo.test/acme-hotsauce/team.git',
    })
    await h.ensureRepo('alice')
    expect(calls).toEqual([
      'GET /api/v1/orgs/acme-hotsauce',
      'POST /api/v1/orgs',
      'GET /api/v1/repos/acme-hotsauce/team',
      'POST /api/v1/orgs/acme-hotsauce/repos',
      'GET /api/v1/repos/acme-hotsauce/alice',
      'POST /api/v1/orgs/acme-hotsauce/repos',
    ])
  })

  it('reports a host it cannot reach as host_error, logging the cause', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed')
    })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(host().ensureRepo('team')).rejects.toMatchObject({
        code: 'host_error',
        message: 'Forgejo could not be reached',
      })
      expect(logged).toHaveBeenCalledWith(
        'Forgejo: GET /api/v1/orgs/acme-hotsauce failed:',
        expect.any(TypeError),
      )
    } finally {
      logged.mockRestore()
    }
  })
})

describe('ForgejoHost.parseWebhook', () => {
  const secret = 'webhook-secret'
  const body = JSON.stringify({ ref: 'refs/heads/main', repository: { name: 'team' } })
  const sign = (b: string, s = secret) => createHmac('sha256', s).update(b).digest('hex')

  it('accepts a correctly signed push (hex signature, no prefix)', () => {
    const headers = { 'X-Forgejo-Signature': sign(body), 'X-Forgejo-Event': 'push' }
    expect(host().parseWebhook(headers, body, secret)).toEqual({
      repo: 'team',
      ref: 'refs/heads/main',
    })
  })

  it('rejects a bad signature, a GitHub-style prefixed one, and non-push events', () => {
    const h = host()
    const event = { 'x-forgejo-event': 'push' }
    expect(
      h.parseWebhook({ ...event, 'x-forgejo-signature': sign(body, 'x') }, body, secret),
    ).toBeNull()
    expect(
      h.parseWebhook({ ...event, 'x-forgejo-signature': `sha256=${sign(body)}` }, body, secret),
    ).toBeNull()
    expect(h.parseWebhook(event, body, secret)).toBeNull()
    expect(
      h.parseWebhook(
        { 'x-forgejo-signature': sign(body), 'x-forgejo-event': 'create' },
        body,
        secret,
      ),
    ).toBeNull()
  })
})
