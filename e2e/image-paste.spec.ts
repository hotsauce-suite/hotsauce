import path from 'node:path'
import { docUrl, expect, test, uid, waitForSave } from './fixtures'

// A 1x1 PNG.
const PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

test('a pasted image is uploaded to assets/ and shows inline', async ({
  page,
  api,
  user,
  waitForState,
}) => {
  const id = uid()
  const file = `docs/e2e-paste-${id}.md`
  await api.writeFile(user.team, file, `# Paste ${id}\n\nThe image goes below.\n`)

  await page.goto(docUrl(user.team, file))
  const editor = page.getByTestId('editor-content')
  await expect(editor).toContainText('The image goes below.')
  await editor.click()
  await page.keyboard.press('ControlOrMeta+End')

  const upload = page.waitForResponse(
    (r) =>
      r.request().method() === 'POST' &&
      new URL(r.url()).pathname === `/api/spaces/${encodeURIComponent(user.team)}/assets`,
  )
  const saved = waitForSave(page, '.png', 5_000)
  // Playwright can't write images to the OS clipboard, so dispatch the paste event directly.
  await editor.evaluate((el, base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
    const clipboardData = new DataTransfer()
    clipboardData.items.add(new File([bytes], 'pixel.png', { type: 'image/png' }))
    el.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }),
    )
  }, PIXEL_PNG)

  const uploaded = await upload
  expect(uploaded.ok()).toBe(true)
  const { path: asset } = (await uploaded.json()) as { path: string }
  expect(asset).toMatch(/^assets\/\d{4}\/\d{2}\/.+\.png$/)

  // The inline image widget actually loads the file. By role, because CodeMirror puts hidden
  // `img.cm-widgetBuffer` elements around every inline widget.
  const image = page.getByTestId('editor').getByRole('img')
  await expect(image).toBeVisible()
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1)

  // The link is committed with the doc on idle.
  expect((await saved).ok()).toBe(true)
  await waitForState('save-state', 'committed', { timeout: 3_000 })
  expect((await api.readFile(user.team, file))?.content).toContain(path.posix.basename(asset))
})
