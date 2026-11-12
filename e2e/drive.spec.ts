import path from 'node:path'
import type { Page } from '@playwright/test'
import { docUrl, signIn, uid } from './fixtures'
import { expect, test } from './meetings-fixtures'

// Hearth Files (ARCHITECTURE §18), against the built server with the local store. The team
// space is shared by every worker, so file names carry a unique id.

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR42mP8z8DwnwEJMDGgAWwCAJw9AgM4cQdZAAAAAElFTkSuQmCC',
  'base64',
)

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

async function uploadInPage(
  page: Page,
  files: Array<{ name: string; mimeType: string; buffer: Buffer }>,
) {
  await page.getByTestId('files-input').setInputFiles(files)
  for (const f of files) await expect(row(page, f.name)).toBeVisible({ timeout: 15_000 })
}

test('upload, preview, organize, search and share files', async ({ page, member, browser }) => {
  const id = uid()
  await page.goto(`/files?space=${encodeURIComponent(member.personal)}`)
  await expect(page.getByTestId('app-switch-files')).toHaveAttribute('aria-current', 'page')
  await uploadInPage(page, [
    { name: `pixel-${id}.png`, mimeType: 'image/png', buffer: PNG },
    { name: `nda-${id}.pdf`, mimeType: 'application/pdf', buffer: pdf(`Wombat clause ${id}`) },
  ])
  await page
    .getByTestId('files-input')
    .setInputFiles(path.join(import.meta.dirname, 'files', 'quarterly-plan.docx'))
  await expect(row(page, 'quarterly-plan.docx')).toBeVisible({ timeout: 15_000 })

  // An image shows inline, loaded from its signed URL.
  await row(page, `pixel-${id}.png`).getByTestId('files-open').click()
  const img = page.getByTestId('file-preview-image')
  await expect(img).toBeVisible()
  await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(2)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('file-dialog')).toHaveCount(0)

  // A PDF opens in a frame, served as a PDF.
  await row(page, `nda-${id}.pdf`).getByTestId('files-open').click()
  const frame = page.getByTestId('file-preview-pdf')
  await expect(frame).toBeVisible()
  const src = await frame.getAttribute('src')
  const res = await page.request.get(src ?? '')
  expect(res.headers()['content-type']).toBe('application/pdf')
  await page.keyboard.press('Escape')

  // Its text is searchable.
  await page.getByTestId('files-search').fill(`wombat`)
  await expect(row(page, `nda-${id}.pdf`)).toBeVisible()
  await expect(page.getByTestId('files-row')).toHaveCount(1)
  await page.getByTestId('files-search').fill('')

  // A folder, and a file moved into it.
  await page.getByTestId('files-new-folder').click()
  await page.getByTestId('files-name-input').fill(`Legal ${id}`)
  await page.getByTestId('files-name-submit').click()
  await expect(page).toHaveURL(/folder=Legal/)
  await page
    .getByRole('button', { name: member.personal === 'team' ? 'Team files' : 'My files' })
    .first()
    .click()
  await row(page, `nda-${id}.pdf`).getByTestId('files-row-menu').click()
  await page.getByRole('menuitem', { name: 'Move to folder' }).click()
  await page.getByTestId('files-name-input').fill(`Legal ${id}`)
  await page.getByTestId('files-name-submit').click()
  await expect(row(page, `nda-${id}.pdf`)).toHaveCount(0)
  await page
    .getByTestId('files-folder')
    .filter({ hasText: `Legal ${id}` })
    .click()
  await expect(row(page, `nda-${id}.pdf`)).toBeVisible()

  // A share link opens this personal file for a teammate, and only while it's on.
  await row(page, `nda-${id}.pdf`).getByTestId('files-open').click()
  await page.getByTestId('file-share').click()
  await expect(page.getByTestId('file-unshare')).toBeVisible()
  const listed = await member.request.get('/api/files', {
    params: { space: member.personal, folder: `Legal ${id}` },
  })
  const shareUrl = ((await listed.json()) as { files: Array<{ shareUrl: string }> }).files[0]
    ?.shareUrl
  expect(shareUrl).toMatch(/^\/files\/s\//)

  const other = await browser.newContext()
  const otherPage = await other.newPage()
  await signIn(otherPage, `peer-${uid()}@example.test`)
  await otherPage.goto(shareUrl ?? '')
  await expect(otherPage.getByTestId('file-preview-pdf')).toBeVisible()
  await expect(otherPage.getByTestId('shared-download')).toBeVisible()

  await page.getByTestId('file-unshare').click()
  await expect(page.getByTestId('file-unshare')).toHaveCount(0)
  await otherPage.reload()
  await expect(otherPage.getByRole('alert')).toContainText('turned off')
  await other.close()
})

test('attach a file to a doc, a note and a task', async ({ page, member }) => {
  const id = uid()
  const name = `brief-${id}.pdf`
  const doc = `docs/attach-${id}.md`
  await member.api.writeFile(member.team, doc, `# Attach ${id}\n\nSee below.\n`)

  // From the doc, with a new upload through the picker.
  await page.goto(docUrl(member.team, doc))
  await expect(page.getByTestId('editor-content')).toContainText('See below.')
  await page.getByTestId('editor-content').click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.getByTestId('attach-file').click()
  await page
    .getByTestId('file-picker-input')
    .setInputFiles({ name, mimeType: 'application/pdf', buffer: pdf(`Brief ${id}`) })
  await expect(page.getByTestId('file-picker')).toHaveCount(0, { timeout: 15_000 })
  await expect(page.getByTestId('editor-content')).toContainText(name)
  await expect
    .poll(async () => (await member.api.readFile(member.team, doc))?.content ?? '', {
      timeout: 10_000,
    })
    .toMatch(new RegExp(`\\[${name.replace('.', '\\.')}\\]\\(/files/team/[0-9A-Z]{26}\\)`))

  // From a note, picking the same file.
  await page.goto('/notes')
  await page.getByTestId('notes-take-note').click()
  await page.getByTestId('composer-title').fill(`Note ${id}`)
  await page.getByTestId('composer-close').click()
  await page
    .getByTestId('note-card')
    .filter({ hasText: `Note ${id}` })
    .click()
  await page.getByTestId('note-editor-attach').click()
  // A personal note opens the picker on My files; the brief is in Team files.
  await page.getByTestId('file-picker').getByRole('tab', { name: 'Team files' }).click()
  await page.getByTestId('file-picker-search').fill(id)
  await page.getByTestId('file-picker-item').filter({ hasText: name }).click()
  await expect(page.getByTestId('note-editor').getByTestId('attachment-chips')).toContainText(name)
  await page.getByTestId('note-editor-close').click()
  const chip = page
    .getByTestId('note-card')
    .filter({ hasText: `Note ${id}` })
    .getByRole('link', { name })
  await expect(chip).toBeVisible()
  await chip.click()
  await expect(page).toHaveURL(/\/files\/team\/[0-9A-Z]{26}$/)
  await expect(page.getByTestId('file-dialog')).toBeVisible()

  // From a task.
  const created = await member.request.post('/api/tasks', { data: { title: `Task ${id}` } })
  expect(created.ok(), await created.text()).toBe(true)
  const task = (await created.json()) as { space: string; id: string }
  await page.goto(`/tasks/item/${encodeURIComponent(task.space)}/${task.id}`)
  await page.getByTestId('detail-attach').click()
  await page.getByTestId('file-picker').getByRole('tab', { name: 'Team files' }).click()
  await page.getByTestId('file-picker-search').fill(id)
  await page.getByTestId('file-picker-item').filter({ hasText: name }).click()
  await expect(page.getByTestId('attachment-chips')).toContainText(name)
  await expect
    .poll(async () => {
      const r = await member.request.get(`/api/tasks/${encodeURIComponent(task.space)}/${task.id}`)
      return ((await r.json()) as { notes: string }).notes
    })
    .toContain(name)
})
