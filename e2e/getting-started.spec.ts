import { signIn } from './fixtures'
import { expect, test } from './meetings-fixtures'

// A new member's first run (docs/PLAN-getting-started.md, J1): Getting started is the first thing
// on Today, Hide removes it for good, and Settings brings it back.

test('J1: Getting started leads Today, hides for good, and comes back from Settings', async ({
  page,
  member,
}) => {
  // As a member who hasn't dealt with it yet, whatever an earlier run saved.
  const reset = await member.request.put('/api/today/layout', {
    data: {
      layout: {
        schema: 1,
        columns: [
          [
            { id: 'start', kind: 'start' },
            { id: 'meetings', kind: 'meetings' },
            { id: 'tasks', kind: 'tasks' },
          ],
          [{ id: 'docs', kind: 'docs' }],
        ],
      },
    },
  })
  expect(reset.status(), await reset.text()).toBe(200)

  await page.goto('/')
  const tile = page.getByTestId('today-start')
  await expect(tile).toBeVisible()
  // First on the page, above the day's tiles.
  await expect(page.getByTestId('today-column-0').locator('section').first()).toHaveAttribute(
    'data-testid',
    'today-start',
  )
  // The fake calendar is connected, so that step arrives ticked; Docs hasn't been opened.
  await expect(tile.locator('[data-step="calendar"]')).toHaveAttribute('data-done', 'true')
  await expect(tile.locator('[data-step="docs"]')).toHaveAttribute('data-done', 'false')

  await page.getByTestId('today-start-hide').click()
  await expect(tile).toHaveCount(0)
  await expect
    .poll(async () => {
      const res = await member.request.get('/api/today/layout')
      const body = (await res.json()) as { layout: { gettingStarted?: string } }
      return body.layout.gettingStarted
    })
    .toBe('dismissed')
  await page.reload()
  await expect(page.getByTestId('today-tasks')).toBeVisible()
  await expect(tile).toHaveCount(0)

  // Settings → Getting started puts it back at the top.
  await page.goto('/settings')
  await page.getByTestId('settings-getting-started').click()
  await expect(page).toHaveURL(/\/today$/)
  await expect(tile).toBeVisible()
  await expect(tile.locator('[data-step="docs"]')).toHaveAttribute('data-done', 'false')

  // Open Docs ticks the last open step that only a click can show.
  const saved = page.waitForResponse(
    (r) => r.url().endsWith('/api/today/layout') && r.request().method() === 'PUT',
  )
  await page.getByTestId('today-start-docs').click()
  await expect(page).toHaveURL(/\/docs/)
  // The step is saved as Docs opens; a reload before that lands would cut it off.
  expect((await saved).status()).toBe(200)
  await page.goto('/today')
  await expect(tile.locator('[data-step="docs"]')).toHaveAttribute('data-done', 'true')

  // Leave Today as other specs expect it.
  await page.getByTestId('today-start-hide').click()
  await expect(tile).toHaveCount(0)
})

test('J2: the doc an admin picks in Settings is what the last step opens', async ({
  page,
  member,
  browser,
  baseURL,
}) => {
  const path = `guides/start-here-${Date.now()}.md`
  const doc = await member.request.put(`/api/spaces/${member.team}/file`, {
    data: { path, content: '# Welcome to the team\n\nRead this first.\n' },
  })
  expect(doc.status(), await doc.text()).toBe(200)
  const link = `/docs/${member.team}/${path}`
  // A member can't pick it.
  const refused = await member.request.put('/api/today/start-here', { data: { link } })
  expect(refused.status()).toBe(403)

  // An admin, in their own browser window: Settings → Workspace → Start-here doc.
  const context = await browser.newContext(baseURL ? { baseURL } : {})
  const adminPage = await context.newPage()
  try {
    await signIn(adminPage, 'e2e-admin@example.test')
    await adminPage.goto('/settings/organization')
    const section = adminPage.getByTestId('org-start-here')
    await adminPage.getByTestId('org-start-here-link').fill(`${baseURL ?? ''}/docs/team/nope.md`)
    await adminPage.getByTestId('org-start-here-save').click()
    await expect(section.getByRole('alert')).toContainText('That isn’t a doc in the Team space')
    await adminPage.getByTestId('org-start-here-link').fill(`${baseURL ?? ''}${link}`)
    await adminPage.getByTestId('org-start-here-save').click()
    await expect(adminPage.getByTestId('org-start-here-now')).toContainText(
      'New teammates start with Welcome to the team.',
    )

    await page.goto('/today')
    const step = page.getByTestId('today-start').locator('[data-step="docs"]')
    await expect(step).toContainText('Start with “Welcome to the team”.')
    await page.getByTestId('today-start-docs').click()
    await expect(page).toHaveURL(new RegExp(`/docs/${member.team}/guides/start-here-`))
    // Docs opens in the editor, with the doc's own text.
    await expect(page.getByText('Read this first.')).toBeVisible()
  } finally {
    // Other specs expect the step to open Docs.
    await adminPage.goto('/settings/organization')
    await adminPage.getByTestId('org-start-here-clear').click()
    await expect(adminPage.getByTestId('org-start-here-now')).toContainText('No doc picked')
    await context.close()
  }
})
