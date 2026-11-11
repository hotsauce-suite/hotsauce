import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { expect, test, uid } from './fixtures'

/** A real MCP client over Streamable HTTP to the built server, authenticated with a token. */
async function connect(baseURL: string, token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', baseURL), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  })
  const client = new Client({ name: 'hearth-e2e', version: '1.0.0' })
  await client.connect(transport)
  return client
}

async function tool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
  // biome-ignore lint/suspicious/noExplicitAny: tool results are JSON checked by the assertions
): Promise<any> {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult
  const first = result.content[0]
  const text = first?.type === 'text' ? first.text : ''
  expect(result.isError, `${name}: ${text}`).toBeFalsy()
  return JSON.parse(text)
}

test('a token made in Settings connects an MCP client that searches, reads and writes as the member', async ({
  page,
  api,
  user,
  baseURL,
}) => {
  const id = uid()
  await page.goto('/docs')
  await page.getByTestId('settings-link').click()
  await expect(page).toHaveURL(/\/settings$/)
  await page.getByTestId('token-name').fill(`e2e ${id}`)
  await page.getByTestId('token-create').click()
  const token = (await page.getByTestId('token-secret').textContent()) ?? ''
  expect(token).toMatch(/^hth_/)
  await expect(page.getByTestId('token-command')).toContainText(`${baseURL}/mcp`)

  const client = await connect(baseURL ?? '', token)
  const spaces = await tool(client, 'list_spaces')
  expect(spaces.map((s: { name: string }) => s.name).sort()).toEqual(
    [user.personal, user.team].sort(),
  )

  const file = `docs/e2e-mcp-${id}.md`
  const word = `ocelot${id}`
  const written = await tool(client, 'write_file', {
    space: user.personal,
    path: file,
    content: `# MCP note ${id}\n\nThe ${word} plan.\n`,
  })
  expect(written.status).toBe('committed')

  await expect(async () => {
    const hits = await tool(client, 'search', { query: word })
    expect(hits).toEqual([expect.objectContaining({ space: user.personal, path: file })])
  }).toPass({ timeout: 5_000 })

  const read = await tool(client, 'read_file', { space: user.personal, path: file })
  expect(read.content).toContain(`The ${word} plan.`)

  const [commit] = await api.history(user.personal, file)
  expect(commit?.author.email).toBe(user.email)
  expect(commit?.message).toContain(`Hearth-Via: mcp (token "e2e ${id}")`)

  // The member sees it in Hearth Docs too.
  await page.goto(`/docs/${user.personal}/${file}`)
  await expect(page.getByTestId('editor-content')).toContainText(`The ${word} plan.`)
  await client.close()

  // Revoked in Settings, the token stops working at once.
  await page.goto('/settings')
  page.once('dialog', (dialog) => void dialog.accept())
  await page
    .getByTestId('token-item')
    .filter({ hasText: `e2e ${id}` })
    .getByTestId('token-revoke')
    .click()
  await expect(page.getByTestId('token-item').filter({ hasText: `e2e ${id}` })).toHaveCount(0)
  await expect(connect(baseURL ?? '', token)).rejects.toThrow()
})

test('/mcp refuses calls without a token, and there is no OAuth to discover', async ({
  request,
}) => {
  const res = await request.post('/mcp', {
    headers: { accept: 'application/json, text/event-stream' },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
  })
  expect(res.status()).toBe(401)
  // A client that then looks for OAuth gets a 404, not the web app's index.html.
  const discovery = await request.get('/.well-known/oauth-protected-resource')
  expect(discovery.status()).toBe(404)
})
