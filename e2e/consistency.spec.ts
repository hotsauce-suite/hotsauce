import type { Page, Route } from '@playwright/test'
import { expect, test } from './fixtures'

// docs/PLAN-consistency.md, requirements 1–5: every app's list says the same thing when it
// can't load ("Couldn't load … Try again", which loads it without reloading the page) and shows
// the same kind of empty screen, never the empty one while the list has in fact failed.

interface AppList {
  /** The app as its page title names it. */
  name: string
  /** Where its list lives. */
  url: string
  /** The request that fills the list: the path of a GET under `/api`. */
  api: string | RegExp
  /** The words after "Couldn't load". */
  says: string
  /** The same answer with nothing in the list; null where a list can't be empty. */
  empty: ((body: unknown) => unknown) | null
}

const none =
  (...keys: string[]) =>
  (body: unknown) => ({
    ...(body as object),
    ...Object.fromEntries(keys.map((k) => [k, []])),
  })

const APPS: AppList[] = [
  { name: 'Today', url: '/today', api: '/api/today', says: 'your day', empty: null },
  {
    name: 'Meetings',
    url: '/meetings',
    api: '/api/meetings',
    says: 'your meetings',
    empty: () => [],
  },
  {
    name: 'Voice notes',
    url: '/dictate/voice',
    api: '/api/meetings',
    says: 'your voice notes',
    empty: () => [],
  },
  { name: 'Clips', url: '/clips', api: '/api/clips', says: 'your clips', empty: none('clips') },
  { name: 'Tasks', url: '/tasks/all', api: '/api/tasks', says: 'your tasks', empty: none('tasks') },
  { name: 'Notes', url: '/notes', api: '/api/notes', says: 'your notes', empty: none('notes') },
  {
    name: 'Boards',
    url: '/boards',
    api: '/api/boards',
    says: 'your boards',
    empty: none('boards'),
  },
  { name: 'People', url: '/people', api: '/api/people', says: 'the people', empty: none('people') },
  {
    name: 'Files',
    url: '/files',
    api: '/api/files',
    says: 'the team files',
    empty: none('files', 'folders'),
  },
  { name: 'Links', url: '/links', api: '/api/links', says: 'your links', empty: none('links') },
  { name: 'Forms', url: '/forms', api: '/api/forms', says: 'your forms', empty: none('forms') },
  {
    name: 'Check-ins',
    url: '/checkins',
    api: '/api/checkins',
    says: 'the check-ins',
    empty: none('checkins'),
  },
  {
    name: 'Tables',
    url: '/tables',
    api: '/api/tables',
    says: 'your tables',
    empty: none('tables'),
  },
  { name: 'Pages', url: '/pages', api: '/api/pages', says: 'the pages', empty: none('pages') },
  {
    name: 'Briefcast',
    url: '/briefcast',
    api: '/api/briefcast',
    says: 'your briefcast',
    empty: null,
  },
  {
    name: 'Docs',
    url: '/docs',
    api: /^\/api\/spaces\/[^/]+\/tree$/,
    says: 'your docs',
    empty: null,
  },
]

/** Answers the app's list request with `answer` until the returned switch is turned off. */
async function intercept(page: Page, app: AppList, answer: (route: Route) => Promise<void>) {
  const state = { on: true }
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const hit = typeof app.api === 'string' ? path === app.api : app.api.test(path)
    if (!state.on || !hit || request.method() !== 'GET') return route.fallback()
    await answer(route)
  })
  return state
}

for (const app of APPS) {
  test(`${app.name}: a list that fails says so, and Try again loads it`, async ({ page }) => {
    const failing = await intercept(page, app, (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'internal', message: 'SQLITE_BUSY: database is locked' },
        }),
      }),
    )
    await page.goto(app.url)
    const block = page.getByTestId('load-error').first()
    await expect(block).toContainText(`Couldn’t load ${app.says}.`)
    // The server's own sentence helps no one, and "nothing here yet" would be untrue.
    await expect(page.getByText('SQLITE_BUSY')).toHaveCount(0)
    await expect(page.locator('[data-empty-state]')).toHaveCount(0)

    failing.on = false
    let reloaded = false
    page.on('load', () => {
      reloaded = true
    })
    const answered = page.waitForResponse((response) => {
      const path = new URL(response.url()).pathname
      const hit = typeof app.api === 'string' ? path === app.api : app.api.test(path)
      return hit && response.request().method() === 'GET' && response.ok()
    })
    await block.getByRole('button', { name: 'Try again' }).click()
    await answered
    await expect(page.getByTestId('load-error')).toHaveCount(0)
    expect(reloaded).toBe(false)
  })

  const { empty } = app
  if (!empty) continue
  test(`${app.name}: an empty list shows the empty screen`, async ({ page }) => {
    await intercept(page, app, async (route) => {
      const response = await route.fetch()
      await route.fulfill({ response, json: empty(await response.json()) })
    })
    await page.goto(app.url)
    const screen = page.locator('[data-empty-state]').first()
    await expect(screen).toBeVisible()
    await expect(screen.locator('svg').first()).toBeVisible()
    await expect(page.getByTestId('load-error')).toHaveCount(0)
  })
}
