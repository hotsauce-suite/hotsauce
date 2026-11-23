import { readFile } from 'node:fs/promises'
import { docUrl, expect, test, uid } from './fixtures'

// Presenting a Doc as slides (docs/PLAN-slides.md R1–R10).

const deck = (id: string) =>
  `---\nnote: hidden-${id}\n---\n# Deck ${id}\n\nOpening line\n\n---\n\n## Second ${id}\n\n- a point\n\nNotes: speaker-only-${id}\n\n---\n\n## Third ${id}\n`

test('Present shows the doc as slides, keys move through them, Esc ends the show', async ({
  page,
  api,
  user,
}) => {
  const id = uid()
  const file = `docs/e2e-slides-${id}.md`
  await api.writeFile(user.team, file, deck(id))
  await page.goto(docUrl(user.team, file))
  await expect(page.getByTestId('editor-content')).toContainText('Opening')

  await page.getByTestId('present').click()
  const show = page.getByTestId('slide-show')
  await expect(show).toHaveAttribute('data-mode', 'slides')
  const slide = page.getByTestId('slide')
  await expect(slide).toContainText(`Deck ${id}`)
  await expect(show).not.toContainText(`hidden-${id}`)

  await page.keyboard.press('ArrowRight')
  await expect(slide).toContainText(`Second ${id}`)
  // The audience never sees the notes (R3).
  await expect(show).not.toContainText(`speaker-only-${id}`)
  await page.keyboard.press('3')
  await page.keyboard.press('Enter')
  await expect(slide).toContainText(`Third ${id}`)
  await page.keyboard.press('Home')
  await expect(slide).toContainText(`Deck ${id}`)

  // B blacks out; any key brings the slide back without moving (R8).
  await page.keyboard.press('b')
  await expect(page.getByTestId('slides-black')).toBeVisible()
  await page.keyboard.press('ArrowRight')
  await expect(page.getByTestId('slides-black')).toHaveCount(0)
  await expect(slide).toContainText(`Deck ${id}`)

  // The laser follows the pointer (R7).
  await page.keyboard.press('l')
  const box = await slide.boundingBox()
  if (!box) throw new Error('no slide')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await expect(page.getByTestId('slide-laser')).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(show).toHaveCount(0)
  await expect(page.getByTestId('editor-content')).toContainText('Opening')
})

test('presenter view shows the notes and next slide and drives the slides window', async ({
  page,
  api,
  user,
}) => {
  const id = uid()
  const file = `docs/e2e-presenter-${id}.md`
  await api.writeFile(user.team, file, deck(id))
  await page.goto(docUrl(user.team, file))
  await expect(page.getByTestId('editor-content')).toContainText('Opening')

  const popup = page.waitForEvent('popup')
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByTestId('cmdk-input').fill('presenter view')
  await page.getByTestId('cmdk-command-doc-presenter-view').click()
  const audience = await popup

  const view = page.getByTestId('presenter-view')
  await expect(view).toBeVisible()
  await expect(page.getByTestId('presenter-count')).toHaveText('Slide 1 of 3')
  await expect(audience.getByTestId('audience-slide')).toContainText(`Deck ${id}`)

  await page.keyboard.press('ArrowRight')
  await expect(page.getByTestId('slide-notes')).toContainText(`speaker-only-${id}`)
  await expect(audience.getByTestId('audience-slide')).toContainText(`Second ${id}`)
  await expect(audience.getByTestId('audience-slide')).not.toContainText(`speaker-only-${id}`)
  await expect(page.getByTestId('presenter-timer')).toHaveText(/^\d+:\d\d$/)

  // Keys in the slides window drive the show too.
  await audience.keyboard.press('ArrowRight')
  await expect(page.getByTestId('presenter-count')).toHaveText('Slide 3 of 3')

  // The laser over the presenter's slide shows on the audience's.
  await page.getByTestId('presenter-laser').click()
  const box = await page.getByTestId('presenter-slide').boundingBox()
  if (!box) throw new Error('no slide')
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.5)
  await expect(audience.getByTestId('slide-laser')).toBeVisible()

  await page.getByTestId('end-show').click()
  await expect(page.getByTestId('slide-show')).toHaveCount(0)
  await expect.poll(() => audience.isClosed()).toBe(true)
})

test('Draft slides makes a new deck doc beside the doc, and the slides PDF downloads', async ({
  page,
  api,
  user,
}) => {
  const id = uid()
  const file = `docs/e2e-draft-${id}.md`
  await api.writeFile(
    user.team,
    file,
    `# Plan ${id}\n\n## Goals\n\nShip it.\n\n## Risks\n\nTime.\n`,
  )
  await page.goto(docUrl(user.team, file))
  await expect(page.getByTestId('editor-content')).toContainText('Ship')

  await page.keyboard.press('ControlOrMeta+k')
  await page.getByTestId('cmdk-input').fill('draft slides')
  await page.getByTestId('cmdk-command-doc-draft-slides').click()
  await expect(page).toHaveURL(new RegExp(`plan-${id}-slides`, 'i'))
  await expect(page.getByTestId('editor-content')).toContainText('The key point about Goals')
  await expect(page.getByTestId('editor-content')).toContainText('Notes:')
  const deckPath = decodeURIComponent(new URL(page.url()).pathname).split(`/${user.team}/`)[1] ?? ''
  const saved = (await api.readFile(user.team, deckPath))?.content ?? ''
  expect(saved).toMatch(/^---\nid: /)
  expect(saved).toContain('title: Plan')
  expect(saved).toContain('\n---\n\n## Goals')
  // The original is untouched.
  expect((await api.readFile(user.team, file))?.content).not.toContain('Notes:')

  const download = page.waitForEvent('download')
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByTestId('cmdk-input').fill('download slides')
  await page.getByTestId('cmdk-command-doc-download-slides').click()
  const pdf = await download
  expect(pdf.suggestedFilename()).toBe(`Plan ${id} slides.pdf`)
  const bytes = await readFile((await pdf.path()) ?? '')
  expect(bytes.subarray(0, 5).toString()).toBe('%PDF-')
})
