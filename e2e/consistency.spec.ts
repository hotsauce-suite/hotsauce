import type { Page, Route } from '@playwright/test'
import { expect, newForm, replaceLine, signIn, test, uid } from './fixtures'

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

// Requirement 8: the app's one red button is the last control at the top right of its page, on a
// computer and on a phone, and it always shows its words.

const MAIN_BUTTONS: { name: string; url: string; says: string; admin?: boolean }[] = [
  { name: 'Docs', url: '/docs', says: 'New doc' },
  { name: 'Meetings', url: '/meetings', says: 'New meeting' },
  { name: 'Voice notes', url: '/dictate/voice', says: 'Record a voice note' },
  { name: 'Clips', url: '/clips', says: 'Record a clip' },
  { name: 'Tasks', url: '/tasks/all', says: 'New task' },
  { name: 'Notes', url: '/notes', says: 'New note' },
  { name: 'Boards', url: '/boards', says: 'New board' },
  { name: 'Files', url: '/files', says: 'Upload' },
  { name: 'Links', url: '/links', says: 'Save a link' },
  { name: 'Forms', url: '/forms', says: 'New form' },
  // Only an admin sets up check-ins.
  { name: 'Check-ins', url: '/checkins', says: 'New check-in', admin: true },
  { name: 'Tables', url: '/tables', says: 'New table' },
  { name: 'Briefcast', url: '/briefcast', says: 'Make today’s briefing' },
]

for (const width of [
  { label: 'computer', viewport: { width: 1280, height: 800 } },
  { label: 'phone', viewport: { width: 390, height: 844 } },
]) {
  test.describe(`the main button, on a ${width.label}`, () => {
    test.use({ viewport: width.viewport, signedIn: false })
    for (const app of MAIN_BUTTONS) {
      test(`${app.name}: "${app.says}" is at the top right`, async ({ page, user }) => {
        await signIn(page, app.admin ? 'e2e-admin@example.test' : user.email)
        await page.goto(app.url)
        const header = page.getByTestId('page-header')
        const button = header.locator('[data-main-button]')
        await expect(button).toHaveCount(1)
        await expect(button).toBeVisible()
        await expect(button).toHaveText(app.says)
        const bar = await header.boundingBox()
        const box = await button.boundingBox()
        if (!bar || !box) throw new Error('no top bar')
        // Nothing sits to its right, and nothing pushes it off the screen.
        const gap = bar.x + bar.width - (box.x + box.width)
        expect(gap).toBeGreaterThanOrEqual(0)
        expect(gap).toBeLessThanOrEqual(24)
        // The title beside it is still there to read.
        const title = await header.getByRole('heading').boundingBox()
        expect(title?.width ?? 0).toBeGreaterThanOrEqual(40)
        // Its words fit on one line.
        expect(box.height).toBeLessThanOrEqual(40)
      })
    }
  })
}

// Requirement 11: on a phone the top bar is the menu (or the way back), the title, the one main
// button with its words, and "More" for everything else. The Ask button covers none of it.

test.describe('a phone’s top bar', () => {
  test.use({ viewport: { width: 390, height: 844 }, signedIn: false })

  /** The controls in the top bar that are not the menu, the way back, the main button or More. */
  const strays = (page: Page) =>
    page
      .getByTestId('page-header')
      .locator('button:visible, a:visible')
      .evaluateAll((nodes) =>
        nodes
          .filter(
            (n) =>
              !n.matches(
                '[data-main-button], [data-testid="page-more"], [data-testid="page-back"], [aria-label="Open sidebar"]',
              ),
          )
          .map((n) => n.getAttribute('data-testid') ?? n.textContent ?? ''),
      )

  for (const app of MAIN_BUTTONS) {
    test(`${app.name}: nothing but the menu, the title, the main button and More`, async ({
      page,
      user,
    }) => {
      await signIn(page, app.admin ? 'e2e-admin@example.test' : user.email)
      await page.goto(app.url)
      const header = page.getByTestId('page-header')
      await expect(header.locator('[data-main-button]')).toBeVisible()
      expect(await strays(page)).toEqual([])
      // The title is not squeezed away.
      const title = await header.getByRole('heading').boundingBox()
      expect(title?.width ?? 0).toBeGreaterThanOrEqual(60)
      // The Ask button sits clear of every control on the page.
      const ask = await page.getByTestId('assistant-open').boundingBox()
      if (!ask) throw new Error('no Ask button')
      const covered = await page
        .locator('main button:visible, main a:visible, main input:visible')
        .evaluateAll(
          (nodes, a) =>
            nodes
              .filter((n) => {
                const r = n.getBoundingClientRect()
                return (
                  r.width > 0 &&
                  r.left < a.x + a.width &&
                  r.right > a.x &&
                  r.top < a.y + a.height &&
                  r.bottom > a.y &&
                  // Only what is on the screen now: a list scrolls under the button.
                  r.bottom <= window.innerHeight
                )
              })
              .map((n) => n.getAttribute('data-testid') ?? n.textContent ?? ''),
          ask,
        )
      expect(covered).toEqual([])
    })
  }

  test('a form: Save keeps its words, Copy link and Open are behind More', async ({
    page,
    user,
  }) => {
    await signIn(page, user.email)
    await page.goto('/forms')
    await newForm(page, `Phone ${uid()}`)
    expect(await strays(page)).toEqual([])
    await expect(page.getByTestId('form-save')).toHaveText(/Save/)
    await page.getByTestId('page-more').click()
    await expect(page.getByRole('menuitem', { name: 'Copy link' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Open the form' })).toHaveAttribute(
      'href',
      /\/f\//,
    )
  })

  test('a doc: its name, Share, and the rest behind More', async ({ page, user }) => {
    await signIn(page, user.email)
    await page.goto('/docs')
    await page.getByTestId('docs-new').click()
    await replaceLine(page, 'Untitled', '# Field notes')
    await expect(page.getByTestId('doc-title')).toHaveText('Field notes')
    const bar = page.locator('header').first()
    await expect(bar.getByTestId('share-menu')).toHaveText('Share')
    await expect(bar.getByTestId('history-toggle')).toHaveCount(0)
    await page.getByTestId('page-more').click()
    for (const name of ['Add to Starred', 'Reading view', 'History', 'Save version'])
      await expect(page.getByRole('menuitem', { name })).toBeVisible()
    await page.getByRole('menuitem', { name: 'Reading view' }).click()
    await expect(page.getByTestId('reading-view')).toBeVisible()
    // More closes on a second press, and Save version opens from it.
    const more = page.getByTestId('page-more')
    await more.click()
    await expect(page.getByRole('menu')).toBeVisible()
    await more.click()
    await expect(page.getByRole('menu')).toHaveCount(0)
    await more.click()
    await page.getByRole('menuitem', { name: 'Save version' }).click()
    await expect(page.getByRole('dialog', { name: 'Save version' })).toBeVisible()
  })

  test('Files: New folder is behind More and still makes a folder', async ({ page, user }) => {
    await signIn(page, user.email)
    await page.goto('/files')
    await page.getByTestId('page-more').click()
    await page.getByRole('menuitem', { name: 'New folder' }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
  })

  test('a board: Share and Delete are behind More, and Ask sits above the board’s tools', async ({
    page,
    user,
  }) => {
    await signIn(page, user.email)
    await page.goto('/boards')
    await page.locator('[data-main-button]').click()
    await expect(page).toHaveURL(/\/boards\/[^/]+\/.+/)
    await expect(page.getByTestId('board-title')).toBeVisible()
    expect(await strays(page)).toEqual([])
    const ask = await page.getByTestId('assistant-open').boundingBox()
    // Clear of the board's own bar along the bottom (undo, redo, its menu).
    expect(844 - ((ask?.y ?? 0) + (ask?.height ?? 0))).toBeGreaterThanOrEqual(130)
    await page.getByTestId('page-more').click()
    for (const name of ['Copy link', 'Copy to paste into a doc', 'Delete board'])
      await expect(page.getByRole('menuitem', { name })).toBeVisible()
  })
})
