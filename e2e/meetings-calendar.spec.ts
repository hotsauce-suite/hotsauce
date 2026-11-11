import { uid } from './fixtures'
import { expect, type Member, test } from './meetings-fixtures'

// ARCHITECTURE §7.8: the Google Calendar sync, against the in-memory Google the e2e server runs
// with dev auth. `/api/test/*` hooks change that Google and run a sync or a reminder pass.

async function hook(member: Member, path: string, data: unknown = {}) {
  const res = await member.request.post(`/api/test/${path}`, { data })
  expect(res.ok(), `${path}: ${await res.text()}`).toBe(true)
}

test('home shows synced events and follows a move and a cancellation', async ({ page, member }) => {
  await page.goto('/meetings')
  const acme = page.getByTestId('calendar-event').filter({ hasText: 'Acme sync' })
  await expect(acme).toHaveAttribute('data-event-id', 'fake-acme-sync')
  await expect(page.getByTestId('calendar-event').filter({ hasText: 'Design review' })).toHaveCount(
    1,
  )
  const before = await acme.textContent()

  await hook(member, 'calendar/move', { id: 'fake-acme-sync', minutes: 60 })
  await hook(member, 'calendar/cancel', { id: 'fake-design-review' })
  await hook(member, 'calendar/sync')
  await page.reload()
  await expect(page.getByTestId('calendar-event').filter({ hasText: 'Acme sync' })).toHaveCount(1)
  await expect(page.getByTestId('calendar-event').filter({ hasText: 'Acme sync' })).not.toHaveText(
    before ?? '',
  )
  await expect(page.getByTestId('calendar-event').filter({ hasText: 'Design review' })).toHaveCount(
    0,
  )
})

test('recent meetings show which have notes, linking to the note', async ({ page, member }) => {
  const path = `meetings/2026/11/pipeline-${uid()}.md`
  await member.api.writeFile(
    member.personal,
    path,
    '---\ntype: meeting\ntitle: Pipeline review\ndate: 2026-11-09T15:00:00Z\ncalendar_event_id: fake-pipeline_w2\n---\n# Pipeline review\n\nNumbers are up.\n',
  )
  await page.goto('/meetings')
  const coverage = page.getByTestId('coverage')
  const withNotes = coverage.locator(
    '[data-testid="coverage-item"][data-event-id="fake-pipeline_w2"]',
  )
  await expect(withNotes).toHaveAttribute('data-has-notes', 'true')
  await expect(
    coverage.locator('[data-testid="coverage-item"][data-event-id="fake-bolt-intro"]'),
  ).toHaveAttribute('data-has-notes', 'false')
  await expect(
    coverage.locator('[data-testid="coverage-item"][data-event-id="fake-pipeline_w1"]'),
  ).toHaveAttribute('data-has-notes', 'false')
  // Declined: not a meeting the member had.
  await expect(coverage.locator('[data-event-id="fake-offsite"]')).toHaveCount(0)

  await withNotes.getByTestId('coverage-note-link').click()
  await expect(page).toHaveURL(new RegExp(`/meetings/${member.personal}/${path}$`))
  await expect(page.getByText('Numbers are up.')).toBeVisible()
})

test('a reminder goes out for a synced meeting, not a cancelled one, and opens Start', async ({
  page,
  member,
}) => {
  const id = uid()
  await page.goto('/meetings')
  const endpoint = `https://fcm.googleapis.com/fcm/send/e2e-${id}`
  const subscribed = await page.request.post('/api/meetings/reminders', {
    headers: { 'x-hearth-dev-user': member.email },
    data: { subscription: { endpoint, keys: { p256dh: 'p', auth: 'a' } } },
  })
  expect(subscribed.status()).toBe(204)

  await hook(member, 'calendar/add', {
    id: `kept-${id}`,
    title: `Bolt follow-up ${id}`,
    startsInSeconds: 60,
  })
  await hook(member, 'calendar/add', {
    id: `gone-${id}`,
    title: `Cancelled ${id}`,
    startsInSeconds: 70,
  })
  await hook(member, 'calendar/cancel', { id: `gone-${id}` })
  await hook(member, 'calendar/sync')
  await hook(member, 'reminders/tick')

  const pushes = (await (await member.request.get('/api/test/pushes')).json()) as Array<{
    endpoint: string
    payload: { title: string; url: string }
  }>
  const mine = pushes.filter((p) => p.endpoint === endpoint)
  const titles = mine.map((p) => p.payload.title)
  // Acme sync (seeded a minute or two out) may be due too; it isn't what this checks.
  expect(titles).toContain(`Take notes for “Bolt follow-up ${id}”?`)
  expect(titles.some((t) => t.includes(`Cancelled ${id}`))).toBe(false)
  const kept = mine.find((p) => p.payload.title.includes(`Bolt follow-up ${id}`))

  await page.goto(kept?.payload.url ?? '')
  await expect(page.getByTestId('start-title')).toHaveValue(`Bolt follow-up ${id}`)
})

test('Start from a Meet tab matches the call, else the meeting on now', async ({
  page,
  member,
}) => {
  await page.goto('/meetings/start?meet=abc-defg-hij')
  await expect(page.getByTestId('start-title')).toHaveValue('Acme sync')
  await expect(page.getByText('Dana Lee')).toBeVisible()

  const id = uid()
  await hook(member, 'calendar/add', {
    id: `now-${id}`,
    title: `Walk-in ${id}`,
    startsInSeconds: -300,
  })
  await hook(member, 'calendar/sync')
  await page.goto('/meetings/start?meet=qqq-qqqq-qqq')
  await expect(page.getByTestId('start-title')).toHaveValue(`Walk-in ${id}`)
  await expect(page.getByText('Jo Park')).toBeVisible()
})

test('Settings adds a second calendar, whose meetings then show', async ({ page, member }) => {
  await page.goto('/settings')
  const primary = page.locator(
    `[data-testid="calendar-choice"][data-calendar-id="${member.email}"]`,
  )
  await expect(primary.getByRole('checkbox')).toBeChecked()
  await expect(primary.getByRole('checkbox')).toBeDisabled()
  const team = page.locator('[data-testid="calendar-choice"][data-calendar-id="team@fake"]')
  await team.getByRole('checkbox').click()
  await expect(team.getByRole('checkbox')).toBeChecked()

  await page.goto('/meetings')
  await expect(
    page.getByTestId('coverage').locator('[data-event-id="fake-team-standup"]'),
  ).toHaveCount(1)
})
