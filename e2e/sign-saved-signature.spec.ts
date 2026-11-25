import type { Page } from '@playwright/test'
import { uid } from './fixtures'
import { expect, test } from './meetings-fixtures'

// Uploading and saving a signature (docs/PLAN-sign-saved-signature.md R1, R6, R7): a member signs
// with a photo of their signature, keeps it, finds it under "Your signature", reuses it with one
// click on the next envelope, and deletes it.

/** A one-page PDF with `text` on it. */
function pdf(text: string): Buffer {
  const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objs.forEach((o, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out)
}

/** A JPEG like a phone photo: off-white paper with a shadow, and a dark pen scribble. */
async function photo(page: Page): Promise<Buffer> {
  const b64 = await page.evaluate(() => {
    const c = document.createElement('canvas')
    c.width = 1200
    c.height = 800
    const ctx = c.getContext('2d')
    if (!ctx) throw new Error('no canvas')
    const g = ctx.createLinearGradient(0, 0, 1200, 0)
    g.addColorStop(0, '#f4f1ea')
    g.addColorStop(1, '#bdb8ad')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, 1200, 800)
    ctx.strokeStyle = '#1b2a6b'
    ctx.lineWidth = 9
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(300, 450)
    for (let x = 300; x <= 900; x += 20) ctx.lineTo(x, 420 + Math.sin(x / 30) * 70)
    ctx.stroke()
    return c.toDataURL('image/jpeg', 0.85).split(',')[1] ?? ''
  })
  return Buffer.from(b64, 'base64')
}

const row = (page: Page, name: string) => page.getByTestId('files-row').filter({ hasText: name })

async function clickPage(page: Page, x: number, y: number) {
  const target = page.locator('[data-page-layer="1"]')
  const box = await target.boundingBox()
  if (!box) throw new Error('no page')
  await target.click({ position: { x: box.width * x, y: box.height * y } })
}

/** Opens a new envelope from a fresh PDF with one signature field, and starts signing it. */
async function startSigning(page: Page, personal: string, name: string) {
  await page.goto(`/files?space=${encodeURIComponent(personal)}`)
  await page
    .getByTestId('files-input')
    .setInputFiles([{ name, mimeType: 'application/pdf', buffer: pdf(name) }])
  await expect(row(page, name)).toBeVisible({ timeout: 15_000 })
  await row(page, name).getByTestId('files-open').click()
  await page.getByTestId('file-send-for-signature').click()
  await expect(page.getByTestId('sign-page-1')).toBeVisible()
  await page.getByTestId('sign-add-signature').click()
  await clickPage(page, 0.3, 0.8)
  await page.getByTestId('sign-save').click()
  await expect(page.getByTestId('sign-save')).toHaveText('Saved')
  await page.getByTestId('sign-start').click()
  await page.getByTestId('sign-field-f1').click()
}

async function finish(page: Page) {
  await page.getByTestId('sign-consent').check()
  await page.getByTestId('sign-finish').click()
  await expect(page.getByTestId('sign-finished')).toBeVisible({ timeout: 30_000 })
}

test('sign with an uploaded photo, save it, reuse it, and delete it', async ({ page, member }) => {
  const id = uid()
  await startSigning(page, member.personal, `photo-${id}.pdf`)

  // Nothing saved yet: no Saved tab. Upload a photo; the cleaned preview shows.
  await expect(page.getByTestId('signature-saved')).toHaveCount(0)
  await page.getByTestId('signature-upload').click()
  await page
    .getByTestId('signature-file')
    .setInputFiles([{ name: 'signature.jpg', mimeType: 'image/jpeg', buffer: await photo(page) }])
  const preview = page.getByTestId('signature-upload-preview')
  await expect(preview).toBeVisible()
  // Cropped to the ink: much wider than tall, like the scribble.
  const size = await preview.evaluate((img) => ({
    w: (img as HTMLImageElement).naturalWidth,
    h: (img as HTMLImageElement).naturalHeight,
  }))
  expect(size.w).toBeGreaterThan(size.h * 2.5)
  await expect(page.getByTestId('signature-save')).toBeChecked()
  await page.getByTestId('signature-done').click()
  await expect(page.locator('[data-testid="sign-field-f1"] img')).toBeVisible()
  await expect(page.getByText('Saved your signature for next time')).toBeVisible()
  await finish(page)

  // "Your signature" on the Sign home page shows it.
  await page.goto('/sign')
  const card = page.getByTestId('saved-signature')
  await expect(card.locator('img')).toBeVisible()
  await expect(page.getByTestId('saved-initials')).toContainText('None saved yet')

  // The next envelope opens on Saved: one click puts it on.
  await startSigning(page, member.personal, `again-${id}.pdf`)
  await expect(page.getByTestId('signature-saved-preview').locator('img')).toBeVisible()
  await page.getByTestId('signature-done').click()
  await expect(page.locator('[data-testid="sign-field-f1"] img')).toBeVisible()
  await finish(page)

  // Delete it; next time there is no Saved tab.
  await page.goto('/sign')
  await page.getByTestId('saved-signature-delete').click()
  await expect(card).toContainText('None saved yet')
})

test('a picture with no signature in it says so', async ({ page, member }) => {
  await startSigning(page, member.personal, `blank-${uid()}.pdf`)
  await page.getByTestId('signature-upload').click()
  const blank = Buffer.from(
    await page.evaluate(() => {
      const c = document.createElement('canvas')
      c.width = 400
      c.height = 200
      const ctx = c.getContext('2d')
      if (ctx) {
        ctx.fillStyle = '#f5f5f5'
        ctx.fillRect(0, 0, 400, 200)
      }
      return c.toDataURL('image/png').split(',')[1] ?? ''
    }),
    'base64',
  )
  await page
    .getByTestId('signature-file')
    .setInputFiles([{ name: 'blank.png', mimeType: 'image/png', buffer: blank }])
  await expect(page.getByTestId('signature-upload-error')).toContainText('No signature found')
  await expect(page.getByTestId('signature-done')).toBeDisabled()
})
