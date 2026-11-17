import type { Page } from '@playwright/test'
import { uid } from './fixtures'
import { expect, test } from './meetings-fixtures'

// Sign, slice 2 (docs/PLAN-sign.md R9): a member sends a PDF in Files for signature, places the
// fields, signs it, and finds the sealed copy and its certificate in Files beside the original.

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

const row = (page: Page, name: string) => page.getByTestId('files-row').filter({ hasText: name })

/** Clicks page 1 at fractions of its width and height. */
async function clickPage(page: Page, x: number, y: number) {
  const target = page.locator('[data-page-layer="1"]')
  const box = await target.boundingBox()
  if (!box) throw new Error('no page')
  await target.click({ position: { x: box.width * x, y: box.height * y } })
}

test('send a PDF for signature, sign it, and find the sealed copy in Files', async ({
  page,
  member,
}) => {
  const id = uid()
  const name = `offer-${id}.pdf`
  await page.goto(`/files?space=${encodeURIComponent(member.personal)}`)
  await page
    .getByTestId('files-input')
    .setInputFiles([{ name, mimeType: 'application/pdf', buffer: pdf(`Offer ${id}`) }])
  await expect(row(page, name)).toBeVisible({ timeout: 15_000 })

  await row(page, name).getByTestId('files-open').click()
  await page.getByTestId('file-send-for-signature').click()
  await expect(page).toHaveURL(/\/sign\/[^/]+\/[0-9A-Z]{26}$/)
  await expect(page.getByTestId('sign-page-1')).toBeVisible()
  // The page is drawn from the PDF.
  await expect
    .poll(() =>
      page
        .getByTestId('sign-page-1')
        .locator('canvas')
        .evaluate((c) => (c as HTMLCanvasElement).width),
    )
    .toBeGreaterThan(100)

  // A signature field and a text field, placed by clicking the page.
  await page.getByTestId('sign-add-signature').click()
  await clickPage(page, 0.3, 0.8)
  await expect(page.locator('[data-field-type="signature"]')).toHaveCount(1)
  await page.getByTestId('sign-add-text').click()
  await clickPage(page, 0.3, 0.6)
  await page.getByTestId('sign-add-date').click()
  await clickPage(page, 0.7, 0.8)
  await expect(page.locator('[data-field-type]')).toHaveCount(3)
  await page.getByTestId('sign-save').click()
  await expect(page.getByTestId('sign-save')).toHaveText('Saved')

  // Signing: type the signature, fill the text, agree, finish.
  await page.getByTestId('sign-start').click()
  await expect(page.getByTestId('sign-panel')).toBeVisible()
  await page.getByTestId('sign-field-f1').click()
  await page.getByTestId('signature-typed').fill('Pat Example')
  await page.getByTestId('signature-done').click()
  await page.getByTestId('sign-field-f2').fill('Lab 2')
  await expect(page.getByTestId('sign-finish')).toBeDisabled()
  await page.getByTestId('sign-consent').check()
  await page.getByTestId('sign-finish').click()

  await expect(page.getByTestId('sign-finished')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('sign-audit')).toContainText('Completed and sealed')
  await expect(page.getByTestId('sign-audit-check')).toContainText('checks out')

  // The sealed PDF opens in Files, beside the original and its certificate.
  await page.getByTestId('sign-open-signed').click()
  await expect(page.getByTestId('file-dialog')).toContainText(`offer-${id} (signed).pdf`)
  await page.keyboard.press('Escape')
  await page.getByTestId('files-search').fill(id)
  await expect(row(page, `offer-${id} (certificate).pdf`)).toBeVisible()
  await expect(row(page, `offer-${id} (signed).pdf`)).toBeVisible()

  // The Sign list shows it as signed.
  await page.goto('/sign')
  await expect(
    page.getByTestId('sign-list').getByRole('link', { name: new RegExp(`offer-${id}`) }),
  ).toContainText('Signed')
})

test('places, moves, resizes and removes a field from the keyboard alone', async ({
  page,
  member,
}) => {
  const id = uid()
  const name = `keys-${id}.pdf`
  await page.goto(`/files?space=${encodeURIComponent(member.personal)}`)
  await page
    .getByTestId('files-input')
    .setInputFiles([{ name, mimeType: 'application/pdf', buffer: pdf(`Keys ${id}`) }])
  await expect(row(page, name)).toBeVisible({ timeout: 15_000 })
  await row(page, name).getByTestId('files-open').click()
  await page.getByTestId('file-send-for-signature').click()
  await expect(page.getByTestId('sign-page-1')).toBeVisible()

  // Enter on Signature puts one in the middle of page 1 and focuses it.
  await page.getByTestId('sign-add-signature').focus()
  await page.keyboard.press('Enter')
  const field = page.locator('[data-field-type="signature"]')
  await expect(field).toHaveCount(1)
  await expect(page.locator('[data-field-focus="f1"]')).toBeFocused()

  const box = async () => {
    const b = await field.boundingBox()
    if (!b) throw new Error('no field')
    return b
  }
  const start = await box()
  await page.keyboard.press('Shift+ArrowRight')
  await expect.poll(async () => (await box()).x).toBeGreaterThan(start.x + 2)
  await page.keyboard.press('Alt+Shift+ArrowRight')
  await expect.poll(async () => (await box()).width).toBeGreaterThan(start.width + 2)
  await page.keyboard.press('Delete')
  await expect(field).toHaveCount(0)
})

// Slice 3 (docs/PLAN-sign.md R10–R16): someone outside the team signs from their own link.
test('send to someone outside the team, who signs from their link with no account', async ({
  page,
  member,
  browser,
}) => {
  const id = uid()
  const name = `terms-${id}.pdf`
  await page.goto(`/files?space=${encodeURIComponent(member.personal)}`)
  await page
    .getByTestId('files-input')
    .setInputFiles([{ name, mimeType: 'application/pdf', buffer: pdf(`Terms ${id}`) }])
  await expect(row(page, name)).toBeVisible({ timeout: 15_000 })
  await row(page, name).getByTestId('files-open').click()
  await page.getByTestId('file-send-for-signature').click()
  await expect(page.getByTestId('sign-page-1')).toBeVisible()

  // Swap the member for an outside signer, and add someone who only gets a copy.
  const people = page.getByTestId('sign-people')
  await people.getByTestId('sign-person-name').first().fill('Maya Lin')
  await people.getByTestId('sign-person-email').first().fill(`maya-${id}@outside.example`)
  await people.getByTestId('sign-person-add').click()
  await people.getByTestId('sign-person-name').nth(1).fill('Sam Ortiz')
  await people.getByTestId('sign-person-email').nth(1).fill(`sam-${id}@outside.example`)
  await people.getByTestId('sign-person-role').nth(1).selectOption('copy')
  await page.getByTestId('sign-add-signature').click()
  await clickPage(page, 0.3, 0.8)
  await expect(page.locator('[data-field-type="signature"]')).toContainText('Signature')

  await page.getByTestId('sign-send').click()
  await page.getByTestId('sign-send-confirm').click()
  const url = await page.getByTestId('sign-link-url').inputValue()
  expect(url).toMatch(/\/signing\/[0-9A-Z]{26}\.s1\./)
  await page.getByRole('button', { name: 'Done' }).click()
  await expect(page.getByTestId('sign-progress-s1')).toContainText(/Link sent|Waiting/)
  await expect(page.getByTestId('sign-progress-s2')).toContainText('Gets a copy')

  // Maya opens her link in a browser that isn't signed in to anything.
  const outside = await browser.newContext()
  const her = await outside.newPage()
  await her.goto(new URL(url).pathname)
  await expect(her.getByTestId('signing-title')).toHaveText(`terms-${id}`)
  await her.getByTestId('signing-start').click()
  await her.getByTestId('sign-field-f1').click()
  await her.getByTestId('signature-typed').fill('Maya Lin')
  await her.getByTestId('signature-done').click()
  await her.getByTestId('sign-consent').check()
  await her.getByTestId('sign-finish').click()
  await expect(her.getByTestId('signing-completed')).toBeVisible({ timeout: 30_000 })
  await outside.close()

  // The sender sees it finished and sealed.
  await page.reload()
  await expect(page.getByTestId('sign-finished')).toBeVisible()
  await expect(page.getByTestId('sign-audit')).toContainText('Opened')
  await expect(page.getByTestId('sign-audit-check')).toContainText('checks out')
})

test('someone outside the team declines, with a reason the sender sees', async ({
  page,
  member,
  browser,
}) => {
  const id = uid()
  const name = `nda-${id}.pdf`
  await page.goto(`/files?space=${encodeURIComponent(member.personal)}`)
  await page
    .getByTestId('files-input')
    .setInputFiles([{ name, mimeType: 'application/pdf', buffer: pdf(`NDA ${id}`) }])
  await expect(row(page, name)).toBeVisible({ timeout: 15_000 })
  await row(page, name).getByTestId('files-open').click()
  await page.getByTestId('file-send-for-signature').click()
  await expect(page.getByTestId('sign-page-1')).toBeVisible()
  const people = page.getByTestId('sign-people')
  await people.getByTestId('sign-person-name').first().fill('Raj Patel')
  await people.getByTestId('sign-person-email').first().fill(`raj-${id}@outside.example`)
  await page.getByTestId('sign-add-signature').click()
  await clickPage(page, 0.3, 0.8)
  await page.getByTestId('sign-send').click()
  await page.getByTestId('sign-send-confirm').click()
  const url = await page.getByTestId('sign-link-url').inputValue()

  const outside = await browser.newContext()
  const his = await outside.newPage()
  await his.goto(new URL(url).pathname)
  await his.getByTestId('signing-decline').click()
  await his.getByTestId('signing-decline-reason').fill('Wrong company name')
  await his.getByTestId('signing-decline-confirm').click()
  await expect(his.getByTestId('signing-declined')).toBeVisible()
  await outside.close()

  await page.reload()
  await expect(page.getByTestId('sign-declined')).toContainText('Wrong company name')
})
