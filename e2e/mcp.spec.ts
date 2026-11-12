import { execFile } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { expect, test, uid } from './fixtures'

const run = promisify(execFile)

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

  // Move, history, delete, restore: each a commit by the member through MCP.
  const moved = `docs/archive/e2e-mcp-${id}.md`
  const move = await tool(client, 'move_file', { space: user.personal, from: file, to: moved })
  expect(move.path).toBe(moved)
  const history = await tool(client, 'file_history', { space: user.personal, path: moved })
  expect(history.length).toBeGreaterThanOrEqual(2)
  expect(history[0].message).toContain('hearth: move')
  expect(history[0].message).toContain(`Hearth-Via: mcp (token "e2e ${id}")`)
  await tool(client, 'delete_file', { space: user.personal, path: moved })
  expect(await api.readFile(user.personal, moved)).toBeNull()
  await tool(client, 'restore_file', { space: user.personal, path: moved, oid: history[0].oid })
  expect((await api.readFile(user.personal, moved))?.content).toContain(`The ${word} plan.`)

  // The member's own calendar (the fake one, under dev auth).
  const events = await tool(client, 'list_events', {
    from: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    to: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
  })
  expect(events.length).toBeGreaterThan(0)
  const event = await tool(client, 'get_event', { id: events[0].id })
  expect(event).toMatchObject({ id: events[0].id, title: events[0].title })
  expect(typeof event.description).toBe('string')

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

test('list_clips and get_clip read a recorded clip, with its transcript', async ({
  playwright,
  user,
  page,
  baseURL,
}, testInfo) => {
  const dir = testInfo.outputPath('clip')
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, 'clip.webm')
  // Three seconds of test pattern and tone: the fake transcriber writes "clip segment n".
  await run('ffmpeg', [
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc=duration=3:size=160x120:rate=10',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=3',
    '-c:v',
    'libvpx',
    '-c:a',
    'libopus',
    '-shortest',
    file,
  ])
  const owner = await playwright.request.newContext({
    baseURL: baseURL ?? '',
    extraHTTPHeaders: { 'x-hearth-dev-user': user.email },
  })
  const created = await owner.post('/api/clips', {
    data: { mode: 'screen', container: 'webm', title: `MCP clip ${uid()}` },
  })
  expect(created.status(), await created.text()).toBe(201)
  const clip = (await created.json()) as { id: string; title: string }
  const chunk = await owner.put(`/api/clips/${clip.id}/chunks/0`, {
    data: await readFile(file),
    headers: { 'content-type': 'application/octet-stream' },
  })
  expect(chunk.status()).toBe(204)
  expect((await owner.post(`/api/clips/${clip.id}/finish`, { data: { chunks: 1 } })).ok()).toBe(
    true,
  )

  await page.goto('/settings')
  await page.getByTestId('token-name').fill(`clips ${clip.id}`)
  await page.getByTestId('token-create').click()
  const token = (await page.getByTestId('token-secret').textContent()) ?? ''
  const client = await connect(baseURL ?? '', token)

  await expect(async () => {
    const got = await tool(client, 'get_clip', { id: clip.id })
    expect(got.transcriptStatus).toBe('ready')
    expect(got.transcript).toMatch(/^\[0:00\] clip segment 1/)
  }).toPass({ timeout: 30_000 })
  const listed = await tool(client, 'list_clips', { mine: true })
  expect(listed).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: clip.id, url: `${baseURL}/clips/${clip.id}` }),
    ]),
  )
  await client.close()
  await owner.delete(`/api/clips/${clip.id}`)
  await owner.dispose()
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
