import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../../src/app.js'
import { loadConfig } from '../../src/config.js'
import { createServices, type Services } from '../../src/services.js'
import { makeTempDir, removeDir } from '../helpers/git.js'

// People invited from outside the allowed domains (docs/plans/2026-11-12-invited-emails.md).
const MEMBER = 'ada@acmebiolab.com'
const INVITED = 'ada@gmail.com'
const OUTSIDER = 'eve@gmail.com'

let root: string | undefined
let running: Services[] = []

afterEach(async () => {
  for (const s of running) s.index.close()
  running = []
  if (root) await removeDir(root)
  root = undefined
})

/** An instance on one data directory; a second call with other env is the same server restarted. */
async function instance(env: Record<string, string>) {
  root ??= await makeTempDir('hearth-invited-')
  const config = loadConfig({
    NODE_ENV: 'test',
    AUTH_MODE: 'dev',
    HOST_KIND: 'local',
    DATA_DIR: join(root, 'data'),
    LOCAL_HOST_DIR: join(root, 'remotes'),
    ALLOWED_EMAIL_DOMAINS: 'acmebiolab.com',
    ...env,
  })
  const services = createServices(config)
  running.push(services)
  await services.spaces.ensureTeamSpace()
  const app = createApp(services)
  return (
    method: string,
    path: string,
    opts: { as?: string; token?: string; json?: unknown } = {},
  ) => {
    const headers: Record<string, string> = {}
    if (opts.as) headers['x-hearth-dev-user'] = opts.as
    if (opts.token) headers.authorization = `Bearer ${opts.token}`
    if (opts.json !== undefined) headers['content-type'] = 'application/json'
    // Streamable HTTP clients send both.
    if (path === '/mcp') headers.accept = 'application/json, text/event-stream'
    return app.request(path, {
      method,
      headers,
      ...(opts.json !== undefined ? { body: JSON.stringify(opts.json) } : {}),
    })
  }
}

describe('invited people', () => {
  it('health offers email-code sign-in only when someone is invited', async () => {
    const without = await instance({})
    expect((await (await without('GET', '/api/health')).json()).emailCodeSignIn).toBe(false)
    const withInvite = await instance({ ALLOWED_EMAILS: INVITED })
    const health = await (await withInvite('GET', '/api/health')).json()
    expect(health.emailCodeSignIn).toBe(true)
    // Health is public: it never names who is invited.
    expect(JSON.stringify(health)).not.toContain('gmail')
  })

  it('an invited person signs in beside a member with the same name, each with their own space', async () => {
    const call = await instance({ ALLOWED_EMAILS: INVITED })
    const member = await (await call('GET', '/api/me', { as: MEMBER })).json()
    const invited = await (await call('GET', '/api/me', { as: INVITED })).json()
    expect(member.principal.handle).toBe('ada')
    expect(invited.principal.handle).toBe('ada-gmail-com')
    expect(invited.spaces.map((s: { name: string }) => s.name).sort()).toEqual([
      'ada-gmail-com',
      'team',
    ])

    // They read the team space like any member, but never the member's personal space.
    expect((await call('GET', '/api/spaces/team/tree', { as: INVITED })).status).toBe(200)
    expect((await call('GET', '/api/spaces/ada/tree', { as: INVITED })).status).toBe(403)
    expect((await call('GET', '/api/spaces/ada-gmail-com/tree', { as: MEMBER })).status).toBe(403)
  })

  it('everyone else is still refused: web session, Mac app ticket and tokens', async () => {
    const call = await instance({ ALLOWED_EMAILS: INVITED })
    for (const as of [OUTSIDER, 'ada@gmail.co', 'ada+clerk_test@gmail.com']) {
      expect((await call('GET', '/api/me', { as })).status, as).toBe(403)
      expect((await call('POST', '/api/desktop/ticket', { as })).status, as).toBe(403)
      expect((await call('POST', '/api/tokens', { as, json: { name: 'x' } })).status, as).toBe(403)
    }
  })

  it('taking someone off the list stops their access token, on the API and over MCP', async () => {
    const before = await instance({ ALLOWED_EMAILS: INVITED })
    const made = await before('POST', '/api/tokens', { as: INVITED, json: { name: 'laptop' } })
    expect(made.status).toBe(201)
    const { token } = (await made.json()) as { token: string }
    expect((await before('GET', '/api/me', { token })).status).toBe(200)
    const listed = await before('POST', '/mcp', {
      token,
      json: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    })
    expect(listed.status).toBe(200)
    expect(await listed.text()).toContain('list_spaces')

    // The admin empties the list and the server restarts with it.
    const after = await instance({})
    expect((await after('GET', '/api/me', { token })).status).toBe(403)
    const mcp = await after('POST', '/mcp', {
      token,
      json: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    })
    expect(mcp.status).toBe(403)
  })
})
