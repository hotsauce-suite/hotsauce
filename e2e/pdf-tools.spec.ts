import type { APIRequestContext, Page } from '@playwright/test'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { uid } from './fixtures'
import { expect, test } from './meetings-fixtures'

// PDF tools in Files (docs/PLAN-pdf-tools.md): the critical journeys in a real browser. A member
// opens a PDF, rearranges its pages, splits it, redacts a word, and makes a scan searchable; each
// result lands beside the original, which stays as it was.

async function textPdf(lines: string[]): Promise<Buffer> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (const line of lines) {
    doc.addPage([612, 792]).drawText(line, { x: 72, y: 700, size: 28, font })
  }
  return Buffer.from(await doc.save())
}

const row = (page: Page, name: string) => page.getByTestId('files-row').filter({ hasText: name })

async function uploadAndOpenTools(page: Page, personal: string, name: string, bytes: Buffer) {
  await page.goto(`/files?space=${encodeURIComponent(personal)}`)
  await page
    .getByTestId('files-input')
    .setInputFiles([{ name, mimeType: 'application/pdf', buffer: bytes }])
  await expect(row(page, name)).toBeVisible({ timeout: 15_000 })
  await row(page, name).getByTestId('files-row-menu').click()
  await page.getByTestId('files-pdf-tools').click()
  await expect(page.getByTestId('pdf-tools')).toBeVisible()
}

/** The bytes of the file called `name` in `space`, read through the API as the member. */
async function bytesOf(
  request: APIRequestContext,
  space: string,
  name: string,
): Promise<Uint8Array> {
  const listing = await (await request.get(`/api/files?space=${encodeURIComponent(space)}`)).json()
  const file = (listing.files as Array<{ id: string; name: string }>).find((f) => f.name === name)
  if (!file) throw new Error(`no ${name}`)
  const res = await request.get(`/api/files/item/${encodeURIComponent(space)}/${file.id}/pdf`)
  return new Uint8Array(await res.body())
}

const pdfOf = async (request: APIRequestContext, space: string, name: string) =>
  PDFDocument.load(await bytesOf(request, space, name))

test('rotate, reorder and remove pages, then split, beside the original', async ({
  page,
  member,
}) => {
  const id = uid()
  const name = `report-${id}.pdf`
  await uploadAndOpenTools(page, member.personal, name, await textPdf(['One', 'Two', 'Three']))

  await expect(page.getByTestId('pdf-page')).toHaveCount(3)
  // Page 1 turned right and moved after page 2; page 3 removed.
  await page.getByTestId('pdf-page').nth(0).getByTestId('pdf-page-rotate').click()
  await expect(page.getByTestId('pdf-page').nth(0)).toHaveAttribute('data-rotate', '90')
  await page.getByTestId('pdf-page').nth(0).getByTestId('pdf-page-later').click()
  await page.getByTestId('pdf-page').nth(2).getByTestId('pdf-page-remove').click()
  await expect(page.getByTestId('pdf-page')).toHaveCount(2)
  await page.getByTestId('pdf-pages-save').click()
  await expect(page.getByTestId('pdf-tools-saved')).toContainText(`report-${id} (edited).pdf`, {
    timeout: 20_000,
  })

  const edited = await pdfOf(member.request, member.personal, `report-${id} (edited).pdf`)
  expect(edited.getPageCount()).toBe(2)
  expect(edited.getPage(1).getRotation().angle).toBe(90)
  // The original is unchanged.
  expect((await pdfOf(member.request, member.personal, name)).getPageCount()).toBe(3)

  await page.getByTestId('pdf-tab-split').click()
  await page.getByTestId('pdf-split-ranges').fill('1-9')
  await page.getByTestId('pdf-split-save').click()
  await expect(page.getByTestId('pdf-split-error')).toContainText('this PDF has 3 pages')
  await page.getByTestId('pdf-split-ranges').fill('1, 2-')
  await page.getByTestId('pdf-split-save').click()
  await expect(page.getByTestId('pdf-tools-saved')).toContainText('Saved 2 PDFs', {
    timeout: 20_000,
  })
  expect(
    (await pdfOf(member.request, member.personal, `report-${id} (pages 2-3).pdf`)).getPageCount(),
  ).toBe(2)

  // Open the result from the message.
  await page.getByTestId('pdf-tools-open').first().click()
  await expect(page.getByTestId('file-dialog')).toContainText(`report-${id} (page 1).pdf`)
})

test('redact a word: the saved copy has no trace of it and keeps the rest searchable', async ({
  page,
  member,
}) => {
  const id = uid()
  const name = `letter-${id}.pdf`
  await uploadAndOpenTools(
    page,
    member.personal,
    name,
    await textPdf(['Dear Morgan Smith, welcome', 'Nothing to hide here']),
  )
  await page.getByTestId('pdf-tab-redact').click()
  await expect(page.getByTestId('pdf-redact-page')).toHaveCount(2)
  await page.getByTestId('pdf-redact-find').fill('Smith')
  await page.getByTestId('pdf-redact-find-go').click()
  await expect(page.getByTestId('pdf-redact-found')).toContainText('Boxed 1 place')
  await expect(page.getByTestId('pdf-redact-box')).toHaveCount(1)
  await page.getByTestId('pdf-redact-save').click()
  await expect(page.getByTestId('pdf-tools-saved')).toContainText(`letter-${id} (redacted).pdf`, {
    timeout: 90_000,
  })
  const doc = await pdfOf(member.request, member.personal, `letter-${id} (redacted).pdf`)
  expect(doc.getPageCount()).toBe(2)
  // Every stream, decompressed, searched for the word in Helvetica's hex and as plain text.
  const { inflateSync } = await import('node:zlib')
  const { PDFRawStream, PDFName } = await import('pdf-lib')
  let all = ''
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue
    let data: Uint8Array = obj.contents
    if (obj.dict.lookup(PDFName.of('Filter')) === PDFName.of('FlateDecode')) {
      try {
        data = inflateSync(data)
      } catch {}
    }
    all += Buffer.from(data).toString('latin1')
  }
  expect(all).not.toContain(Buffer.from('Smith').toString('hex').toUpperCase())
  expect(all).not.toContain('Smith')
  // Page 2 was copied as it was.
  expect(all).toContain(Buffer.from('Nothing to hide here').toString('hex').toUpperCase())
})

test('make a scanned page searchable in the browser', async ({ page, member }) => {
  test.setTimeout(180_000)
  // A "scan": a page that is only a picture of words.
  await page.goto('/files')
  const png = await page.evaluate(() => {
    const c = document.createElement('canvas')
    c.width = 1700
    c.height = 2200
    const ctx = c.getContext('2d') as CanvasRenderingContext2D
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, c.width, c.height)
    ctx.fillStyle = '#000'
    ctx.font = '72px Arial, Helvetica, sans-serif'
    ctx.fillText('QUARTERLY INVOICE', 150, 300)
    ctx.fillText('Total due today', 150, 450)
    return c.toDataURL('image/png').split(',')[1] as string
  })
  const doc = await PDFDocument.create()
  const image = await doc.embedPng(Buffer.from(png, 'base64'))
  doc.addPage([612, 792]).drawImage(image, { x: 0, y: 0, width: 612, height: 792 })
  const id = uid()
  await uploadAndOpenTools(page, member.personal, `scan-${id}.pdf`, Buffer.from(await doc.save()))
  await page.getByTestId('pdf-tab-searchable').click()
  await page.getByTestId('pdf-searchable-run').click()
  await expect(page.getByTestId('pdf-tools-saved')).toContainText(`scan-${id} (searchable).pdf`, {
    timeout: 150_000,
  })
  // Files reads the new copy's text like any upload: search finds the word.
  await page.keyboard.press('Escape')
  await page.getByTestId('files-search').fill('quarterly')
  await expect(row(page, `scan-${id} (searchable).pdf`)).toBeVisible({ timeout: 20_000 })
})
