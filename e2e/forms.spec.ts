import { expect, test, uid } from './fixtures'

// Hearth Forms (docs/plans/2026-11-12-forms.md R5–R14): a member builds a public form with a
// condition and a file question in the app; someone signed out answers it; the member reads the
// answer, opens the file, summarizes and downloads CSV.

test('build a public form, answer it signed out with a file, and read the answer', async ({
  page,
  browser,
}) => {
  const id = uid()
  const title = `Kit request ${id}`
  await page.goto('/forms')
  await page.getByTestId('new-form-title').fill(title)
  await page.getByTestId('new-form').click()
  await expect(page.getByTestId('form-title')).toHaveValue(title)

  // The new form starts with "Your name"; add a choice, a question shown only for "Lab", a file.
  await page.getByTestId('add-question-type').selectOption('choice')
  await page.getByTestId('add-question').click()
  const role = page.getByTestId('question-card').nth(1)
  await role.getByTestId('question-label').fill('Where do you work?')
  await role.getByTestId('question-option').nth(0).fill('Lab')
  await role.getByTestId('question-option').nth(1).fill('Office')
  await role.getByTestId('question-required').check()

  await page.getByTestId('add-question-type').selectOption('long')
  await page.getByTestId('add-question').click()
  const why = page.getByTestId('question-card').nth(2)
  await why.getByTestId('question-label').fill('Which experiment is it for?')
  await why.getByTestId('question-show-if').selectOption({ label: 'when “Where do you work?”' })
  await expect(why.getByTestId('question-show-if-option')).toHaveValue('Lab')

  await page.getByTestId('add-question-type').selectOption('file')
  await page.getByTestId('add-question').click()
  await page.getByTestId('question-card').nth(3).getByTestId('question-label').fill('Your protocol')

  await page.getByTestId('add-question-type').selectOption('date')
  await page.getByTestId('add-question').click()
  await page.getByTestId('question-card').nth(4).getByTestId('question-label').fill('Start date')

  await page.getByTestId('form-tab-settings').click()
  await page.getByTestId('form-access-public').check()
  await page.getByTestId('form-save').click()
  await expect(page.getByTestId('form-save')).toHaveText('Saved')
  const link = await page.getByTestId('form-open-link').getAttribute('href')
  expect(link).toMatch(/\/f\/[A-Za-z0-9_-]{24}$/)

  // Signed out, on a phone-sized screen.
  const outside = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const stranger = await outside.newPage()
  await stranger.goto(new URL(link ?? '').pathname)
  await expect(stranger.getByRole('heading', { name: title })).toBeVisible()
  await expect(stranger.getByText('Which experiment is it for?')).toHaveCount(0)
  await stranger.getByTestId('form-submit').click()
  await expect(stranger.getByTestId('form-field-error')).toHaveCount(2)
  await stranger.getByLabel('Your name').fill(`Ada ${id}`)
  await stranger.getByLabel('Lab').check()
  await stranger.getByLabel('Which experiment is it for?').fill('Plaque assay')
  await stranger.getByTestId('form-file-input').setInputFiles({
    name: 'protocol.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Step 1: wear goggles'),
  })
  await expect(stranger.getByText('protocol.txt')).toBeVisible()
  // The date question uses Hotsauce's picker: Monday first, Sunday last (PLAN-monday-weeks W4).
  await stranger.getByLabel('Start date').click()
  const picker = stranger.getByTestId('date-picker')
  await expect(picker.getByRole('columnheader').first()).toHaveAttribute('abbr', 'Mon')
  await expect(picker.getByRole('columnheader').last()).toHaveAttribute('abbr', 'Sun')
  await picker.getByTestId('date-picker-today').click()
  const started = await stranger.evaluate(() => new Date().toLocaleDateString('en-CA'))
  await expect(stranger.getByLabel('Start date')).toHaveAttribute('data-value', started)
  const width = await stranger.evaluate(() => document.documentElement.scrollWidth)
  expect(width).toBeLessThanOrEqual(390)
  await stranger.getByTestId('form-submit').click()
  await expect(stranger.getByTestId('form-sent')).toBeVisible()
  await outside.close()

  // Back in the app: the answer, its file, the summary and the CSV.
  await page.getByTestId('form-tab-answers').click()
  await expect(page.getByTestId('answers-count')).toHaveText('1 answer')
  await expect(page.getByTestId('answer-row')).toContainText(`Ada ${id}`)
  await expect(page.getByTestId('answer-row')).toContainText('Someone outside')
  await page.getByTestId('answer-row').click()
  const dialog = page.getByTestId('answer-dialog')
  await expect(dialog).toContainText('Plaque assay')
  await expect(dialog).toContainText('Start date')
  await expect(dialog.getByTestId('answer-file')).toHaveText('protocol.txt')
  await page.keyboard.press('Escape')

  await page.getByTestId('answers-summarize').click()
  await expect(page.getByTestId('answers-summary')).toContainText('Where do you work?')
  const download = page.waitForEvent('download')
  await page.getByTestId('answers-csv').click()
  expect((await download).suggestedFilename()).toBe(`${title}.csv`)

  await page.goto('/forms')
  await expect(page.getByTestId('forms-list')).toContainText(title)
})

test('a team form asks people who are signed out to sign in', async ({ page, browser }) => {
  await page.goto('/forms')
  await page.getByTestId('new-form-title').fill(`Team only ${uid()}`)
  await page.getByTestId('new-form').click()
  const link = await page.getByTestId('form-open-link').getAttribute('href')
  const outside = await browser.newContext()
  const stranger = await outside.newPage()
  await stranger.goto(new URL(link ?? '').pathname)
  await expect(stranger.getByText('Sign in to answer')).toBeVisible()
  await outside.close()

  // A teammate answers it.
  const other = await page.context().browser()?.newContext()
  if (!other) throw new Error('no browser')
  const mate = await other.newPage()
  await mate.goto('/sign-in')
  await mate.getByTestId('dev-signin-email').fill(`e2e-mate-${uid()}@example.test`)
  await mate.getByTestId('dev-signin-submit').click()
  await mate.waitForURL((url) => !url.pathname.startsWith('/sign-in'))
  await mate.goto(new URL(link ?? '').pathname)
  await mate.getByLabel('Your name').fill('Bea')
  await mate.getByTestId('form-submit').click()
  await expect(mate.getByTestId('form-sent')).toBeVisible()
  await other.close()
})
