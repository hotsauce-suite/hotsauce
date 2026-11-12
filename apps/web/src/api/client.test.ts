import { HttpResponse, http } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { mockApi, server } from '../test/mockServer'
import { api, HearthApiError, setAuthHeaders, setUnauthorizedHandler, toApiError } from './client'
import { authMessage, HearthSocket } from './ws'

async function rejection(promise: Promise<unknown>): Promise<HearthApiError> {
  try {
    await promise
  } catch (err) {
    if (err instanceof HearthApiError) return err
    throw err
  }
  throw new Error('expected the call to fail')
}

describe('api client', () => {
  it('sends the auth headers on every request', async () => {
    const me = await api.me()
    expect(me.principal.email).toBe('ada@example.test')
    expect(me.spaces.map((s) => s.name)).toEqual(['team', 'ada'])
  })

  it('maps the server error body to code, message and status', async () => {
    const err = await rejection(api.readFile('team', 'docs/missing.md'))
    expect(err.code).toBe('not_found')
    expect(err.status).toBe(404)
    expect(err.message).toContain('docs/missing.md')
  })

  it('maps a domain lock rejection', async () => {
    setAuthHeaders(() => ({ 'x-hearth-dev-user': 'someone@gmail.com' }))
    const err = await rejection(api.me())
    expect(err).toMatchObject({ code: 'domain_not_allowed', status: 403 })
  })

  it('falls back to a status-derived code when the body is not JSON', async () => {
    server.use(http.get('/api/me', () => new HttpResponse('Bad Gateway', { status: 502 })))
    const err = await rejection(api.me())
    expect(err).toMatchObject({ code: 'server_error', status: 502 })
  })

  it('reports network failures as code "network" with status 0', async () => {
    server.use(http.get('/api/me', () => HttpResponse.error()))
    const err = await rejection(api.me())
    expect(err).toMatchObject({ code: 'network', status: 0 })
  })

  it('calls the unauthorized handler on 401', async () => {
    const onUnauthorized = vi.fn()
    setUnauthorizedHandler(onUnauthorized)
    setAuthHeaders(() => ({}))
    const err = await rejection(api.me())
    expect(err.status).toBe(401)
    expect(onUnauthorized).toHaveBeenCalledOnce()
  })

  it('returns a 409 conflict on PUT as a CommitResult, not an error', async () => {
    const before = await api.readFile('team', 'docs/team-rituals.md')
    const result = await api.putFile('team', {
      path: 'docs/team-rituals.md',
      content: before.content.replace('Standup is at 9:30', 'Standup is at 10:00'),
      baseBlobOid: before.blobOid,
    })
    expect(result.status).toBe('conflict')
    if (result.status !== 'conflict') return
    expect(result.theirs.content).toContain('9:45')
    expect(result.conflictRef).toMatch(/^refs\/heads\/conflicts\//)
  })

  it('throws on a 409 whose body is an error rather than a CommitResult', async () => {
    server.use(
      http.put('/api/spaces/:space/file', () =>
        HttpResponse.json({ error: { code: 'conflict', message: 'Busy' } }, { status: 409 }),
      ),
    )
    const err = await rejection(api.putFile('team', { path: 'docs/x.md', content: 'x' }))
    expect(err).toMatchObject({ code: 'conflict', status: 409, message: 'Busy' })
  })

  it('toApiError keeps details from the error body', async () => {
    const res = new Response(
      JSON.stringify({
        error: { code: 'bad_request', message: 'Nope', details: { field: 'path' } },
      }),
      { status: 400 },
    )
    const err = await toApiError(res)
    expect(err.details).toEqual({ field: 'path' })
  })

  it('merges a stale save that touched a different region', async () => {
    const before = await api.readFile('team', 'docs/team-rituals.md')
    const result = await api.putFile('team', {
      path: 'docs/team-rituals.md',
      content: before.content.replace('Offsite in the first week', 'Offsite in the second week'),
      baseBlobOid: before.blobOid,
    })
    expect(result.status).toBe('merged')
    if (result.status !== 'merged') return
    expect(result.content).toContain('second week')
    expect(result.content).toContain('9:45')
  })
})

describe('socket', () => {
  it('builds the auth message from either header style', () => {
    expect(authMessage({ Authorization: 'Bearer abc' })).toEqual({ type: 'auth', token: 'abc' })
    expect(authMessage({ 'x-hearth-dev-user': 'a@example.test' })).toEqual({
      type: 'auth',
      devUser: 'a@example.test',
    })
    expect(authMessage({})).toBeNull()
  })

  it('authenticates with the first message and then receives events', async () => {
    const socket = new HearthSocket()
    const changed = vi.fn()
    socket.onChanged(changed)
    socket.start()
    // Events only flow after the server's "ready", which follows the auth message.
    await vi.waitFor(() => {
      mockApi().broadcast({ type: 'changed', space: 'team', headOid: 'abc', paths: ['docs/a.md'] })
      expect(changed).toHaveBeenCalled()
    })
    expect(changed.mock.calls[0]?.[0]).toMatchObject({ type: 'changed', paths: ['docs/a.md'] })
    socket.stop()
  })
})
