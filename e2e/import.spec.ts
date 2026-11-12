import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, parseDocUrl, test, uid } from './fixtures'

const DOCX = path.join(import.meta.dirname, 'files', 'quarterly-plan.docx')

// Docs import: Markdown as written, Word and HTML converted, each a new doc named from its heading.

test('importing Word, Markdown and HTML files makes a doc of each', async ({ page, api, user }) => {
  const id = uid()
  await page.goto('/docs')
  await expect(page.getByTestId('import-docs')).toBeVisible()

  const md = `# Field notes ${id}\n\nKept *exactly* as written.\n`
  const html = `<h1>Web page ${id}</h1><p><span style="font-weight:700">Strong</span> words.</p>`
  await page.getByTestId('import-input').setInputFiles([
    { name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from(md) },
    { name: 'page.html', mimeType: 'text/html', buffer: Buffer.from(html) },
    {
      name: 'quarterly-plan.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: readFileSync(DOCX),
    },
  ])

  // The last file imported opens.
  // The Word doc is named from its heading (another run may already hold quarterly-plan.md).
  await expect(page).toHaveURL(/\/docs\/quarterly-plan(-\d+)?\.md$/, { timeout: 15_000 })
  const wordPath = parseDocUrl(page.url()).path
  const editor = page.getByTestId('editor-content')
  await expect(editor).toContainText('Quarterly plan')
  await expect(editor.locator('.cm-lp-table-widget')).toContainText('Sam')
  // The Word file's picture was uploaded and shows.
  await expect(editor.locator('.cm-lp-image img')).toHaveJSProperty('complete', true)

  expect((await api.readFile(user.team, `docs/field-notes-${id}.md`))?.content).toContain(
    'Kept *exactly* as written.',
  )
  expect((await api.readFile(user.team, `docs/web-page-${id}.md`))?.content).toContain(
    '**Strong** words.',
  )
  const word = (await api.readFile(user.team, wordPath))?.content ?? ''
  expect(word).toMatch(/!\[[^\]]*\]\(\.\.\/[^)]+\.png\)/)
  expect(word).toContain('- First point')

  // A second import of the same file never overwrites the first.
  await page.getByTestId('import-input').setInputFiles(DOCX)
  await expect(page).toHaveURL(
    (url) =>
      /\/docs\/quarterly-plan-\d+\.md$/.test(url.pathname) && !url.pathname.endsWith(wordPath),
  )
  expect((await api.readFile(user.team, wordPath))?.content).toBe(word)
})

test('a file Docs can’t read is refused with a message', async ({ page }) => {
  await page.goto('/docs')
  await page.getByTestId('import-input').setInputFiles({
    name: 'deck.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF'),
  })
  await expect(page.getByText('deck.pdf isn’t a file Docs can import')).toBeVisible()
})
