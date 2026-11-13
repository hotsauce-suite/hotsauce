import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { legacyHostRedirect } from './legacyHosts.js'

function app(hosts: string[]) {
  const a = new Hono()
  a.use('*', legacyHostRedirect('https://hotsauce.acme.example', hosts))
  a.all('*', (c) => c.text('served'))
  return a
}

const at = (host: string, path: string, method = 'GET') =>
  app(['old.example', 'www.old.example']).request(`https://${host}${path}`, {
    method,
    headers: { host },
  })

describe('legacyHostRedirect', () => {
  it('sends pages on an old address to the same path on the current one', async () => {
    const res = await at('old.example', '/book/abc?when=tomorrow')
    expect(res.status).toBe(301)
    expect(res.headers.get('location')).toBe('https://hotsauce.acme.example/book/abc?when=tomorrow')
  })

  it('matches the old host without its port or letter case', async () => {
    const res = await at('WWW.Old.Example:443', '/docs')
    expect(res.status).toBe(301)
  })

  it('keeps serving the API, sockets, MCP and downloads on the old address for installed apps', async () => {
    for (const path of [
      '/api/health',
      '/ws/dictation',
      '/mcp',
      '/downloads/Hotsauce.dmg',
      '/.well-known/x',
    ]) {
      expect((await at('old.example', path)).status, path).toBe(200)
    }
  })

  it('serves everything that is not a GET or HEAD', async () => {
    expect((await at('old.example', '/f/abc', 'POST')).status).toBe(200)
  })

  it('leaves the current address and unknown hosts alone', async () => {
    expect((await at('hotsauce.acme.example', '/docs')).status).toBe(200)
    expect((await at('localhost:5173', '/docs')).status).toBe(200)
  })

  it('does nothing without old addresses', async () => {
    const res = await app([]).request('https://old.example/docs', {
      headers: { host: 'old.example' },
    })
    expect(res.status).toBe(200)
  })
})
