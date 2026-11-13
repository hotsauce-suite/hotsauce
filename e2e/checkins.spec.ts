import { expect, signIn, test, uid } from './fixtures'

// Check-ins (docs/PLAN-checkins.md R1, R5, R6, R8, R14): an admin sets one up in the app; when its
// time comes the question is on Today; they answer it, and a reply lands under the answer.

const ADMIN = 'e2e-admin@example.test'

test.describe('as an admin', () => {
  test.use({ signedIn: false })

  test('set up a check-in, see it on Today, answer it and reply', async ({ page }) => {
    test.setTimeout(240_000)
    const question = `What’s your focus? ${uid()}`
    await signIn(page, ADMIN)
    await page.goto('/checkins')
    await page.getByTestId('new-checkin').click()
    const dialog = page.getByTestId('checkin-dialog')
    await dialog.getByTestId('checkin-question').fill(question)
    // Every day, two minutes from now in this browser's zone, so the first round opens shortly.
    for (const d of ['tue', 'wed', 'thu', 'fri', 'sat', 'sun']) {
      await dialog.getByTestId(`checkin-day-${d}`).click()
    }
    const soon = await page.evaluate(() => {
      const t = new Date(Date.now() + 120_000)
      return `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`
    })
    await dialog.getByTestId('checkin-time').fill(soon)
    await dialog.getByTestId('checkin-save').click()
    await expect(page.getByTestId('checkin-title')).toHaveText(question)
    const at = page.url()

    // When the minute comes, Today asks.
    await expect(async () => {
      await page.goto('/today')
      await expect(page.getByTestId('today-checkin').filter({ hasText: question })).toBeVisible({
        timeout: 2_000,
      })
    }).toPass({ timeout: 180_000, intervals: [5_000] })
    await page.getByTestId('today-checkin').filter({ hasText: question }).click()
    await expect(page).toHaveURL(at)

    await page.getByTestId('checkin-answer').fill('Finishing the freezer inventory')
    await page.getByTestId('checkin-submit').click()
    await expect(page.getByTestId('checkin-edit-answer')).toBeVisible()
    const card = page.getByTestId('checkin-answer-card')
    await expect(card.getByTestId('checkin-answer-text')).toHaveText(
      'Finishing the freezer inventory',
    )
    await card.getByTestId('checkin-reply-open').click()
    await card.getByTestId('checkin-reply-input').fill('Ping me if you need a hand')
    await card.getByTestId('checkin-reply-send').click()
    await expect(card.getByTestId('checkin-reply')).toContainText('Ping me if you need a hand')

    // Answered, so Today no longer asks; the answer survives a reload.
    await page.goto('/today')
    await expect(page.getByTestId('today')).toBeVisible()
    await expect(page.getByTestId('today-checkin').filter({ hasText: question })).toHaveCount(0)
    await page.goto(at)
    await expect(page.getByTestId('checkin-answer-text')).toHaveText(
      'Finishing the freezer inventory',
    )
  })
})
