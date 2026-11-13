import { expect, test, uid } from './fixtures'

// Hearth Tables (ARCHITECTURE §22): a member makes a table, types
// numbers and a formula, sees the total, sorts, reloads and finds it saved; then opens a form's
// answers as a table and copies them.

test('make a table with a formula, sort it, and find it saved after a reload', async ({ page }) => {
  const id = uid()
  const title = `Supplies ${id}`
  await page.goto('/tables')
  await page.getByTestId('new-table-title').fill(title)
  await page.getByTestId('new-table').click()
  await expect(page.getByTestId('table-title')).toHaveValue(title)
  const grid = page.getByTestId('table-grid')
  const cell = (address: string) => page.locator(`[data-cell="${address}"]`)

  // A1 holds "Name"; type the rest by keyboard, like a spreadsheet.
  await cell('A1').click()
  await page.keyboard.type('Item')
  await page.keyboard.press('Tab')
  await page.keyboard.type('Cost')
  await page.keyboard.press('Enter')
  await cell('A2').click()
  for (const [item, cost] of [
    ['Gloves', '12'],
    ['Tips', '30'],
    ['Tape', '3'],
  ] as const) {
    await page.keyboard.type(item)
    await page.keyboard.press('Tab')
    await page.keyboard.type(cost)
    await page.keyboard.press('Enter')
    await page.keyboard.press('ArrowLeft')
  }
  await cell('A5').click()
  await page.keyboard.type('Total')
  await page.keyboard.press('Tab')
  await page.keyboard.type('=SUM(B2:B4)')
  await page.keyboard.press('Enter')
  await expect(cell('B5')).toHaveText('45')
  await cell('B5').click()
  await expect(page.getByTestId('formula-bar')).toHaveValue('=SUM(B2:B4)')

  // Column B is a number column; sorting is on screen only.
  await page.getByTestId('column-B').click()
  await page.getByTestId('column-type').selectOption('number')
  await page.getByTestId('sort-desc').click()
  await expect(grid.getByRole('row').nth(1)).toContainText('Total')
  await expect(grid.getByRole('row').nth(2)).toContainText('Tips')
  await page.getByTestId('clear-view').click()

  await expect(page.getByTestId('save-status')).toHaveText('Saved', { timeout: 10_000 })
  await page.reload()
  await expect(cell('B5')).toHaveText('45')
  await expect(cell('A3')).toHaveText('Tips')
  await expect(page.getByTestId('column-B')).toContainText('Number')

  // Undo puts a cleared cell back.
  await cell('A3').click()
  await page.keyboard.press('Backspace')
  await expect(cell('A3')).toHaveText('')
  await page.keyboard.press('ControlOrMeta+z')
  await expect(cell('A3')).toHaveText('Tips')
})

test("open a form's answers as a table and copy them into a new one", async ({ page }) => {
  const id = uid()
  const title = `Sign-up ${id}`
  await page.goto('/forms')
  await page.getByTestId('new-form-title').fill(title)
  await page.getByTestId('new-form').click()
  await expect(page.getByTestId('form-title')).toHaveValue(title)
  const formUrl = new URL(page.url()).pathname
  const link = await page.getByTestId('form-open-link').getAttribute('href')
  await page.goto(new URL(link ?? '').pathname)
  await page.getByLabel('Your name').fill(`Ada ${id}`)
  await page.getByTestId('form-submit').click()
  await expect(page.getByText('Thanks, your answer was sent.')).toBeVisible()

  await page.goto(`${formUrl}/answers`)
  await page.getByTestId('answers-open-table').click()
  await expect(page.getByTestId('table-grid')).toContainText(`Ada ${id}`)
  await page.getByTestId('copy-to-table').click()
  await expect(page.getByTestId('table-title')).toHaveValue(`${title} answers`)
  await expect(page.getByTestId('table-grid')).toContainText(`Ada ${id}`)
})
