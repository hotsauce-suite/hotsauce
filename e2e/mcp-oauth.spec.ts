import { createHash, randomBytes } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { expect, test } from './fixtures'

// An AI tool's own address: the browser is sent here after Allow, and we catch it.
const REDIRECT = 'https://ai-tool.example/oauth/callback'

test('an AI tool connects by signing in, works on /mcp, and stops when disconnected in Settings', async ({
  page,
  user,
  baseURL,
}) => {
  const base = baseURL ?? ''
  const meta = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json()
  expect(meta.resource).toBe(`${base}/mcp`)
  const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()

  const reg = await fetch(as.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: 'E2E Tool' }),
  })
  expect(reg.status).toBe(201)
  const { client_id } = await reg.json()

  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const authorize = new URL(as.authorization_endpoint)
  authorize.search = new URLSearchParams({
    client_id,
    redirect_uri: REDIRECT,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'e2e-state',
    resource: `${base}/mcp`,
  }).toString()

  let landed: URL | null = null
  await page.route('https://ai-tool.example/**', async (route) => {
    landed = new URL(route.request().url())
    await route.fulfill({ status: 200, body: 'back in the tool' })
  })
  await page.goto(authorize.toString())
  await expect(page.getByRole('heading', { name: /Let E2E Tool use your/ })).toBeVisible()
  await expect(page.getByText(user.email)).toBeVisible()
  await page.getByRole('button', { name: 'Allow' }).click()
  await expect(page.getByText('back in the tool')).toBeVisible()
  // biome-ignore lint/style/noNonNullAssertion: set by the route above
  const back = landed!
  expect(back.searchParams.get('state')).toBe('e2e-state')
  expect(back.searchParams.get('iss')).toBe(base)

  const tokenRes = await fetch(as.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: back.searchParams.get('code') ?? '',
      code_verifier: verifier,
      client_id,
      redirect_uri: REDIRECT,
    }),
  })
  expect(tokenRes.status).toBe(200)
  const tokens = await tokenRes.json()

  const refreshed = await (
    await fetch(as.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        client_id,
      }),
    })
  ).json()
  expect(refreshed.access_token).toMatch(/^hto_/)

  const transport = new StreamableHTTPClientTransport(new URL('/mcp', base), {
    requestInit: { headers: { authorization: `Bearer ${refreshed.access_token}` } },
  })
  const client = new Client({ name: 'e2e-tool', version: '1.0.0' })
  await client.connect(transport)
  const result = (await client.callTool({ name: 'list_spaces', arguments: {} })) as CallToolResult
  const first = result.content[0]
  const spaces = JSON.parse(first?.type === 'text' ? first.text : '[]') as { name: string }[]
  expect(spaces.map((s) => s.name).sort()).toEqual([user.personal, user.team].sort())
  await client.close()

  await page.goto('/settings')
  const item = page.getByTestId('connection-item').filter({ hasText: 'E2E Tool' })
  await expect(item).toContainText('ai-tool.example')
  page.once('dialog', (d) => void d.accept())
  await item.getByTestId('connection-disconnect').click()
  await expect(item).toHaveCount(0)

  const after = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${refreshed.access_token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })
  expect(after.status).toBe(401)
  expect(after.headers.get('www-authenticate')).toContain('error="invalid_token"')
})
