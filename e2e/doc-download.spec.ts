import { readFile } from 'node:fs/promises'
import { strFromU8, unzipSync } from 'fflate'
import { docUrl, expect, test, uid } from './fixtures'

// A Doc downloaded as Word or PDF (docs/PLAN-doc-download.md R1, R2, R3).

const PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

test('the Share menu downloads a doc as Word and as PDF, with its image and table', async ({
  page,
  request,
  api,
  user,
}) => {
  const id = uid()
  const upload = await request.post(`/api/spaces/${encodeURIComponent(user.team)}/assets`, {
    headers: { 'x-hearth-dev-user': user.email },
    multipart: {
      file: { name: 'pixel.png', mimeType: 'image/png', buffer: Buffer.from(PIXEL_PNG, 'base64') },
    },
  })
  expect(upload.ok()).toBe(true)
  const { path: asset } = (await upload.json()) as { path: string }
  const file = `docs/e2e-download-${id}.md`
  await api.writeFile(
    user.team,
    file,
    `---\nnote: hidden-${id}\n---\n# Report ${id}\n\nSome **bold** words.\n\n| Fruit | Count |\n| --- | --- |\n| Pear | 4 |\n\n![Pixel](../${asset})\n`,
  )

  await page.goto(docUrl(user.team, file))
  await expect(page.getByTestId('editor-content')).toContainText('Some')

  await page.getByTestId('share-menu').click()
  const wordDownload = page.waitForEvent('download')
  await page.getByTestId('download-docx').click()
  const word = await wordDownload
  expect(word.suggestedFilename()).toBe(`Report ${id}.docx`)
  const files = unzipSync(new Uint8Array(await readFile((await word.path()) ?? '')))
  const body = strFromU8(files['word/document.xml'] ?? new Uint8Array())
  expect(body).toContain(`Report ${id}`)
  expect(body).toContain('Pear')
  expect(body).toContain('w:tbl')
  expect(body).toContain('w:drawing')
  expect(body).not.toContain(`hidden-${id}`)
  expect(Object.keys(files).some((n) => n.startsWith('word/media/'))).toBe(true)

  await page.getByTestId('share-menu').click()
  const pdfDownload = page.waitForEvent('download')
  await page.getByTestId('download-pdf').click()
  const pdf = await pdfDownload
  expect(pdf.suggestedFilename()).toBe(`Report ${id}.pdf`)
  const bytes = await readFile((await pdf.path()) ?? '')
  expect(bytes.subarray(0, 5).toString()).toBe('%PDF-')
  // The picture is in it as an image XObject.
  expect(bytes.toString('latin1')).toContain('/Subtype /Image')
})
