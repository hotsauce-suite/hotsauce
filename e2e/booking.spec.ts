import { uid } from './fixtures'
import { expect, test } from './meetings-fixtures'

// Booking links (ARCHITECTURE §19, plan S9): make a 30-minute link in Meetings, open it signed
// out, pick a time, book, and the event is on the member's (in-memory) Google Calendar with a
// Meet link, and the time is gone from the page.

test('S9: make a link, book it signed out, the event exists and the time is gone', async ({
  page,
  member,
  browser,
}) => {
  const id = uid()
  const title = `Intro ${id}`
  await page.goto('/meetings/booking')
  await page.getByTestId('booking-new').click()
  await page.getByTestId('booking-title').fill(title)
  await page.getByTestId('booking-minutes').selectOption('30')
  // Every day, no minimum notice, so there are times to pick whenever this runs.
  await page.getByTestId('booking-day-sat').check()
  await page.getByTestId('booking-day-sun').check()
  await page.getByTestId('booking-notice').selectOption('0')
  await page.getByTestId('booking-add-question').click()
  await page.getByTestId('booking-question').fill('What should we cover?')
  await page.getByTestId('booking-save').click()
  const card = page.getByTestId('booking-link').filter({ hasText: title })
  await expect(card).toBeVisible()
  const url = (await card.getByTestId('booking-url').textContent())?.trim() ?? ''
  expect(url).toMatch(new RegExp(`/book/${member.personal}/intro-${id.toLowerCase()}$`))

  // Signed out: a fresh browser with no session.
  const guest = await browser.newContext()
  const booker = await guest.newPage()
  await booker.goto(url)
  await expect(booker.getByTestId('book-title')).toHaveText(title)
  let time = booker.getByTestId('book-time').first()
  if (!(await time.isVisible().catch(() => false))) {
    // Late in the day there may be nothing left today's week view shows; try next week.
    await booker.getByTestId('book-next-week').click()
    time = booker.getByTestId('book-time').first()
  }
  await expect(time).toBeVisible()
  const start = (await time.getAttribute('data-start')) ?? ''
  await time.click()
  await booker.getByTestId('book-name').fill('Jo Park')
  await booker.getByTestId('book-email').fill('jo@bolt.example')
  await booker.getByTestId('book-answer').fill(`Pricing ${id}`)
  await booker.getByTestId('book-submit').click()
  await expect(booker.getByTestId('book-done')).toContainText('You’re booked')

  // The event is on the member's calendar, with the booker and their answer.
  const sync = await member.request.post('/api/test/calendar/sync')
  expect(sync.status()).toBe(200)
  const from = new Date(Date.parse(start) - 60_000).toISOString()
  const to = new Date(Date.parse(start) + 60 * 60_000).toISOString()
  const res = await member.request.get(
    `/api/calendar/upcoming?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
  )
  const events = (await res.json()) as Array<{
    title: string
    start: string
    description?: string
    meetLink?: string
    attendees: Array<{ email: string }>
  }>
  const event = events.find((e) => e.title === `${title}: Jo Park`)
  expect(event, JSON.stringify(events)).toBeTruthy()
  expect(event?.start).toBe(start)
  expect(event?.meetLink).toMatch(/^https:\/\/meet\.google\.com\//)
  expect(event?.description).toContain(`Pricing ${id}`)
  expect(event?.attendees.map((a) => a.email)).toContain('jo@bolt.example')

  // Back on the page, that time is gone.
  await booker.goto(url)
  await expect(booker.getByTestId('book-title')).toHaveText(title)
  await expect(booker.locator(`[data-testid="book-time"][data-start="${start}"]`)).toHaveCount(0)
  await guest.close()
})
