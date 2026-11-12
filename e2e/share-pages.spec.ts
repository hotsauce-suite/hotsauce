import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { docUrl, expect, signIn, test, uid } from './fixtures'

// Share pages (docs/plans/2026-11-12-share-pages.md): a read-only link opened by a teammate and
// refused signed out, then turned off; and a page Claude publishes over MCP, read in Pages.

test('a read-only link opens for a teammate, not signed out, and stops when turned off', async ({
  page,
  api,
  user,
  browser,
  baseURL,
  playwright,
}) => {
  const id = uid()
  const file = `docs/e2e-share-${id}.md`
  await api.writeFile(user.team, file, `# Share ${id}\n\nThe plan, read-only.\n`)
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto(docUrl(user.team, file))
  await page.getByTestId('share-menu').click()
  await page.getByTestId('read-only-link-on').click()
  await expect(page.getByText('Read-only link copied.')).toBeVisible()
  const request = await playwright.request.newContext({
    baseURL: baseURL ?? '',
    extraHTTPHeaders: { 'x-hearth-dev-user': api.email },
  })
  const res = await request.get('/api/shares', { params: { space: user.team, path: file } })
  const { url } = (await res.json()) as { url: string }
  await request.dispose()
  expect(url).toMatch(/^\/s\/[A-Za-z0-9_-]{16,}$/)

  // A teammate reads it in its clean page.
  const teammate = await browser.newContext()
  const other = await teammate.newPage()
  await signIn(other, `e2e-mate-${id}@example.test`)
  await other.goto(url)
  await expect(other.getByTestId('shared-markdown')).toContainText('The plan, read-only.')
  await expect(other.getByRole('heading', { name: `Share ${id}` })).toBeVisible()

  // Signed out: members only by default.
  const outside = await browser.newContext()
  const stranger = await outside.newPage()
  await stranger.goto(url)
  await expect(stranger.getByText('Sign in to read this')).toBeVisible()

  // Off: the link stops at once.
  await page.getByTestId('share-menu').click()
  await page.getByTestId('read-only-link-off').click()
  await expect(page.getByText('Read-only link turned off.')).toBeVisible()
  await other.reload()
  await expect(other.getByText('This link doesn’t open')).toBeVisible()
  await teammate.close()
  await outside.close()
})

test('a page Claude publishes over MCP shows in Pages, walled off, with its versions', async ({
  page,
  api,
  baseURL,
  playwright,
}) => {
  const id = uid()
  const request = await playwright.request.newContext({
    baseURL: baseURL ?? '',
    extraHTTPHeaders: { 'x-hearth-dev-user': api.email },
  })
  const { token } = await (
    await request.post('/api/tokens', { data: { name: `e2e ${id}` } })
  ).json()
  await request.dispose()
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', baseURL), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  })
  const client = new Client({ name: 'hearth-e2e', version: '1.0.0' })
  await client.connect(transport)
  const publish = async (args: Record<string, unknown>) => {
    const r = (await client.callTool({ name: 'publish_page', arguments: args })) as CallToolResult
    const first = r.content[0]
    const text = first?.type === 'text' ? first.text : ''
    expect(r.isError, text).toBeFalsy()
    return JSON.parse(text)
  }
  const html = (h: string) => `<!doctype html><html><body><h1>${h}</h1></body></html>`
  const first = await publish({ title: `Report ${id}`, html: html('First draft') })
  await publish({ id: first.id, title: `Report ${id}`, html: html('Final') })
  await client.close()

  await page.goto('/docs')
  await page.getByTestId('sidebar-pages').click()
  await page.getByRole('link', { name: new RegExp(`Report ${id}`) }).click()
  const frame = page.frameLocator('[data-testid="page-frame"]')
  await expect(frame.getByRole('heading', { name: 'Final' })).toBeVisible()
  await page.getByTestId('page-version').selectOption({ index: 1 })
  await expect(frame.getByRole('heading', { name: 'First draft' })).toBeVisible()
})
